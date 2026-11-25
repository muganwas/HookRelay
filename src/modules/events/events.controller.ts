import type { RequestHandler } from 'express';
import { z } from 'zod';
import { UnauthorizedError } from '../../shared/errors.js';
import { createEvent } from './event.service.js';

export const CreateEventBody = z.strictObject({
  type: z.string().min(1).max(120),
  payload: z.unknown().refine((value) => value !== undefined, { message: 'payload is required' }),
});

export type EventsController = { create: RequestHandler };

export function createEventsController(): EventsController {
  return {
    create: (async (req, res) => {
      if (!req.tenantId) throw new UnauthorizedError();

      const body = req.body as z.infer<typeof CreateEventBody>;
      const idempotencyKey = req.header('idempotency-key')?.trim() || null;

      const result = await createEvent({
        tenantId: req.tenantId,
        type: body.type,
        payload: body.payload,
        idempotencyKey,
      });

      // 202 when work was queued, 200 when the idempotency key was already used.
      res.status(result.deduped ? 200 : 202).json(result);
    }) satisfies RequestHandler,
  };
}
