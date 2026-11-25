import { randomUUID } from 'node:crypto';
import type { ActionDefinition, ActionResult } from './labs.types.js';
import { pool } from '../../infra/db.js';
import { cacheStatus } from '../../infra/cache.js';
import {
  getDbComputations,
  invalidateTenantSummary,
  resetDbComputations,
  SUMMARY_TTL_SECONDS,
} from '../tenants/tenant-summary.service.js';
import { DEMO_TENANT, baseUrlFrom, ensureTenant, issueKey } from './labs.helpers.js';

type SummaryCall = {
  status: number;
  source: string;
  ttlSeconds: number;
  ms: number;
  events: number | null;
};

async function callSummary(baseUrl: string, tenantId: string, token: string): Promise<SummaryCall> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/tenants/${tenantId}/summary`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const ms = performance.now() - started;

  let body: { events?: number } = {};
  try {
    body = JSON.parse(text) as { events?: number };
  } catch {
    body = {};
  }

  return {
    status: response.status,
    source: response.headers.get('x-cache') ?? '(none)',
    ttlSeconds: Number(response.headers.get('x-cache-ttl') ?? -1),
    ms,
    events: typeof body.events === 'number' ? body.events : null,
  };
}

async function cacheHitMiss(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  await ensureTenant();
  const token = await issueKey(['tenants:read', 'tenants:write'], 'cache-hitmiss');

  await invalidateTenantSummary(DEMO_TENANT);
  resetDbComputations();

  const cold = await callSummary(baseUrl, DEMO_TENANT, token);
  const warm = await callSummary(baseUrl, DEMO_TENANT, token);
  const third = await callSummary(baseUrl, DEMO_TENANT, token);
  const computations = getDbComputations();

  const speedup = warm.ms > 0 ? cold.ms / warm.ms : 0;
  const cacheLive = warm.source === 'cache';

  return {
    title: cacheLive
      ? `${Math.round(speedup)}× faster on the second read`
      : 'The cache is unreachable — fail-open kept every read working',
    summary: cacheLive
      ? 'Cache-aside: check the cache, miss, compute from Postgres, store with a TTL, return. The next read never touches the database.'
      : 'Every read fell through to Postgres. The cache client swallows connection errors, so the endpoint stayed correct and only latency was lost.',
    table: {
      columns: ['Request', 'x-cache', 'Time (ms)', 'Events count', 'DB computations so far'],
      rows: [
        ['1 (cold)', cold.source, Number(cold.ms.toFixed(1)), cold.events, 1],
        ['2 (warm)', warm.source, Number(warm.ms.toFixed(1)), warm.events, computations],
        ['3 (warm)', third.source, Number(third.ms.toFixed(1)), third.events, computations],
        ['TTL', `${SUMMARY_TTL_SECONDS}s`, '', '', ''],
      ],
    },
    notes: cacheLive
      ? [
          'The summary runs three correlated counts, so the database read is not free — the gap is real, not a Redis benchmark.',
          'Only one computation happened across three requests; the counter is the proof, not the timing.',
          'Cache hit latency is a network round trip plus deserialisation. If that is still too slow, the answer is a local cache, not a faster Redis.',
          'The response says where the data came from (x-cache) so you can debug a stale read in production.',
        ]
      : [
          'This is the fail-open path: `docker compose stop cache`, and reads still return 200 with correct data.',
          'Each read paid for the query. That is the actual cost of the cache, and the number to quote when someone asks what caching buys.',
          'Start it again with `docker compose start cache` to see the hit path.',
        ],
  };
}

async function cacheInvalidate(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  await ensureTenant();
  const token = await issueKey(['tenants:read', 'tenants:write'], 'cache-invalidate');

  await invalidateTenantSummary(DEMO_TENANT);
  resetDbComputations();

  const before = await callSummary(baseUrl, DEMO_TENANT, token);
  const stillWarm = await callSummary(baseUrl, DEMO_TENANT, token);

  const invalidateResponse = await fetch(
    `${baseUrl}/v1/tenants/${DEMO_TENANT}/summary/invalidate`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  );
  const invalidateStatus = invalidateResponse.status;
  await invalidateResponse.text();

  const after = await callSummary(baseUrl, DEMO_TENANT, token);

  return {
    title: 'Invalidation puts the next read back on the database',
    summary:
      'The write path is what makes caching correct. A TTL alone means every reader can be wrong for up to the TTL; delete the key when the source changes.',
    table: {
      columns: ['Step', 'x-cache', 'Time (ms)', 'DB computations so far'],
      rows: [
        ['read (cold)', before.source, Number(before.ms.toFixed(1)), 1],
        ['read (warm)', stillWarm.source, Number(stillWarm.ms.toFixed(1)), getDbComputations()],
        ['POST invalidate', `HTTP ${invalidateStatus}`, '', ''],
        ['read after invalidate', after.source, Number(after.ms.toFixed(1)), getDbComputations()],
      ],
    },
    notes: [
      'TTL is a safety net for missed invalidations, not the invalidation strategy itself.',
      'Invalidate after the transaction commits. Invalidating before means a concurrent reader can repopulate the old value.',
      'Deleting the key is safer than writing the new value: two concurrent writers can store values out of order.',
      'The classic bug is invalidate-then-repopulate racing with a read; short TTLs bound the damage.',
    ],
  };
}

async function cacheStampede(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  await ensureTenant();
  const token = await issueKey(['tenants:read', 'tenants:write'], 'cache-stampede');

  await invalidateTenantSummary(DEMO_TENANT);
  resetDbComputations();

  const concurrency = 12;
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => callSummary(baseUrl, DEMO_TENANT, token)),
  );
  const elapsed = performance.now() - started;

  const bySource = new Map<string, number>();
  for (const result of results) {
    bySource.set(result.source, (bySource.get(result.source) ?? 0) + 1);
  }

  const computations = getDbComputations();
  const cacheUsed = bySource.has('cache') || bySource.has('negative-cache');

  return {
    title: `${concurrency} simultaneous misses caused ${computations} database read(s)`,
    summary:
      'Single-flight collapses concurrent misses onto one promise. Without it, every caller would run the same expensive query at the same instant.',
    table: {
      columns: ['Source', 'Callers'],
      rows: [...bySource.entries()].map(([source, count]) => [source, count]),
    },
    notes: [
      `Wall time for ${concurrency} callers: ${Math.round(elapsed)} ms.`,
      `Database computations: ${computations}. One leader did the work, the rest waited on the same promise.`,
      'This is in-process only. With N replicas you get up to N leaders — use `SET key value NX PX 5000` as a Redis lock, or jitter the TTL.',
      'Jitter matters even with a perfect cache: if 10k keys expire together, they all miss together.',
      ...(cacheUsed
        ? []
        : [
            'No caller reached the cache: it is unreachable, so every wave of arrivals paid for the query again. Correctness survived, latency did not — that is fail-open.',
          ]),
    ],
  };
}

async function cachePenetration(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  await ensureTenant();
  const token = await issueKey(['tenants:read'], 'cache-penetration');

  // A fresh id per run, otherwise the negative entry from the previous run
  // would make the demo return "0 database reads".
  const missingId = randomUUID();
  resetDbComputations();

  const calls: SummaryCall[] = [];
  for (let index = 0; index < 5; index += 1) {
    calls.push(await callSummary(baseUrl, missingId, token));
  }

  return {
    title: `5 requests for a missing tenant caused ${getDbComputations()} database read(s)`,
    summary:
      'Cache penetration: someone requests ids that do not exist. Negative caching stores the "missing" answer briefly so the database is asked once.',
    table: {
      columns: ['Request', 'Status', 'x-cache'],
      rows: calls.map((call, index) => [index + 1, call.status, call.source]),
    },
    notes: [
      `Database computations: ${getDbComputations()} across 5 requests.`,
      'Without a negative entry, an attacker enumerating ids turns your cache into a database load generator.',
      'Keep the negative TTL short (5s here): the id may be created a moment later.',
      'An alternative is a Bloom filter of existing ids in front of the cache, at the cost of false positives.',
    ],
  };
}

async function cacheStaleness(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  await ensureTenant();
  const token = await issueKey(['tenants:read', 'tenants:write'], 'cache-staleness');

  await invalidateTenantSummary(DEMO_TENANT);
  await pool.query(`delete from app.events where type = 'lab.cache' and tenant_id = $1`, [DEMO_TENANT]);

  resetDbComputations();
  const before = await callSummary(baseUrl, DEMO_TENANT, token);

  // A write that does not invalidate the cache.
  await pool.query(
    `insert into app.events (id, tenant_id, type, payload)
     values (gen_random_uuid(), $1, 'lab.cache', '{}'::jsonb)`,
    [DEMO_TENANT],
  );

  const afterWrite = await callSummary(baseUrl, DEMO_TENANT, token);

  await invalidateTenantSummary(DEMO_TENANT);
  const afterInvalidate = await callSummary(baseUrl, DEMO_TENANT, token);

  await pool.query(`delete from app.events where type = 'lab.cache' and tenant_id = $1`, [DEMO_TENANT]);
  await invalidateTenantSummary(DEMO_TENANT);

  return {
    title:
      before.events === afterWrite.events
        ? 'The cached read did not see the new row'
        : 'The cached read already saw the new row',
    summary:
      'A write that nobody tells the cache about leaves readers on stale data until the TTL expires. This is the cost you accept when you cache.',
    table: {
      columns: ['Step', 'x-cache', 'Events count', 'DB computations so far'],
      rows: [
        ['read (cold)', before.source, before.events, 1],
        ['INSERT 1 event', '(write path)', 'not invalidated', ''],
        ['read (cached)', afterWrite.source, afterWrite.events, getDbComputations()],
        ['POST invalidate', '(write path)', 'cache cleared', ''],
        ['read (cold again)', afterInvalidate.source, afterInvalidate.events, getDbComputations()],
      ],
    },
    notes: [
      'Staleness is not a bug in the cache; it is the trade you made for the speedup. The bug is forgetting to invalidate on write.',
      `The TTL of ${SUMMARY_TTL_SECONDS}s bounds how wrong a reader can be if invalidation is missed.`,
      'For a dashboard summary, seconds of staleness are fine. For an account balance, they are not — which is why caching is a per-endpoint decision.',
      'The lab event was removed and the key invalidated afterwards, so the demo is repeatable.',
    ],
  };
}

async function cacheStatusAction(): Promise<ActionResult> {
  const status = await cacheStatus();

  return {
    title: status.reachable ? 'Cache service is reachable' : 'Cache service is unreachable',
    summary:
      'The cache is optional infrastructure: every cache call fails open, so an outage costs latency instead of breaking reads.',
    table: {
      columns: ['Signal', 'Value'],
      rows: [
        ['reachable', status.reachable],
        ['dedicated service (CACHE_URL set)', status.isolated],
        ['keys in the cache database', status.keys],
        ['key prefix', 'hr:cache:'],
        ['fallback when CACHE_URL is unset', 'main Redis, db 1 (still a separate keyspace)'],
      ],
    },
    notes: [
      'In compose the cache is its own Redis container with no volume — a cache must be disposable.',
      'It is deliberately not in the API depends_on list: requiring the cache would turn a latency optimisation into a startup dependency.',
      'Try `docker compose stop cache`, then hit the summary endpoint: it should still answer, just from Postgres.',
      'Queue and log data live in the main Redis (db 0); a cache flush cannot touch them.',
    ],
  };
}

export const cacheActions: ActionDefinition[] = [
  { id: 'cache.hit-miss', label: 'Measure a cache miss vs hit', topicId: 'caching', run: cacheHitMiss },
  {
    id: 'cache.invalidate',
    label: 'Invalidate on write',
    topicId: 'caching',
    run: cacheInvalidate,
  },
  {
    id: 'cache.stampede',
    label: 'Fire 12 concurrent misses',
    topicId: 'caching',
    run: cacheStampede,
  },
  {
    id: 'cache.penetration',
    label: 'Request ids that do not exist',
    topicId: 'caching',
    run: cachePenetration,
  },
  {
    id: 'cache.staleness',
    label: 'Show stale data after a write',
    topicId: 'caching',
    run: cacheStaleness,
  },
  { id: 'cache.status', label: 'Check the cache service', topicId: 'caching', run: cacheStatusAction },
];
