import type { RequestHandler } from 'express';
import { inboundWebhookSecret } from '../../config.js';
import { pool } from '../../infra/db.js';
import { UnauthorizedError, ValidationError } from '../../shared/errors.js';
import type { RawBodyRequest } from '../../shared/request-body.js';
import { verifySignature } from './signature.js';

export type InboundController = { receive: RequestHandler };

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/**
 * A provider-facing receiver. There is no API key here: the HMAC over the raw
 * body is the credential, and the provider event id is the dedupe key.
 */
export function createInboundController(): InboundController {
  return {
    receive: (async (req, res) => {
      const source = param(req.params.source);
      const rawBody = (req as RawBodyRequest).rawBody?.toString('utf8') ?? '';

      const providerEventId = (
        req.header('x-hookrelay-event-id') ?? req.header('x-event-id')
      )?.trim();
      if (!providerEventId) throw new ValidationError('Missing event id header');

      const verdict = verifySignature({
        secret: inboundWebhookSecret,
        header: req.header('x-hookrelay-signature') ?? req.header('x-signature'),
        rawBody,
      });
      if (!verdict.ok) throw new UnauthorizedError(`Invalid signature: ${verdict.reason}`);

      const inserted = await pool.query(
        `insert into app.inbound_events (source, provider_event_id, payload)
         values ($1, $2, $3)
         on conflict (source, provider_event_id) do nothing
         returning id`,
        [source, providerEventId, req.body ?? null],
      );

      const duplicate = (inserted.rowCount ?? 0) === 0;

      res.status(duplicate ? 200 : 202).json({
        received: true,
        duplicate,
        source,
        eventId: providerEventId,
      });
    }) satisfies RequestHandler,
  };
}
