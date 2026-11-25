import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * Parses the body once, at the edge, and replaces it with the parsed value.
 * Downstream code receives typed data and never re-validates.
 */
export function validateBody<T extends z.ZodType>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      return next(
        new ValidationError('Request body failed validation', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
            code: issue.code,
          })),
        }),
      );
    }

    req.body = parsed.data;
    next();
  };
}
