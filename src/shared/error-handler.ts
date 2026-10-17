import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from './errors.js';

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', 404, `Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const isApp = err instanceof AppError;
  const status = isApp ? err.status : 500;

  if (!isApp) console.error({ requestId: req.id }, 'unhandled error', err);

  res.status(status).json({
    error: {
      code: isApp ? err.code : 'INTERNAL',
      message: isApp ? err.message : 'Internal server error',
      details: isApp ? err.details : undefined,
    },
    requestId: req.id,
  });
};