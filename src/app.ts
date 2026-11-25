import express from 'express';
import type { Express } from 'express';
import { requestId } from './shared/request-id.js';
import { requestLogger } from './shared/request-logger.js';
import { errorHandler, notFound } from './shared/error-handler.js';
import { registerMiddleware, resetMiddlewareRegistry } from './shared/middleware-registry.js';
import { pingDb } from './infra/db.js';
import { pingRedis } from './infra/redis.js';
import { createHealthService } from './modules/health/health.service.js';
import { createHealthController } from './modules/health/health.controller.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import { createEchoController } from './modules/echo/echo.controller.js';
import { createEchoRouter } from './modules/echo/echo.routes.js';
import { createEventsController } from './modules/events/events.controller.js';
import { createEventsRouter } from './modules/events/events.routes.js';
import { createDeliveryController } from './modules/deliveries/delivery.controller.js';
import { createDeliveryRouter } from './modules/deliveries/delivery.routes.js';
import { createInboundController } from './modules/webhooks/inbound.controller.js';
import { createInboundRouter } from './modules/webhooks/inbound.routes.js';
import type { RawBodyRequest } from './shared/request-body.js';
import { createLabsController } from './modules/labs/labs.controller.js';
import { createLabsRouter } from './modules/labs/labs.routes.js';

export function createApp(): Express {
  resetMiddlewares();

  const app = express();
  app.disable('x-powered-by');

  app.use(mount('requestId', requestId));
  app.use(mount('requestLogger', requestLogger));
  app.use(
    mount(
      'express.json(1mb, rawBody)',
      express.json({
        limit: '1mb',
        // Capture the untouched bytes before parsing: HMAC verification needs
        // the exact body the sender signed, not a re-serialised object.
        verify: (req, _res, buffer) => {
          (req as RawBodyRequest).rawBody = Buffer.from(buffer);
        },
      }),
    ),
  );

  const healthService = createHealthService({ pingDb, pingRedis });
  const healthController = createHealthController(healthService);
  app.use('/v1/health', createHealthRouter(healthController));
  registerMiddleware('router:/v1/health');

  app.use('/v1/echo', createEchoRouter(createEchoController()));
  registerMiddleware('router:/v1/echo (auth -> rateLimit -> validate)');

  app.use('/v1/events', createEventsRouter(createEventsController()));
  registerMiddleware('router:/v1/events (auth -> rateLimit -> validate)');

  app.use('/v1/deliveries', createDeliveryRouter(createDeliveryController()));
  registerMiddleware('router:/v1/deliveries (auth)');

  app.use('/v1/webhooks/inbound', createInboundRouter(createInboundController()));
  registerMiddleware('router:/v1/webhooks/inbound (signature)');

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