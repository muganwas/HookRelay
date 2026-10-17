import express from 'express';
import type { Express } from 'express';
import { requestId } from './shared/request-id.js';
import { errorHandler, notFound } from './shared/error-handler.js';
import { pingDb } from './infra/db.js';
import { pingRedis } from './infra/redis.js';
import { createHealthService } from './modules/health/health.service.js';
import { createHealthController } from './modules/health/health.controller.js';
import { createHealthRouter } from './modules/health/health.routes.js';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));

  const healthService = createHealthService({ pingDb, pingRedis });
  const healthController = createHealthController(healthService);
  app.use('/v1/health', createHealthRouter(healthController));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}