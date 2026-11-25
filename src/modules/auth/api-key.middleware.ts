import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../../shared/errors.js';
import { verifyApiKey } from './api-key.service.js';

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      apiKeyId?: string;
      apiKeyScopes?: string[];
    }
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
  return token.trim() || undefined;
}

/**
 * Authenticates a tenant from a bearer API key and optionally enforces scopes.
 * Every key is hashed, so a leaked database cannot be replayed against the API.
 */
export function requireApiKey(...requiredScopes: string[]): RequestHandler {
  return async (req, _res, next) => {
    const token = bearerToken(req.header('authorization'));
    if (!token) return next(new UnauthorizedError('Missing bearer token'));

    const key = await verifyApiKey(token);
    if (!key) return next(new UnauthorizedError('Invalid or revoked API key'));

    const missing = requiredScopes.filter((scope) => !key.scopes.includes(scope));
    if (missing.length > 0) {
      return next(new ForbiddenError(`API key is missing scope(s): ${missing.join(', ')}`));
    }

    req.tenantId = key.tenantId;
    req.apiKeyId = key.id;
    req.apiKeyScopes = key.scopes;
    next();
  };
}
