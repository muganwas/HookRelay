import type { RequestHandler } from 'express';
import { redis } from '../infra/redis.js';
import { RateLimitError } from './errors.js';

export type RateLimitOptions = {
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
  /** Distinguishes independent buckets (e.g. per route or per plan). */
  bucket?: string;
};

/**
 * Fixed-window counter in Redis. Cheap and good enough for a per-key limit.
 *
 * The known weakness: a client can burst 2x the limit across a window
 * boundary. A sliding window or a token bucket removes that, at the cost of
 * more Redis work per request.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { limit, windowSeconds, bucket = 'default' } = options;

  return async (req, res, next) => {
    // Per API key, not per tenant: one noisy key must not throttle the others.
    const identity = req.apiKeyId ?? req.ip ?? 'anonymous';
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `rl:${bucket}:${identity}:${window}`;
    const resetAt = (window + 1) * windowSeconds;

    let count: number;
    try {
      count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSeconds);
    } catch {
      // Fail open: a broken limiter must not take the API down.
      return next();
    }

    res.setHeader('ratelimit-limit', String(limit));
    res.setHeader('ratelimit-remaining', String(Math.max(0, limit - count)));
    res.setHeader('ratelimit-reset', String(resetAt));

    if (count > limit) {
      const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));
      res.setHeader('retry-after', String(retryAfter));
      return next(new RateLimitError(`Rate limit of ${limit} per ${windowSeconds}s exceeded`));
    }

    next();
  };
}
