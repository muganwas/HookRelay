import { cacheDel, cacheGet, cacheSet, cacheTtl } from '../../infra/cache.js';
import { pool } from '../../infra/db.js';

export type TenantSummary = {
  tenantId: string;
  name: string;
  endpoints: number;
  events: number;
  deliveries: number;
  computedAt: string;
};

export type SummarySource = 'cache' | 'db' | 'coalesced' | 'negative-cache';

export type SummaryResult = {
  summary: TenantSummary | null;
  source: SummarySource;
  ttlSeconds: number;
};

export const SUMMARY_TTL_SECONDS = 30;
export const NEGATIVE_TTL_SECONDS = 5;
const MISSING = { __missing: true } as const;

// Instrumentation for the labs: proves how many times the database was touched.
let dbComputations = 0;
export function resetDbComputations(): void {
  dbComputations = 0;
}
export function getDbComputations(): number {
  return dbComputations;
}

function cacheKey(tenantId: string): string {
  return `tenant-summary:${tenantId}`;
}

async function computeSummary(tenantId: string): Promise<TenantSummary | null> {
  dbComputations += 1;

  const result = await pool.query<{
    tenant_id: string;
    name: string;
    endpoints: number;
    events: number;
    deliveries: number;
  }>(
    `select t.id::text as tenant_id,
            t.name,
            (select count(*)::int from app.endpoints e where e.tenant_id = t.id) as endpoints,
            (select count(*)::int from app.events e where e.tenant_id = t.id) as events,
            (select count(*)::int from app.deliveries d
              join app.events e2 on e2.id = d.event_id
              where e2.tenant_id = t.id) as deliveries
     from app.tenants t
     where t.id = $1`,
    [tenantId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    tenantId: row.tenant_id,
    name: row.name,
    endpoints: row.endpoints,
    events: row.events,
    deliveries: row.deliveries,
    computedAt: new Date().toISOString(),
  };
}

/**
 * In-process single flight. Concurrent misses for the same key share one
 * database read; the waiters are told they were coalesced.
 *
 * This does not help across replicas — that needs a Redis lock (`SET NX PX`)
 * or a short random jitter on the TTL.
 */
const inFlight = new Map<string, Promise<TenantSummary | null>>();

export async function getTenantSummary(tenantId: string): Promise<SummaryResult> {
  const key = cacheKey(tenantId);

  const cached = await cacheGet<TenantSummary | typeof MISSING>(key);
  if (cached) {
    const ttlSeconds = await cacheTtl(key);
    if ((cached as typeof MISSING).__missing) {
      return { summary: null, source: 'negative-cache', ttlSeconds };
    }
    return { summary: cached as TenantSummary, source: 'cache', ttlSeconds };
  }

  let pending = inFlight.get(key);
  const leader = pending === undefined;

  if (!pending) {
    pending = computeSummary(tenantId)
      .then(async (summary) => {
        // Negative caching stops a missing id from hammering the database.
        await cacheSet(key, summary ?? MISSING, summary ? SUMMARY_TTL_SECONDS : NEGATIVE_TTL_SECONDS);
        return summary;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, pending);
  }

  const summary = await pending;

  return {
    summary,
    source: leader ? 'db' : 'coalesced',
    ttlSeconds: summary ? SUMMARY_TTL_SECONDS : NEGATIVE_TTL_SECONDS,
  };
}

export async function invalidateTenantSummary(tenantId: string): Promise<boolean> {
  return cacheDel(cacheKey(tenantId));
}
