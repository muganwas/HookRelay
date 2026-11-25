import { pool } from '../../infra/db.js';

export type DeliveryRecord = {
  id: string;
  status: string;
  attemptsCount: number;
  nextAttemptAt: Date | null;
  event: { id: string; type: string; payload: unknown; createdAt: Date };
  endpoint: { id: string; url: string; secret: string };
};

export type DeliveryView = {
  id: string;
  status: string;
  attempts: number;
  eventId: string;
  eventType: string;
  endpointUrl: string;
  lastResponseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type AttemptView = {
  attemptNo: number;
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
};

export type AttemptOutcome = {
  deliveryId: string;
  endpointId: string;
  attemptNo: number;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
  error: string | null;
  outcome: 'succeeded' | 'retrying' | 'dead';
  nextAttemptAt: Date | null;
};

export async function loadForDelivery(deliveryId: string): Promise<DeliveryRecord | null> {
  const result = await pool.query<{
    id: string;
    status: string;
    attempt_count: number;
    next_attempt_at: Date | null;
    event_id: string;
    event_type: string;
    event_payload: unknown;
    event_created_at: Date;
    endpoint_id: string;
    endpoint_url: string;
    endpoint_secret: string;
  }>(
    `select d.id::text as id, d.status, d.attempt_count, d.next_attempt_at,
            e.id::text as event_id, e.type as event_type, e.payload as event_payload,
            e.created_at as event_created_at,
            ep.id::text as endpoint_id, ep.url as endpoint_url, ep.secret as endpoint_secret
     from app.deliveries d
     join app.events e on e.id = d.event_id
     join app.endpoints ep on ep.id = d.endpoint_id
     where d.id = $1`,
    [deliveryId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    attemptsCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    event: {
      id: row.event_id,
      type: row.event_type,
      payload: row.event_payload,
      createdAt: row.event_created_at,
    },
    endpoint: { id: row.endpoint_id, url: row.endpoint_url, secret: row.endpoint_secret },
  };
}

export async function recordAttempt(outcome: AttemptOutcome): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('begin');

    await client.query(
      `insert into app.delivery_attempts
         (delivery_id, attempt_no, response_status, response_body, duration_ms, error)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (delivery_id, attempt_no) do nothing`,
      [
        outcome.deliveryId,
        outcome.attemptNo,
        outcome.responseStatus,
        outcome.responseBody?.slice(0, 1000) ?? null,
        outcome.durationMs,
        outcome.error,
      ],
    );

    await client.query(
      `update app.deliveries
          set status = $2,
              attempt_count = greatest(attempt_count, $3),
              last_response_status = $4,
              last_error = $5,
              next_attempt_at = $6,
              finished_at = case when $2 in ('succeeded', 'dead') then now() else null end
        where id = $1`,
      [
        outcome.deliveryId,
        outcome.outcome,
        outcome.attemptNo,
        outcome.responseStatus,
        outcome.error,
        outcome.nextAttemptAt,
      ],
    );

    await client.query(
      `update app.endpoints
          set consecutive_failures = case when $2 = 'succeeded' then 0 else consecutive_failures + 1 end,
              updated_at = now()
        where id = $1`,
      [outcome.endpointId, outcome.outcome],
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function getDeliveryView(deliveryId: string): Promise<DeliveryView | null> {
  const result = await pool.query<{
    id: string;
    status: string;
    attempt_count: number;
    last_response_status: number | null;
    last_error: string | null;
    next_attempt_at: Date | null;
    finished_at: Date | null;
    created_at: Date;
    event_id: string;
    event_type: string;
    endpoint_url: string;
  }>(
    `select d.id::text as id, d.status, d.attempt_count, d.last_response_status, d.last_error,
            d.next_attempt_at, d.finished_at, d.created_at,
            e.id::text as event_id, e.type as event_type, ep.url as endpoint_url
     from app.deliveries d
     join app.events e on e.id = d.event_id
     join app.endpoints ep on ep.id = d.endpoint_id
     where d.id = $1`,
    [deliveryId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    attempts: row.attempt_count,
    eventId: row.event_id,
    eventType: row.event_type,
    endpointUrl: row.endpoint_url,
    lastResponseStatus: row.last_response_status,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at ? row.next_attempt_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listAttempts(deliveryId: string): Promise<AttemptView[]> {
  const result = await pool.query<{
    attempt_no: number;
    response_status: number | null;
    duration_ms: number | null;
    error: string | null;
    created_at: Date;
  }>(
    `select attempt_no, response_status, duration_ms, error, created_at
     from app.delivery_attempts
     where delivery_id = $1
     order by attempt_no`,
    [deliveryId],
  );

  return result.rows.map((row) => ({
    attemptNo: row.attempt_no,
    responseStatus: row.response_status,
    durationMs: row.duration_ms,
    error: row.error,
    createdAt: row.created_at.toISOString(),
  }));
}

export function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'dead' || status === 'cancelled';
}
