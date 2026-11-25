import { pool } from '../../infra/db.js';
import { enqueueDelivery } from '../deliveries/delivery.job.js';

export type CreateEventInput = {
  tenantId: string;
  type: string;
  payload: unknown;
  idempotencyKey?: string | null;
};

export type CreateEventResult = {
  eventId: string;
  deliveryIds: string[];
  deduped: boolean;
  endpointsMatched: number;
};

/**
 * Insert the event, fan out to subscribed endpoints and enqueue each delivery
 * inside one transaction. Jobs are enqueued only after commit, so a worker can
 * never pick up a delivery whose event was rolled back.
 */
export async function createEvent(input: CreateEventInput): Promise<CreateEventResult> {
  const client = await pool.connect();
  let eventId = '';
  let deduped = false;
  let endpointsMatched = 0;
  const deliveryIds: string[] = [];

  try {
    await client.query('begin');

    const inserted = await client.query<{ id: string }>(
      `insert into app.events (id, tenant_id, type, payload, idempotency_key)
       values (gen_random_uuid(), $1, $2, $3, $4)
       on conflict (tenant_id, idempotency_key) do nothing
       returning id::text as id`,
      [input.tenantId, input.type, input.payload, input.idempotencyKey ?? null],
    );

    const created = inserted.rows[0];

    if (created) {
      eventId = created.id;

      const endpoints = await client.query<{ id: string }>(
        `select id::text as id
         from app.endpoints
         where tenant_id = $1 and status = 'active' and $2 = any(subscribed_events)`,
        [input.tenantId, input.type],
      );
      endpointsMatched = endpoints.rows.length;

      for (const endpoint of endpoints.rows) {
        const delivery = await client.query<{ id: string }>(
          `insert into app.deliveries (id, event_id, endpoint_id, status, next_attempt_at)
           values (gen_random_uuid(), $1, $2, 'pending', now())
           on conflict (event_id, endpoint_id) do nothing
           returning id::text as id`,
          [eventId, endpoint.id],
        );
        const deliveryId = delivery.rows[0]?.id;
        if (deliveryId) deliveryIds.push(deliveryId);
      }
    } else {
      deduped = true;
      const existing = await client.query<{ id: string }>(
        `select id::text as id from app.events where tenant_id = $1 and idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey ?? null],
      );
      eventId = existing.rows[0]?.id ?? '';
    }

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  for (const deliveryId of deliveryIds) {
    await enqueueDelivery({ deliveryId });
  }

  return { eventId, deliveryIds, deduped, endpointsMatched };
}
