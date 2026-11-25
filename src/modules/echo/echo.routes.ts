import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../auth/api-key.middleware.js';
import { rateLimit } from '../../shared/rate-limit.js';
import { validateBody } from '../../shared/validation.js';
import type { EchoController } from './echo.controller.js';

export const EchoBody = z.strictObject({
  message: z.string().min(1).max(200),
  count: z.number().int().min(1).max(100).optional(),
});

export const ECHO_RATE_LIMIT = { limit: 5, windowSeconds: 60 } as const;

export function createEchoRouter(controller: EchoController): Router {
  const router = Router();

  router.post(
    '/',
    // Order is behaviour: authenticate first so the limiter can key on the
    // API key, then limit, then validate. Invalid requests still consume
    // budget, which is what stops a validation-flood.
    requireApiKey('echo:write'),
    rateLimit({ ...ECHO_RATE_LIMIT, bucket: 'echo' }),
    validateBody(EchoBody),
    controller.post,
  );

  return router;
}
