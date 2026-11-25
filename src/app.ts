import express from 'express';
import type { Express } from 'express';
import { requestId } from './shared/request-id.js';
import { errorHandler, notFound } from './shared/error-handler.js';
import { registerMiddleware, resetMiddlewareRegistry } from './shared/middleware-registry.js';
import { pingDb } from './infra/db.js';
import { pingRedis } from './infra/redis.js';
import { createHealthService } from './modules/health/health.service.js';
import { createHealthController } from './modules/health/health.controller.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import { createLabsController } from './modules/labs/labs.controller.js';
import { createLabsRouter } from './modules/labs/labs.routes.js';

export function createApp(): Express {
  resetMiddlewares();

  const app = express();
  app.disable('x-powered-by');

  app.use(mount('requestId', requestId));
  app.use(mount('express.json(1mb)', express.json({ limit: '1mb' })));

  const healthService = createHealthService({ pingDb, pingRedis });
  const healthController = createHealthController(healthService);
  app.use('/v1/health', createHealthRouter(healthController));
  registerMiddleware('router:/v1/health');

  app.use('/labs', createLabsRouter(createLabsController()));
  registerMiddleware('router:/labs');

  app.use(mount('notFound', notFound));
  app.use(mount('errorHandler(4 args)', errorHandler));

  return app;
}

function resetMiddlewares(): void {
  resetMiddlewareRegistry();
}

function mount<T>(name: string, handler: T): T {
  registerMiddleware(name);
  return handler;
}