import type { RequestHandler } from 'express';
import { logger } from '../infra/logger.js';
import { appendLog } from '../infra/log-stream.js';

/**
 * Logs once the response has finished, so the status code is known.
 * `res.on('finish')` is EventEmitter: this middleware is a listener, not a
 * polling loop.
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  // originalUrl, not path: inside a mounted router req.path is relative to the
  // mount point (the health router would log "/" instead of "/v1/health").
  const method = req.method;
  const path = req.originalUrl;

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const status = res.statusCode;
    const fields = {
      requestId: req.id,
      method,
      path,
      status,
      durationMs: Number(durationMs.toFixed(1)),
    };

    logger.info(fields, 'request.completed');

    // Fire-and-forget: a log sink must never fail a request.
    void appendLog({ level: status >= 500 ? 'error' : 'info', msg: 'request.completed', ...fields }).catch(
      () => undefined,
    );
  });

  next();
};
