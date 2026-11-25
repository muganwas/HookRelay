import { Redis } from 'ioredis';
import type { ActionDefinition, ActionResult } from './labs.types.js';
import { selfBaseUrl } from '../../config.js';
import { pool, type PoolClient } from '../../infra/db.js';
import { redis } from '../../infra/redis.js';
import { streamLength } from '../../infra/log-stream.js';
import { getDeliveryQueue } from '../deliveries/delivery.job.js';
import { getDeliveryView, isTerminal, listAttempts } from '../deliveries/delivery.service.js';
import { createEvent } from '../events/event.service.js';
import {
  DEMO_TENANT,
  ensureEndpoint,
  ensureTenant,
  issueKey,
  mapConcurrent,
  percentile,
  sleep,
} from './labs.helpers.js';

const LOAD_TOTAL = 200;
const LOAD_CONCURRENCY = 20;

async function waitForTerminal(deliveryId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let view = await getDeliveryView(deliveryId);
  while (view && !isTerminal(view.status) && Date.now() < deadline) {
    await sleep(200);
    view = await getDeliveryView(deliveryId);
  }
  return view;
}

async function capstoneLoad(): Promise<ActionResult> {
  await ensureTenant();
  await ensureEndpoint(`${selfBaseUrl}/labs/api/targets/200?lab=load`, 'whsec_load_lab', ['lab.load']);
  const key = await issueKey(['events:write'], 'capstone-load');
  const runId = Date.now();
  const url = `${selfBaseUrl}/v1/events`;

  const latencies: number[] = [];
  const statuses = new Map<number, number>();

  const startedAt = performance.now();
  await mapConcurrent(
    Array.from({ length: LOAD_TOTAL }, (_, index) => index),
    LOAD_CONCURRENCY,
    async (index) => {
      const callStarted = performance.now();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          'idempotency-key': `load-${runId}-${index}`,
        },
        body: JSON.stringify({ type: 'lab.load', payload: { index } }),
      });
      await response.text();
      latencies.push(performance.now() - callStarted);
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    },
  );
  const elapsedMs = performance.now() - startedAt;

  const sorted = [...latencies].sort((a, b) => a - b);
  const ok = statuses.get(202) ?? 0;

  // Let queued deliveries finish before deleting their events, otherwise the
  // worker is left holding jobs for rows that no longer exist.
  await sleep(1500);
  await pool.query(`delete from app.events where type = 'lab.load' and tenant_id = $1`, [DEMO_TENANT]);

  return {
    title: `${LOAD_TOTAL} requests in ${Math.round(elapsedMs)} ms — ${Math.round((LOAD_TOTAL / elapsedMs) * 1000)} req/s`,
    summary:
      'Every request went through auth, rate limiting, validation, a transaction with fan-out, and a Redis enqueue.',
    table: {
      columns: ['Metric', 'Value'],
      rows: [
        ['requests', LOAD_TOTAL],
        ['concurrency', LOAD_CONCURRENCY],
        ['accepted (202)', ok],
        ['rejected', LOAD_TOTAL - ok],
        ['wall time (ms)', Math.round(elapsedMs)],
        ['throughput (req/s)', Math.round((LOAD_TOTAL / elapsedMs) * 1000)],
        ['p50 (ms)', Number(percentile(sorted, 50).toFixed(1))],
        ['p95 (ms)', Number(percentile(sorted, 95).toFixed(1))],
        ['p99 (ms)', Number(percentile(sorted, 99).toFixed(1))],
        ['max (ms)', Number((sorted.at(-1) ?? 0).toFixed(1))],
        ['statuses', [...statuses.entries()].map(([code, count]) => `${code}×${count}`).join(', ')],
      ],
    },
    notes: [
      'The same Node process is both client and server here, so these numbers are a shape, not a benchmark.',
      'p99 is the number to quote: it is the one users feel and the one an SLO is written against.',
      'Fan-out is included: each event also created a delivery row and a BullMQ job.',
      'Lab events were deleted afterwards, which cascaded their deliveries.',
      'The limiter allows 60 events per minute per key — 200 requests from one key would normally 429 at that rate.',
    ],
  };
}

async function capstonePool(): Promise<ActionResult> {
  const max = (pool as unknown as { options?: { max?: number } }).options?.max ?? 10;
  const held: PoolClient[] = [];
  let waiterReleased = false;

  const releaseWaiter = (client: PoolClient): void => {
    if (waiterReleased) return;
    waiterReleased = true;
    client.release();
  };

  const startedAt = Date.now();

  try {
    for (let index = 0; index < max; index += 1) held.push(await pool.connect());

    const saturated = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };

    const waiter = pool.connect();
    waiter.then(releaseWaiter).catch(() => undefined);

    await sleep(120);
    const waitingWhileHeld = pool.waitingCount;

    const blocked = await Promise.race([
      waiter.then(() => 'acquired' as const),
      sleep(600).then(() => 'blocked' as const),
    ]);

    const freedInMs = Date.now() - startedAt;
    held.pop()?.release();

    const afterRelease = await Promise.race([
      waiter.then(() => 'acquired' as const),
      sleep(1500).then(() => 'still blocked' as const),
    ]);

    return {
      title: `Pool max ${max}: the ${max + 1}th caller waited`,
      summary:
        'A connection pool is a queue with a hard ceiling. When every slot is checked out, new work waits — including health checks.',
      table: {
        columns: ['Observation', 'Value'],
        rows: [
          ['pool.max', max],
          ['clients checked out', held.length + (waiterReleased ? 1 : 0)],
          ['pool.totalCount', saturated.total],
          ['pool.idleCount', saturated.idle],
          ['pool.waitingCount while saturated', waitingWhileHeld],
          [`${max + 1}th pool.connect()`, blocked === 'blocked' ? 'blocked (no slot free)' : 'acquired early'],
          ['after releasing one client', afterRelease],
          ['elapsed (ms)', freedInMs],
        ],
      },
      notes: [
        'With N replicas each running max=10, the database sees N×10 connections. Postgres has its own max_connections ceiling.',
        'This is why /v1/health borrowing from the main pool is dangerous: under saturation it hangs, Docker marks the container unhealthy, and the orchestrator restarts it — making things worse.',
        'A separate small pool (or a direct query with its own timeout) is the usual fix for health checks.',
        'Every client here is released in a finally block; a leaked client is a permanent outage.',
      ],
    };
  } finally {
    for (const client of held.splice(0)) client.release();
    // The pending waiter releases itself through releaseWaiter() when a slot frees.
  }
}

async function capstoneRedisDown(): Promise<ActionResult> {
  const startedAt = Date.now();
  const probe = new Redis('redis://127.0.0.1:6390', {
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  let failure = '';
  try {
    await probe.connect();
    await probe.ping();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    probe.disconnect();
  }
  const failedInMs = Date.now() - startedAt;

  const live = await redis.ping().catch(() => 'unreachable');

  return {
    title: failure ? `Dead Redis failed fast in ${failedInMs} ms` : 'The probe unexpectedly connected',
    summary:
      'Redis is not one dependency: different features degrade differently, and only one of them takes the API down.',
    table: {
      columns: ['Feature', 'Needs Redis', 'Behaviour when Redis is unreachable'],
      rows: [
        ['GET /v1/deliveries/:id', 'no', 'unaffected — Postgres only'],
        ['POST /v1/events', 'yes', 'fails: the event is committed but cannot be queued'],
        ['rate limiter', 'yes', 'fails OPEN — the request proceeds unthrottled'],
        ['request log stream', 'yes', 'fire-and-forget — the request still succeeds'],
        ['worker', 'yes', 'stops consuming; jobs resume when Redis returns'],
        ['cron schedulers', 'yes', 'missed windows; the claim table prevents double work later'],
      ],
    },
    notes: [
      `Probe error: ${failure || '(none)'}`,
      `The real Redis answered ${live}.`,
      'Fail-open is a deliberate trade: a broken limiter must not become an outage.',
      'The dangerous case is enqueue: the transaction already committed, so "return 500" leaves an event with no delivery. That is exactly what the transactional-outbox pattern exists to fix.',
      'Retry with jitter on reconnect, or every pod stampedes the recovering Redis at the same instant.',
    ],
  };
}

async function capstoneSlowReceiver(): Promise<ActionResult> {
  await ensureTenant();
  const slowUrl = `${selfBaseUrl}/labs/api/targets/slow?ms=2500&lab=slow`;
  await ensureEndpoint(slowUrl, 'whsec_slow_lab', ['lab.slow']);

  const enqueueStarted = performance.now();
  const created = await createEvent({
    tenantId: DEMO_TENANT,
    type: 'lab.slow',
    payload: { note: 'receiver takes 2.5s' },
    idempotencyKey: `slow-${Date.now()}`,
  });
  const enqueueMs = performance.now() - enqueueStarted;

  const deliveryId = created.deliveryIds[0];
  if (!deliveryId) {
    return {
      title: 'No delivery was created',
      summary: 'The slow endpoint is not subscribed to lab.slow.',
      notes: ['Check app.endpoints.subscribed_events contains "lab.slow".'],
    };
  }

  const view = await waitForTerminal(deliveryId, 20_000);
  const attempts = await listAttempts(deliveryId);

  return {
    title: `API answered in ${Math.round(enqueueMs)} ms while delivery took ${attempts[0]?.durationMs ?? '?'} ms`,
    summary:
      'A slow receiver cannot slow the API down, because the API only writes a row and enqueues a job. The waiting happens in the worker.',
    table: {
      columns: ['Stage', 'Duration / result'],
      rows: [
        ['POST /v1/events (enqueue)', `${Math.round(enqueueMs)} ms`],
        ['attempt 1 duration', `${attempts[0]?.durationMs ?? '?'} ms`],
        ['attempt 1 status', attempts[0]?.responseStatus ?? '—'],
        ['delivery status', view?.status ?? 'unknown'],
        ['attempt count', attempts.length],
      ],
    },
    notes: [
      'The ratio is the whole point: the request path is decoupled from the receiver by the queue.',
      'With worker concurrency 5, ten slow deliveries take about two rounds, not ten — bounded parallelism.',
      'A 10s timeout in the worker caps how long one slow receiver can hold a slot.',
      'Without a queue, this 2.5s would have been the HTTP response time, and one slow receiver would exhaust the server.',
    ],
  };
}

async function capstoneReadout(): Promise<ActionResult> {
  const queue = getDeliveryQueue();
  const [counts, workers, deliveryCounts, attempts, sizes, stream, redisOk] = await Promise.all([
    queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    queue.getWorkers().catch(() => []),
    pool.query<{ status: string; n: number }>(
      `select status, count(*)::int as n from app.deliveries group by status order by status`,
    ),
    pool.query<{ n: number; avg: number }>(
      `select count(*)::int as n, coalesce(round(avg(duration_ms)), 0)::int as avg from app.delivery_attempts`,
    ),
    pool.query<{ relname: string; size: string }>(
      `select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) as size
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and c.relkind = 'r'
       order by pg_total_relation_size(c.oid) desc limit 6`,
    ),
    streamLength(),
    redis.ping().then(() => true).catch(() => false),
  ]);

  const deliverySummary = deliveryCounts.rows.map((row) => `${row.status}: ${row.n}`).join(', ');
  const pending = Number(deliveryCounts.rows.find((row) => row.status === 'pending')?.n ?? 0);
  const queueWaiting = counts.waiting ?? 0;

  const notes: string[] = [];

  if (pending > 0 && queueWaiting === 0) {
    notes.push(
      `${pending} delivery(ies) are pending with nothing in the queue — those are stuck, not busy. This is the enqueue-after-commit gap: the row committed, the job never queued.`,
    );
  }

  notes.push(
    'Workers connected = 0 means nothing will be delivered, no matter how healthy the API looks.',
    'Queue waiting climbing while active is flat means the workers cannot keep up.',
    'Deliveries stuck in retrying with attempts not increasing usually means the worker is down, not the receiver.',
    'Table size that grows faster than row count is bloat — check autovacuum before blaming the disk.',
  );

  return {
    title: 'Live system readout',
    summary:
      'Everything an on-call engineer would look at first: queue depth, worker liveness, delivery states and table sizes.',
    table: {
      columns: ['Signal', 'Value'],
      rows: [
        ['workers connected', workers.length],
        ['queue waiting', queueWaiting],
        ['queue active', counts.active ?? 0],
        ['queue delayed', counts.delayed ?? 0],
        ['queue failed (includes dead)', counts.failed ?? 0],
        ['deliveries by status', deliverySummary || '(none)'],
        ['attempts recorded', attempts.rows[0]?.n ?? 0],
        ['avg attempt duration (ms)', attempts.rows[0]?.avg ?? 0],
        ['log stream length', stream],
        ['redis reachable', redisOk],
        ['pg pool total / idle / waiting', `${pool.totalCount} / ${pool.idleCount} / ${pool.waitingCount}`],
        ['largest app tables', sizes.rows.map((row) => `${row.relname} ${row.size}`).join(', ')],
      ],
    },
    notes,
  };
}

export const capstoneActions: ActionDefinition[] = [
  {
    id: 'capstone.load',
    label: 'Load test the ingest path',
    topicId: 'capstone',
    heavy: true,
    run: capstoneLoad,
  },
  {
    id: 'capstone.pool',
    label: 'Saturate the connection pool',
    topicId: 'capstone',
    heavy: true,
    run: capstonePool,
  },
  {
    id: 'capstone.redis-down',
    label: 'Probe a dead Redis',
    topicId: 'capstone',
    run: capstoneRedisDown,
  },
  {
    id: 'capstone.slow-receiver',
    label: 'Deliver to a slow receiver',
    topicId: 'capstone',
    heavy: true,
    run: capstoneSlowReceiver,
  },
  { id: 'capstone.readout', label: 'Live system readout', topicId: 'capstone', run: capstoneReadout },
];
