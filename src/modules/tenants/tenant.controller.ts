import type { RequestHandler } from 'express';
import { NotFoundError } from '../../shared/errors.js';
import { getTenantSummary, invalidateTenantSummary } from './tenant-summary.service.js';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export type TenantController = {
  summary: RequestHandler;
  invalidate: RequestHandler;
};

export function createTenantController(): TenantController {
  return {
    summary: (async (req, res) => {
      const tenantId = param(req.params.id);
      const result = await getTenantSummary(tenantId);

      // Set the cache headers before the 404 so a negative hit is observable.
      res.setHeader('x-cache', result.source);
      res.setHeader('x-cache-ttl', String(result.ttlSeconds));

      if (!result.summary) throw new NotFoundError(`Tenant ${tenantId} not found`);

      res.json({ ...result.summary, source: result.source, ttlSeconds: result.ttlSeconds });
    }) satisfies RequestHandler,

    invalidate: (async (req, res) => {
      const tenantId = param(req.params.id);
      const cleared = await invalidateTenantSummary(tenantId);
      res.status(cleared ? 202 : 200).json({ tenantId, invalidated: cleared });
    }) satisfies RequestHandler,
  };
}
