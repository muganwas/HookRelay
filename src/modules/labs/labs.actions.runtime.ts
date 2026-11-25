import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { Queue } from 'bullmq';
import type { ActionDefinition, ActionResult } from './labs.types.js';
import { pool } from '../../infra/db.js';
import { config } from '../../config.js';
import { createRedisConnection } from '../../infra/queue.js';
import { enqueueDelivery, getDeliveryQueue } from '../deliveries/delivery.job.js';
import { getOpsQueue } from '../ops/ops.job.js';

const LAB_TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const LAB_ENDPOINT = 'aaaaaaaa-0000-4000-8000-000000000002';
const LAB_EVENT_TYPE = 'lab.seed';
const SWEEP_INDEX = 'deliveries_sweep_lab';

const SWEEP_QUERY = `select id from app.deliveries
where status = 'retrying' and next_attempt_at <= now()
order by next_attempt_at
limit 100`;

const JOIN_QUERY = `select d.id, e.type
from app.deliveries d
join app.events e on e.id = d.event_id
where d.status = 'retrying'
order by d.next_attempt_at
limit 50`;

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function baseUrlFrom(input: unknown): string {
  const value = inputRecord(input).baseUrl;
  return typeof value === 'string' ? value : `http://127.0.0.1:${config.PORT}`;
}

async function queueSummary(): Promise<{ counts: Record<string, number>; workers: number }> {
  const queue = getDeliveryQueue();
  const counts = await queue.getJobCounts(
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed',
  );
  let workers = 0;
  try {
    workers = (await queue.getWorkers()).length;
  } catch {
    workers = 0;
  }
  return { counts: counts as Record<string, number>, workers };
}

async function enqueueScenario(
  scenario: 'ok' | 'retry' | 'dead',
  url: string,
  expectation: string,
): Promise<ActionResult> {
  const deliveryId = `lab-${scenario}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = await enqueueDelivery({ deliveryId, url, payload: { lab: true, scenario } });
  const { counts, workers } = await queueSummary();

  return {
    title: `Job ${job.id} queued`,
    summary: expectation,
    table: {
      columns: ['State', 'Count'],
      rows: Object.entries(counts).map(([state, count]) => [state, count]),
    },
    notes: [
      `jobId = deliveryId = ${job.id}`,
      workers === 0
        ? 'No worker connected: the job will sit in waiting. Start it with `npm run worker` in another terminal.'
        : `${workers} worker(s) connected — watch the worker terminal for attempt logs.`,
      scenario === 'dead'
        ? 'This throws UnrecoverableError, so it should go dead on attempt 1 regardless of attempts=5.'
        : 'Backoff is exponential from 1s: 1s, 2s, 4s, 8s.',
    ],
  };
}

async function queuesDedupe(): Promise<ActionResult> {
  const connection = createRedisConnection();
  const queue = new Queue('lab-dedupe', { connection });

  try {
    await queue.obliterate({ force: true });

    const first = await queue.add('probe', { attempt: 'first', n: 1 }, { jobId: 'lab-dedupe-fixed' });
    const afterFirst = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    const second = await queue.add('probe', { attempt: 'second', n: 2 }, { jobId: 'lab-dedupe-fixed' });
    const afterSecond = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');

    const stored = await queue.getJob('lab-dedupe-fixed');
    const storedData = stored?.data as { attempt?: string } | undefined;
    const waitingFirst = Number(afterFirst.waiting ?? 0);
    const waitingSecond = Number(afterSecond.waiting ?? 0);

    return {
      title: waitingSecond === waitingFirst ? 'Second add was ignored' : 'Second add created a job',
      summary:
        'This queue has no worker, so jobs stay in waiting — which makes the count deterministic instead of racing.',
      table: {
        columns: ['Step', 'Returned jobId', 'Waiting count'],
        rows: [
          ['first add', first.id ?? '', waitingFirst],
          ['second add (same jobId)', second.id ?? '', waitingSecond],
        ],
      },
      notes: [
        `Stored payload is "${storedData?.attempt ?? 'missing'}": the second add did not overwrite the first.`,
        'BullMQ dedupes on jobId, so a retried API call cannot create a duplicate delivery.',
        'What it does NOT prevent: the same work arriving under a different jobId.',
      ],
    };
  } finally {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    connection.disconnect();
  }
}

async function queuesSnapshot(): Promise<ActionResult> {
  const { counts, workers } = await queueSummary();
  const schedulers = await getOpsQueue().getJobSchedulers();

  const recent = await getDeliveryQueue().getJobs(['completed', 'failed'], 0, 4, false);

  return {
    title: `${workers} worker(s) connected`,
    summary: 'Job counts by state. Failed does not mean dead — check attemptsMade against attempts.',
    table: {
      columns: ['State', 'Count'],
      rows: Object.entries(counts).map(([state, count]) => [state, count]),
    },
    notes: [
      workers === 0 ? 'Start the worker: `npm run worker`' : 'Worker is draining jobs.',
      ...recent.map(
        (job) => `recent ${job.id}: attempts=${job.attemptsMade} of ${job.opts.attempts ?? 1}`,
      ),
      `${schedulers.length} job scheduler(s) registered in Redis.`,
    ],
    raw: { counts, workers, schedulers },
  };
}

async function cronClaimRace(): Promise<ActionResult> {
  const jobName = `lab-claim-${Date.now()}`;
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);

  const replicaA = await pool.connect();
  const replicaB = await pool.connect();

  try {
    const claim = (client: typeof replicaA) =>
      client.query<{ id: string }>(
        `insert into ops.job_runs (job_name, window_start)
         values ($1, $2)
         on conflict (job_name, window_start) do nothing
         returning id`,
        [jobName, windowStart],
      );

    const [a, b] = await Promise.all([claim(replicaA), claim(replicaB)]);

    const total = await pool.query<{ n: number }>(
      `select count(*)::int as n from ops.job_runs where job_name = $1`,
      [jobName],
    );

    await pool.query(`delete from ops.job_runs where job_name = $1`, [jobName]);

    const aWon = a.rowCount === 1;
    const bWon = b.rowCount === 1;

    return {
      title: aWon && bWon ? 'Both replicas claimed (bug)' : 'Exactly one replica claimed the window',
      summary:
        'Both connections issued the same insert at the same time. The unique constraint decided the winner.',
      table: {
        columns: ['Replica', 'Claimed?', 'Returned rows', 'Meaning'],
        rows: [
          ['A', aWon, a.rowCount, aWon ? 'owns this window, does the work' : 'lost the race, skips'],
          ['B', bWon, b.rowCount, bWon ? 'owns this window, does the work' : 'lost the race, skips'],
        ],
      },
      notes: [
        `Rows in the table for this window: ${total.rows[0]?.n ?? 0} (cleaned up after the probe).`,
        'Claim BEFORE doing the work. Work-then-record means both replicas work and one fails at the end.',
        'The losing insert blocks until the winner commits, then returns zero rows.',
      ],
    };
  } finally {
    replicaA.release();
    replicaB.release();
  }
}

async function cronSchedulers(): Promise<ActionResult> {
  const schedulers = await getOpsQueue().getJobSchedulers();

  return {
    title: `${schedulers.length} scheduler(s) in Redis`,
    summary:
      'Schedulers live in Redis, not in code. Every replica can call upsert at boot without duplicating.',
    table: {
      columns: ['Id', 'Pattern', 'Every (ms)', 'Next run', 'Timezone'],
      rows: schedulers.map((s) => [
        s.id ?? '(none)',
        s.pattern ?? '(interval)',
        s.every ?? '',
        s.next ? new Date(s.next).toISOString() : '',
        s.tz ?? 'UTC',
      ]),
    },
    notes: [
      'Patterns are six-field cron (seconds first): 0 0 6 * * * is 06:00 daily.',
      'No schedulers listed? Start the worker once — it registers them at boot.',
    ],
    raw: schedulers,
  };
}

async function ensureSeed(targetRows: number): Promise<{ events: number; created: number }> {
  await pool.query(
    `insert into app.tenants (id, name) values ($1, 'Lab Seeder') on conflict (id) do nothing`,
    [LAB_TENANT],
  );
  await pool.query(
    `insert into app.endpoints (id, tenant_id, url, secret)
     values ($1, $2, 'https://lab-seed.test/hooks', 'whsec_seed')
     on conflict (id) do nothing`,
    [LAB_ENDPOINT, LAB_TENANT],
  );

  const existing = await pool.query<{ count: number }>(
    `select count(*)::int as count from app.events where type = $1 and tenant_id = $2`,
    [LAB_EVENT_TYPE, LAB_TENANT],
  );
  const current = existing.rows[0]?.count ?? 0;
  if (current >= targetRows) return { events: current, created: 0 };

  const missing = targetRows - current;

  await pool.query(
    `insert into app.events (id, tenant_id, type, payload)
     select gen_random_uuid(), $1, $2, '{}'::jsonb
     from generate_series(1, $3)`,
    [LAB_TENANT, LAB_EVENT_TYPE, missing],
  );

  await pool.query(
    `with candidates as materialized (
       select id, random() as r
       from app.events e
       where e.type = $2 and e.tenant_id = $3
         and not exists (select 1 from app.deliveries d where d.event_id = e.id)
     )
     insert into app.deliveries (id, event_id, endpoint_id, status, next_attempt_at)
     select gen_random_uuid(), c.id, $1,
            case when c.r < 0.9 then 'succeeded' else 'retrying' end,
            case when c.r < 0.9 then null
                 else now() - (c.r * 86400) * interval '1 second' end
     from candidates c`,
    [LAB_ENDPOINT, LAB_EVENT_TYPE, LAB_TENANT],
  );

  return { events: targetRows, created: missing };
}

async function indexesSeed(input: unknown): Promise<ActionResult> {
  const requested = Number(inputRecord(input).rows ?? 100_000);
  const rows = Math.min(300_000, Math.max(1_000, Number.isFinite(requested) ? requested : 100_000));

  const started = Date.now();
  const result = await ensureSeed(rows);
  const elapsed = Date.now() - started;

  const counts = await pool.query<{ deliveries: number; lab_events: number }>(
    `select
       (select count(*)::int from app.deliveries where endpoint_id = $1) as deliveries,
       (select count(*)::int from app.events where type = $2 and tenant_id = $3) as lab_events`,
    [LAB_ENDPOINT, LAB_EVENT_TYPE, LAB_TENANT],
  );

  const row = counts.rows[0];

  return {
    title: `${result.events.toLocaleString()} lab events, ${row?.deliveries ?? 0} deliveries`,
    summary:
      'Rows are tagged type=lab.seed so cleanup is exact. 90% succeeded / 10% retrying gives the partial index something to skip.',
    table: {
      columns: ['Metric', 'Value'],
      rows: [
        ['Rows requested', rows],
        ['Events created this run', result.created],
        ['Total lab events', result.events],
        ['Total lab deliveries', row?.deliveries ?? 0],
        ['Elapsed (ms)', elapsed],
      ],
    },
    notes: [
      'Seeding is idempotent: existing lab events are reused, and only events without a delivery get one.',
      'Run "Measure before vs after" next — it drops the lab index first so the contrast is real.',
    ],
  };
}

async function explainText(query: string): Promise<string[]> {
  const result = await pool.query(`explain (analyze, buffers) ${query}`);
  return result.rows.map((row) => String((row as Record<string, unknown>)['QUERY PLAN']));
}

function summarizePlan(lines: string[]): { top: string; scan: string; execution: string } {
  const top = (lines[0] ?? '').split('  (cost=')[0]?.trim() ?? '';
  const scanLine =
    lines.find((line) =>
      /(Seq Scan|Index Only Scan|Index Scan|Bitmap Heap Scan|Bitmap Index Scan)/.test(line),
    ) ?? '';
  const scan = scanLine.split('  (cost=')[0]?.trim() ?? '';
  const execution = lines.find((line) => line.startsWith('Execution Time:')) ?? 'Execution Time: ?';
  return { top, scan, execution };
}

async function indexesBeforeAfter(input: unknown): Promise<ActionResult> {
  const requested = Number(inputRecord(input).rows ?? 100_000);
  const target = Math.min(300_000, Math.max(10_000, Number.isFinite(requested) ? requested : 100_000));

  await ensureSeed(target);

  const seeded = await pool.query<{ n: number }>(
    `select count(*)::int as n from app.deliveries where endpoint_id = $1`,
    [LAB_ENDPOINT],
  );

  await pool.query(`drop index if exists app.${SWEEP_INDEX}`);

  const beforeLines = await explainText(SWEEP_QUERY);
  const before = summarizePlan(beforeLines);

  const createStarted = Date.now();
  await pool.query(
    `create index ${SWEEP_INDEX} on app.deliveries (next_attempt_at)
     where status in ('pending', 'retrying')`,
  );
  const createMs = Date.now() - createStarted;

  const afterLines = await explainText(SWEEP_QUERY);
  const after = summarizePlan(afterLines);

  const changed = before.scan !== after.scan;

  const afterLower = after.scan.toLowerCase();
  const scanNote = afterLower.includes('bitmap')
    ? 'A bitmap heap scan is still index-driven: Postgres collects matching row locations from the index, then reads the heap in physical order. It wins when selectivity is moderate rather than tiny.'
    : afterLower.includes('index only')
      ? 'An index-only scan never touches the heap. Check "Heap Fetches" to confirm the visibility map is doing its job.'
      : 'An index scan walks the index in sorted order, which also removes the sort step for this query.';

  return {
    title: changed ? 'The plan changed' : 'The plan did not change',
    summary: `${seeded.rows[0]?.n ?? 0} deliveries in the lab set. Same query, one index, two plans.`,
    table: {
      columns: ['Phase', 'Scan node', 'Top node', 'Execution time', 'Index build'],
      rows: [
        ['before index', before.scan || before.top, before.top, before.execution.replace('Execution Time: ', ''), '—'],
        ['after index', after.scan || after.top, after.top, after.execution.replace('Execution Time: ', ''), `${createMs} ms`],
      ],
    },
    sql: SWEEP_QUERY,
    notes: [
      scanNote,
      'A partial index only contains rows matching the predicate, so it is smaller and more likely to stay in cache.',
      'The index is left in place afterwards — it is the index the worker actually needs.',
      'If both plans look identical, the table is too small: seed more rows.',
    ],
    raw: { before: beforeLines, after: afterLines },
  };
}

async function indexesCleanup(): Promise<ActionResult> {
  const before = await pool.query<{ n: number }>(
    `select count(*)::int as n from app.deliveries where endpoint_id = $1`,
    [LAB_ENDPOINT],
  );

  const started = Date.now();
  await pool.query(`delete from app.events where type = $1 and tenant_id = $2`, [
    LAB_EVENT_TYPE,
    LAB_TENANT,
  ]);
  const cascadeMs = Date.now() - started;

  await pool.query(`delete from app.endpoints where id = $1`, [LAB_ENDPOINT]);
  await pool.query(`delete from app.tenants where id = $1`, [LAB_TENANT]);

  const after = await pool.query<{ n: number }>(
    `select count(*)::int as n from app.deliveries where endpoint_id = $1`,
    [LAB_ENDPOINT],
  );

  return {
    title: `${before.rows[0]?.n ?? 0} deliveries deleted by cascade`,
    summary:
      'One DELETE on app.events removed the deliveries too, because of ON DELETE CASCADE. That is exactly why a 10M-row cascade is dangerous.',
    table: {
      columns: ['Metric', 'Value'],
      rows: [
        ['Deliveries before', before.rows[0]?.n ?? 0],
        ['Deliveries after', after.rows[0]?.n ?? 0],
        ['Cascade duration (ms)', cascadeMs],
      ],
    },
    notes: [
      'In one transaction, in one go. At 10M rows this locks, floods the WAL, and leaves bloat behind.',
      'The fix is batching with LIMIT + SKIP LOCKED, or partitioning and dropping the partition.',
    ],
  };
}

async function plansStats(): Promise<ActionResult> {
  const stats = await pool.query<{
    relname: string;
    seq_scan: string;
    idx_scan: string | null;
    n_live_tup: string;
    last_analyze: Date | null;
  }>(
    `select relname, seq_scan, idx_scan, n_live_tup, last_analyze
     from pg_stat_user_tables
     where schemaname = 'app'
     order by seq_scan desc`,
  );

  const indexes = await pool.query<{ indexrelname: string; idx_scan: string }>(
    `select indexrelname, idx_scan from pg_stat_user_indexes
     where schemaname = 'app' order by idx_scan asc limit 8`,
  );

  return {
    title: 'Where the tables stand',
    summary:
      'seq_scan climbing on a large table is the signal to look at a plan. idx_scan = 0 means an index is dead weight.',
    table: {
      columns: ['Table', 'seq_scan', 'idx_scan', 'live rows', 'last ANALYZE'],
      rows: stats.rows.map((r) => [
        r.relname,
        r.seq_scan,
        r.idx_scan ?? 0,
        r.n_live_tup,
        r.last_analyze ? r.last_analyze.toISOString() : '(never)',
      ]),
    },
    notes: [
      `Least-used indexes: ${indexes.rows.map((r) => `${r.indexrelname}=${r.idx_scan}`).join(', ')}`,
      'These counters reset on restart and are per-database. Treat them as trends, not absolutes.',
    ],
  };
}

type JsonPlanNode = {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Plan Rows'?: number;
  'Actual Rows'?: number;
  'Actual Total Time'?: number;
  Plans?: JsonPlanNode[];
};

function flattenPlan(
  node: JsonPlanNode,
  depth = 0,
): Array<Array<string | number | null>> {
  const estimate = node['Plan Rows'] ?? 0;
  const actual = node['Actual Rows'] ?? 0;
  const ratio = estimate === 0 ? null : Number((actual / estimate).toFixed(2));

  const rows: Array<Array<string | number | null>> = [
    [
      `${'  '.repeat(depth)}${node['Node Type'] ?? '?'}`,
      node['Relation Name'] ?? '',
      estimate,
      actual,
      ratio,
      node['Actual Total Time'] !== undefined ? Number(node['Actual Total Time'].toFixed(3)) : null,
    ],
  ];

  for (const child of node.Plans ?? []) rows.push(...flattenPlan(child, depth + 1));
  return rows;
}

async function plansExplain(): Promise<ActionResult> {
  const seeded = await pool.query<{ n: number }>(
    `select count(*)::int as n from app.deliveries`,
  );

  const result = await pool.query(`explain (analyze, buffers, format json) ${JOIN_QUERY}`);
  const raw = (result.rows[0] as Record<string, unknown>)['QUERY PLAN'];

  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const plan = (first as { Plan?: JsonPlanNode }).Plan ?? ({} as JsonPlanNode);
  const executionTime = (first as { 'Execution Time'?: number })['Execution Time'] ?? 0;

  const rows = flattenPlan(plan);
  const worst = rows.reduce<{ ratio: number; node: string }>(
    (acc, row) => {
      const ratio = Number(row[4] ?? 0);
      return ratio > acc.ratio ? { ratio, node: String(row[0]).trim() } : acc;
    },
    { ratio: 0, node: 'none' },
  );

  return {
    title: `${executionTime.toFixed(2)} ms over ${seeded.rows[0]?.n ?? 0} deliveries`,
    summary:
      'Estimated vs actual rows is the field that reveals stale statistics. A ratio far from 1 means the planner guessed.',
    table: {
      columns: ['Node', 'Relation', 'Est. rows', 'Actual rows', 'Actual/Est.', 'Total time (ms)'],
      rows,
    },
    sql: JOIN_QUERY,
    notes: [
      worst.ratio > 2 || (worst.ratio > 0 && worst.ratio < 0.5)
        ? `Worst estimate error: ${worst.node} at ${worst.ratio}× — run ANALYZE on that table.`
        : 'Estimates look close to reality for these nodes.',
      'If this shows a Seq Scan on app.deliveries, run the indexes demo first to see the contrast.',
    ],
    raw: first,
  };
}

function signWith(secret: string, timestamp: number, body: string): string {  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function verify(secret: string, timestamp: number, body: string, signature: string): boolean {
  const expected = Buffer.from(signWith(secret, timestamp, body), 'hex');
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return expected.length === received.length && timingSafeEqual(expected, received);
}

async function webhooksHmac(): Promise<ActionResult> {
  const secret = 'whsec_lab_demo_123';
  const body = JSON.stringify({ id: 'evt_lab_1', type: 'order.created', amount: 4999 });
  const now = Math.floor(Date.now() / 1000);
  const signature = signWith(secret, now, body);

  const MAX_SKEW_SECONDS = 300;
  const fresh = (timestamp: number) => Math.abs(now - timestamp) <= MAX_SKEW_SECONDS;
  const accept = (timestamp: number, payload: string, sig: string, key = secret) =>
    fresh(timestamp) && verify(key, timestamp, payload, sig);

  const stale = now - 400;

  const rows: Array<Array<string | number | boolean | null>> = [
    ['genuine', accept(now, body, signature), 'HMAC matches and the timestamp is fresh'],
    [
      'tampered body',
      accept(now, body.replace('order.created', 'order.deleted'), signature),
      'body changed after signing, so the HMAC no longer matches',
    ],
    [
      'stale timestamp (t-400s)',
      accept(stale, body, signWith(secret, stale, body)),
      'the HMAC is valid, but the timestamp is outside the 300s window',
    ],
    [
      'wrong secret',
      accept(now, body, signWith('whsec_other', now, body)),
      'a different secret produces a different HMAC',
    ],
    [
      'future timestamp (t+400s)',
      accept(now + 400, body, signWith(secret, now + 400, body)),
      'clock-skew guard must be symmetric, or a future timestamp lives forever',
    ],
  ];

  return {
    title: 'HMAC over timestamp + body',
    summary:
      'Signature validity and freshness are two separate checks. A receiver must pass both — the row above shows a case where the HMAC is fine and the request is still rejected.',
    table: {
      columns: ['Case', 'Accepted', 'Why'],
      rows,
    },
    sql: `hmac_sha256(secret, \`\${t}.\${body}\`)`,
    notes: [
      `Signed string begins: ${`${now}.`}${body.slice(0, 40)}…`,
      'Signature format sent on the wire: `t=<unix>,v1=<hex>`.',
      'Verify with timingSafeEqual, never with ===: string comparison leaks position information.',
    ],
  };
}

type RawResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

/**
 * Uses node:http rather than fetch on purpose. Undici (Node's fetch) injects
 * `cache-control: no-cache` when a request carries If-None-Match, which makes a
 * correct server answer 200 instead of 304 — it defeats the thing being tested.
 */
function rawGet(url: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'GET', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function pollingEtag(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  const target = `${baseUrl}/labs/api/topics`;

  const first = await rawGet(target);
  const etagValue = Array.isArray(first.headers.etag) ? first.headers.etag[0] : first.headers.etag;
  const etag = etagValue ?? null;

  const second = await rawGet(target, etag ? { 'if-none-match': etag } : {});

  return {
    title: `First ${first.status}, second ${second.status}`,
    summary:
      'The second request was conditional. A 304 carries no body, so bandwidth scales with changes rather than with polls.',
    table: {
      columns: ['Request', 'Status', 'ETag sent', 'Body bytes'],
      rows: [
        ['plain GET', first.status, '(none)', first.body.length],
        [`If-None-Match: ${etag ?? '(no etag)'}`, second.status, etag ?? '', second.body.length],
      ],
    },
    notes: [
      'Node\u2019s fetch adds `cache-control: no-cache` whenever you send If-None-Match, so a correct server answers 200. That is why this demo uses node:http instead.',
      'Express generates a weak ETag for JSON responses automatically — no code required.',
      'A volatile field in the body (a timestamp) changes the ETag every request and makes caching impossible.',
      '304 still costs a round trip: if latency is the problem you need long-poll or push, not caching.',
    ],
  };
}

export const runtimeActions: ActionDefinition[] = [
  {
    id: 'queues.enqueue-ok',
    label: 'Enqueue a healthy delivery',
    topicId: 'queues',
    requires: ['redis', 'postgres'],
    run: () => enqueueScenario('ok', 'https://ok.test/hooks', 'Expect success on attempt 1.'),
  },
  {
    id: 'queues.enqueue-500',
    label: 'Enqueue a retryable failure',
    topicId: 'queues',
    requires: ['redis', 'worker'],
    run: () =>
      enqueueScenario(
        'retry',
        'https://fail-500.test/hooks',
        'Expect 5 attempts with doubling delays, then dead.',
      ),
  },
  {
    id: 'queues.enqueue-400',
    label: 'Enqueue an unrecoverable 4xx',
    topicId: 'queues',
    requires: ['redis', 'worker'],
    run: () =>
      enqueueScenario(
        'dead',
        'https://fail-400.test/hooks',
        'Expect dead on attempt 1: UnrecoverableError stops retrying.',
      ),
  },
  { id: 'queues.dedupe', label: 'Prove jobId dedupe', topicId: 'queues', run: queuesDedupe },
  { id: 'queues.snapshot', label: 'Snapshot queue state', topicId: 'queues', run: queuesSnapshot },
  { id: 'cron.claim-race', label: 'Race two replicas', topicId: 'cron', run: cronClaimRace },
  { id: 'cron.schedulers', label: 'List schedulers', topicId: 'cron', run: cronSchedulers },
  {
    id: 'indexes.seed',
    label: 'Seed lab rows',
    topicId: 'indexes',
    heavy: true,
    run: indexesSeed,
  },
  {
    id: 'indexes.before-after',
    label: 'Measure before vs after',
    topicId: 'indexes',
    heavy: true,
    run: indexesBeforeAfter,
  },
  { id: 'indexes.cleanup', label: 'Delete lab rows', topicId: 'indexes', run: indexesCleanup },
  { id: 'plans.stats', label: 'Table statistics', topicId: 'query-plans', run: plansStats },
  { id: 'plans.explain', label: 'Explain the hot join', topicId: 'query-plans', run: plansExplain },
  { id: 'webhooks.hmac', label: 'Sign, tamper, replay', topicId: 'webhooks', run: webhooksHmac },
  { id: 'polling.etag', label: 'Round-trip 200 then 304', topicId: 'polling', run: pollingEtag },
];
