import { Router } from 'express';
import { requireApiKey } from '../auth/api-key.middleware.js';
import type { DeliveryController } from './delivery.controller.js';

export function createDeliveryRouter(controller: DeliveryController): Router {
  const router = Router();

  router.get('/:id', requireApiKey('deliveries:read'), controller.get);
  router.get('/:id/attempts', requireApiKey('deliveries:read'), controller.attempts);

  return router;
}
