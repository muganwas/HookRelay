import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.header('x-request-id');
  req.id = inbound && inbound.length <= 128 ? inbound : randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
};