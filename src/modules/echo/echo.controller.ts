import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { RawBodyRequest } from '../../shared/request-body.js';

export type EchoController = {
  post: RequestHandler;
};

/**
 * Scratch endpoint used by the middleware labs. It exists to make the chain
 * observable: who you are, what was parsed, and what the raw bytes were.
 */
export function createEchoController(): EchoController {
  return {
    post: (async (req, res) => {
      const raw = (req as RawBodyRequest).rawBody;

      res.json({
        tenantId: req.tenantId,
        apiKeyId: req.apiKeyId,
        scopes: req.apiKeyScopes,
        requestId: req.id,
        received: req.body,
        rawBodyBytes: raw?.length ?? 0,
        rawBodySha256: raw ? createHash('sha256').update(raw).digest('hex') : null,
      });
    }) satisfies RequestHandler,
  };
}
