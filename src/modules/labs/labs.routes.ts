import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import type { LabsController } from './labs.controller.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../../public/labs', import.meta.url));

export function createLabsRouter(controller: LabsController): Router {
  const router = Router();

  router.get('/api/topics', controller.listTopics);
  router.get('/api/glossary', controller.listGlossary);
  router.post('/api/actions/:actionId', controller.runAction);
  router.get('/api/probe/error', controller.probeError);

  // Deterministic HTTP targets so the queue and webhook demos exercise real
  // network calls instead of mocking the processor.
  router.all('/api/targets/slow', async (req, res) => {
    const requested = Number(req.query.ms ?? 1000);
    const delay = Math.min(5000, Math.max(0, Number.isFinite(requested) ? requested : 1000));
    await new Promise((resolve) => setTimeout(resolve, delay));
    res.json({ target: 'lab-slow', delayedMs: delay, ok: true });
  });

  router.all('/api/targets/:code', (req, res) => {
    const requested = Number(req.params.code);
    const allowed = new Set([200, 201, 400, 401, 404, 429, 500, 503]);
    const status = allowed.has(requested) ? requested : 400;

    res.status(status).json({
      target: 'lab',
      code: status,
      ok: status < 400,
      method: req.method,
      receivedAt: new Date().toISOString(),
    });
  });

  // Serve the shell directly; express.static would 301 /labs -> /labs/.
  router.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  router.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

  return router;
}
