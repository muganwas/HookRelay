import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * The cache is optional infrastructure: if it is unreachable every operation
 * fails open, so a cache outage degrades latency instead of breaking reads.
 *
 * Isolation: when CACHE_URL is set (compose does this) the cache is a separate
 * Redis service. When it is not, we fall back to the main Redis on db 1, which
 * is still a separate keyspace from the queue (db 0) and the log stream.
 */
const KEY_PREFIX = 'hr:cache:';

let client: Redis | null = null;

function getClient(): Redis {
  if (client) return client;

  const url = config.CACHE_URL ?? config.REDIS_URL;
  const options = {
    // When CACHE_URL is unset we share the main Redis, so move to db 1.
    ...(config.CACHE_URL ? {} : { db: 1 }),
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    // A cache must never stall a request: bound every command, so a blip costs
    // at most one timeout before the read falls through to Postgres.
    commandTimeout: 300,
    // The cache is disposable — the labs stop the container on purpose — so a
    // blip must not disable caching until the process restarts. Back off, then
    // give up only after a long run of failures.
    retryStrategy: (times: number) => (times > 30 ? null : Math.min(times * 200, 2000)),
  };

  client = new Redis(url, options);
  // Never let a cache connection error crash the process.
  client.on('error', () => undefined);
  return client;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getClient().get(KEY_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
  try {
    await getClient().set(KEY_PREFIX + key, JSON.stringify(value), 'EX', ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

export async function cacheDel(key: string): Promise<boolean> {
  try {
    await getClient().del(KEY_PREFIX + key);
    return true;
  } catch {
    return false;
  }
}

export async function cacheTtl(key: string): Promise<number> {
  try {
    return await getClient().ttl(KEY_PREFIX + key);
  } catch {
    return -2;
  }
}

export type CacheStatus = {
  reachable: boolean;
  isolated: boolean;
  keys: number;
};

export async function cacheStatus(): Promise<CacheStatus> {
  try {
    const redis = getClient();
    const keys = await redis.dbsize();
    return { reachable: true, isolated: Boolean(config.CACHE_URL), keys };
  } catch {
    return { reachable: false, isolated: Boolean(config.CACHE_URL), keys: 0 };
  }
}

/** `disconnect()` rather than `quit()`: quit waits for a reply that never comes if the cache is down. */
export function closeCache(): void {
  client?.disconnect();
  client = null;
}
