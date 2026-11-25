import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import type { LabsController } from './labs.controller.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../../public/labs', import.meta.url));

export function createLabsRouter(controller: LabsController): Router {
  const router = Router();

  router.get('/api/topics', controller.listTopics);
  router.post('/api/actions/:actionId', controller.runAction);
  router.get('/api/probe/error', controller.probeError);

  // Serve the shell directly; express.static would 301 /labs -> /labs/.
  router.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  router.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

  return router;
}
