import { Router } from 'express';
import type { InboundController } from './inbound.controller.js';

export function createInboundRouter(controller: InboundController): Router {
  const router = Router();

  // No requireApiKey: the signature is the authentication.
  router.post('/:source', controller.receive);

  return router;
}
