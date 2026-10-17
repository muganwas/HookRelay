import type { RequestHandler } from 'express';
import type { HealthService } from './health.service.js';

export function createHealthController(service: HealthService) {
  return {
    get: (async (_req, res) => {
      const report = await service.check();
      res.status(report.status === 'ok' ? 200 : 503).json(report);
    }) satisfies RequestHandler,
  };
}

export type HealthController = ReturnType<typeof createHealthController>;