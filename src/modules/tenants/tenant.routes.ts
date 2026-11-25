import { Router } from 'express';
import { requireApiKey } from '../auth/api-key.middleware.js';
import type { TenantController } from './tenant.controller.js';

export function createTenantRouter(controller: TenantController): Router {
  const router = Router();

  router.get('/:id/summary', requireApiKey('tenants:read'), controller.summary);
  router.post('/:id/summary/invalidate', requireApiKey('tenants:write'), controller.invalidate);

  return router;
}
