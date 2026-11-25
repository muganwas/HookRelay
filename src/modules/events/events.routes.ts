import { Router } from 'express';
import { requireApiKey } from '../auth/api-key.middleware.js';
import { rateLimit } from '../../shared/rate-limit.js';
import { validateBody } from '../../shared/validation.js';
import { CreateEventBody, type EventsController } from './events.controller.js';

export function createEventsRouter(controller: EventsController): Router {
  const router = Router();

  router.post(
    '/',
    requireApiKey('events:write'),
    // Ingest gets a larger budget than the scratch echo route: different
    // endpoints deserve different limits.
    rateLimit({ limit: 600, windowSeconds: 60, bucket: 'events' }),
    validateBody(CreateEventBody),
    controller.create,
  );

  return router;
}
