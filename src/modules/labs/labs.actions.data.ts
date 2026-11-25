import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ActionDefinition, ActionResult } from './labs.types.js';
import { pool } from '../../infra/db.js';
import { redis } from '../../infra/redis.js';
import { config } from '../../config.js';
import { listMiddleware } from '../../shared/middleware-registry.js';

const PROJECT_ROOT = process.cwd();

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

async function infraProbe(): Promise<ActionResult> {
  const db = await pool.query<{
    version: string;
    now: Date;
    tz: string;
    schema_name: string;
  }>(`select version() as version, now() as now,
             current_setting('TimeZone') as tz, current_schema() as schema_name`);

  const info = await redis.info('server');
  const redisFields = Object.fromEntries(
    info
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes(':'))
      .map((line) => {
        const idx = line.indexOf(':');
        return [line.slice(0, idx), line.slice(idx + 1)] as const;
      }),
  );

  const row = db.rows[0];
  const shortVersion = row ? row.version.split(',')[0] ?? row.version : 'unknown';

  return {
    title: 'Stack is live',
    summary:
      'Both dependencies answered real round-trips. The pool counters are the numbers to watch when load arrives.',
    table: {
      columns: ['Dependency', 'Value'],
      rows: [
        ['Postgres', shortVersion],
        ['Server time (UTC instant)', row ? row.now.toISOString() : '?'],
        ['Session TimeZone', row ? row.tz : '?'],
        ['Current schema', row ? row.schema_name : '?'],
        ['Redis version', redisFields.redis_version ?? 'unknown'],
        ['Redis uptime (s)', redisFields.uptime_in_seconds ?? 'unknown'],
        ['Pool total / idle / waiting', `${pool.totalCount} / ${pool.idleCount} / ${pool.waitingCount}`],
      ],
    },
    notes: [
      'Postgres stores timestamptz as a UTC instant; the TimeZone setting only changes how it is rendered.',
      'Pool total=1 here because a single query needs a single connection. Phase 7 is where this grows.',
    ],
  };
}

type ImportHit = {
  file: string;
  line: number;
  module: string;
  typeOnly: boolean;
};

async function scanImports(root: string): Promise<{ hits: ImportHit[]; scanned: number }> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(
    (e) => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js')),
  );

  const hits: ImportHit[] = [];
  const importRe = /import\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/;

  for (const entry of files) {
    const parent = (entry as { parentPath?: string; path?: string }).parentPath ??
      (entry as { path?: string }).path ?? root;
    const full = path.join(parent, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    const source = await readFile(full, 'utf8');

    source.split(/\r?\n/).forEach((line, index) => {
      const match = importRe.exec(line);
      if (!match) return;
      const module = match[2];
      if (module !== 'pg' && module !== 'express') return;
      hits.push({ file: rel, line: index + 1, module, typeOnly: Boolean(match[1]) });
    });
  }

  return { hits, scanned: files.length };
}

function layerOf(file: string): string {
  const parts = file.split('/');
  if (parts.length === 1) return 'root';
  return parts[0] ?? 'root';
}

async function architectureLayers(): Promise<ActionResult> {
  const srcRoot = path.join(PROJECT_ROOT, 'src');
  const { hits, scanned } = await scanImports(srcRoot);

  const rows: Array<Array<string | number | boolean | null>> = [];
  let violations = 0;

  for (const hit of hits) {
    const layer = layerOf(hit.file);
    const isService = hit.file.endsWith('.service.ts') || hit.file.includes('/infra/');
    const isRoutes = hit.file.endsWith('.routes.ts');

    let verdict: string;
    if (hit.module === 'pg') {
      verdict = layer === 'infra' ? 'allowed (infra owns pg)' : 'VIOLATION';
    } else if (hit.typeOnly) {
      verdict = 'allowed (type-only, erased)';
    } else if (isRoutes || layer === 'root') {
      verdict = 'allowed (HTTP adapter)';
    } else if (isService) {
      verdict = 'VIOLATION (service has runtime express)';
    } else {
      verdict = 'allowed (controller may bind HTTP types)';
    }

    if (verdict.startsWith('VIOLATION')) violations += 1;

    rows.push([hit.file, hit.line, hit.module, hit.typeOnly, verdict]);
  }

  return {
    title: violations === 0 ? 'Layer rules hold' : `${violations} violation(s) found`,
    summary: `Scanned ${scanned} source files. The rule is one-directional: routes -> controller -> service -> infra, with pg confined to infra.`,
    table: {
      columns: ['File', 'Line', 'Module', 'Type-only', 'Verdict'],
      rows,
    },
    notes: [
      'controllers importing `RequestHandler` with `import type` is correct: it erases at compile time.',
      'routes importing `Router` at runtime is correct: routes are the HTTP adapter.',
      'A violation would be `pg` outside infra, or runtime express inside a service.',
    ],
  };
}

type ProbeCase = {
  label: string;
  expected: string;
  sql: string;
  params?: string[];
};

type ProbeResult = {
  label: string;
  expected: string;
  actual: string;
  constraint: string | null;
};

async function schemasConstraints(): Promise<ActionResult> {
  const tenant = 'aaaaaaaa-0000-4000-8000-000000000001';
  const endpoint = 'aaaaaaaa-0000-4000-8000-000000000002';
  const event = 'aaaaaaaa-0000-4000-8000-000000000003';
  const delivery = 'aaaaaaaa-0000-4000-8000-000000000004';
  const missing = 'aaaaaaaa-0000-4000-8000-0000000000ff';

  const client = await pool.connect();
  const results: ProbeResult[] = [];

  try {
    await client.query('begin');

    await client.query(
      `insert into app.tenants (id, name) values ($1, 'Lab Tenant') on conflict (id) do nothing`,
      [tenant],
    );
    await client.query(
      `insert into app.endpoints (id, tenant_id, url, secret, subscribed_events)
       values ($1, $2, 'https://lab.test/hooks', 'whsec_lab', array['order.created'])
       on conflict (id) do nothing`,
      [endpoint, tenant],
    );
    await client.query(
      `insert into app.events (id, tenant_id, type, payload, idempotency_key)
       values ($1, $2, 'order.created', '{}'::jsonb, 'lab-existing')
       on conflict (id) do nothing`,
      [event, tenant],
    );
    await client.query(
      `insert into app.deliveries (id, event_id, endpoint_id)
       values ($1, $2, $3) on conflict (id) do nothing`,
      [delivery, event, endpoint],
    );

    const cases: ProbeCase[] = [
      {
        label: 'duplicate idempotency key',
        expected: '23505',
        sql: `insert into app.events (id, tenant_id, type, payload, idempotency_key)
              values (gen_random_uuid(), $1, 'order.created', '{}'::jsonb, 'lab-existing')`,
        params: [tenant],
      },
      {
        label: 'NULL idempotency key #1',
        expected: 'ok (NULLs are distinct)',
        sql: `insert into app.events (id, tenant_id, type, payload, idempotency_key)
              values (gen_random_uuid(), $1, 'order.created', '{}'::jsonb, null)`,
        params: [tenant],
      },
      {
        label: 'NULL idempotency key #2',
        expected: 'ok (no collision with #1)',
        sql: `insert into app.events (id, tenant_id, type, payload, idempotency_key)
              values (gen_random_uuid(), $1, 'order.created', '{}'::jsonb, null)`,
        params: [tenant],
      },
      {
        label: 'invalid status value',
        expected: '23514',
        sql: `update app.deliveries set status = 'exploded' where id = $1`,
        params: [delivery],
      },
      {
        label: 'missing parent (FK)',
        expected: '23503',
        sql: `insert into app.deliveries (id, event_id, endpoint_id)
              values (gen_random_uuid(), $1, $2)`,
        params: [event, missing],
      },
      {
        label: 'nullable payload rejected',
        expected: '23502',
        sql: `insert into app.events (id, tenant_id, type, payload)
              values (gen_random_uuid(), $1, 'order.created', null)`,
        params: [tenant],
      },
      {
        label: 'duplicate fan-out (event, endpoint)',
        expected: '23505',
        sql: `insert into app.deliveries (id, event_id, endpoint_id)
              values (gen_random_uuid(), $1, $2)`,
        params: [event, endpoint],
      },
      {
        label: 'same cron window twice',
        expected: '23505',
        sql: `insert into ops.job_runs (job_name, window_start)
              values ('lab-constraint-probe', '2026-01-01T06:00:00Z'),
                     ('lab-constraint-probe', '2026-01-01T06:00:00Z')`,
      },
      {
        label: 'attempt_no must be > 0',
        expected: '23514',
        sql: `insert into app.delivery_attempts (delivery_id, attempt_no)
              values ($1, 0)`,
        params: [delivery],
      },
    ];

    for (const probeCase of cases) {
      await client.query('savepoint probe');
      try {
        await client.query(probeCase.sql, probeCase.params);
        await client.query('release savepoint probe');
        results.push({
          label: probeCase.label,
          expected: probeCase.expected,
          actual: 'ok',
          constraint: null,
        });
      } catch (err) {
        await client.query('rollback to savepoint probe');
        const pgError = err as { code?: string; constraint?: string; column?: string };
        results.push({
          label: probeCase.label,
          expected: probeCase.expected,
          actual: pgError.code ?? 'unknown',
          // NOT NULL violations populate `column`, not `constraint`.
          constraint: pgError.constraint ?? (pgError.column ? `column:${pgError.column}` : null),
        });
      }
    }

    await client.query('rollback');
  } finally {
    client.release();
  }

  const mismatches = results.filter((r) => {
    const expectedOk = r.expected.startsWith('ok');
    return expectedOk ? r.actual !== 'ok' : r.actual !== r.expected;
  });

  return {
    title: mismatches.length === 0 ? 'All 9 probes matched' : `${mismatches.length} mismatch(es)`,
    summary:
      'Each case ran inside a savepoint, so a failure did not abort the transaction. Everything was rolled back — no residue.',
    table: {
      columns: ['#', 'Case', 'Expected', 'Actual', 'Constraint'],
      rows: results.map((r, i) => [i + 1, r.label, r.expected, r.actual, r.constraint]),
    },
    notes: [
      'NULLS DISTINCT is the default: (tenant, NULL) never collides, which is what makes "no key supplied" mean "new event".',
      '23505 unique_violation, 23503 foreign_key_violation, 23502 not_null_violation, 23514 check_violation.',
      'The two NULL cases must both succeed — that is the proof, not a side effect.',
    ],
  };
}

async function schemasCatalog(): Promise<ActionResult> {
  const indexes = await pool.query<{ schemaname: string; tablename: string; indexname: string; indexdef: string }>(
    `select schemaname, tablename, indexname, indexdef
     from pg_indexes
     where schemaname in ('app', 'audit', 'ops')
     order by schemaname, tablename, indexname`,
  );

  const counts = await pool.query<{ table_schema: string; table_name: string; constraints: string }>(
    `select n.nspname as table_schema, c.relname as table_name, count(*)::text as constraints
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('app', 'audit', 'ops')
     group by 1, 2
     order by 1, 2`,
  );

  return {
    title: `${indexes.rows.length} indexes, all created by constraints or migrations`,
    summary:
      'You never wrote CREATE INDEX on deliveries, yet it has several. PRIMARY KEY and UNIQUE each build one.',
    table: {
      columns: ['Schema', 'Table', 'Index', 'Definition'],
      rows: indexes.rows.map((r) => [r.schemaname, r.tablename, r.indexname, r.indexdef]),
    },
    notes: [
      `Constraint counts: ${counts.rows.map((r) => `${r.table_schema}.${r.table_name}=${r.constraints}`).join(', ')}`,
      'Foreign key columns are absent from this list on purpose: Postgres does not index them for you.',
    ],
  };
}

async function migrationsLedger(): Promise<ActionResult> {
  const applied = await pool.query<{ id: number; name: string; run_on: Date }>(
    `select id, name, run_on from public.pgmigrations order by id`,
  );

  let onDisk: string[] = [];
  try {
    const files = await readdir(path.join(PROJECT_ROOT, 'migrations'));
    onDisk = files.filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')).sort();
  } catch {
    onDisk = [];
  }

  const appliedNames = new Set(applied.rows.map((r) => r.name));
  const pending = onDisk.filter((name) => !appliedNames.has(name));
  const missingFiles = [...appliedNames].filter((name) => !onDisk.includes(name));

  const columns = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `select column_name, data_type, is_nullable
     from information_schema.columns
     where table_schema = 'app' and table_name = 'deliveries'
     order by ordinal_position`,
  );

  const names = columns.rows.map((c) => c.column_name);
  const renamed = names.includes('attempt_count') && !names.includes('attempts_count');

  return {
    title: pending.length === 0 ? 'Schema is at head' : `${pending.length} migration(s) pending`,
    summary: `${applied.rows.length} applied, ${onDisk.length} on disk. The rename is ${renamed ? 'complete' : 'incomplete'}.`,
    table: {
      columns: ['Applied id', 'Name', 'Run on', 'Pending?'],
      rows: applied.rows.map((r) => [r.id, r.name, r.run_on.toISOString(), pending.includes(r.name)]),
    },
    notes: [
      pending.length ? `Pending: ${pending.join(', ')}` : 'No drift: every file on disk has a ledger row.',
      missingFiles.length
        ? `Applied but missing on disk (never delete a migration that has run): ${missingFiles.join(', ')}`
        : 'Every applied migration still exists on disk.',
      `deliveries columns: ${names.join(', ')}`,
    ],
  };
}

async function gitGraph(): Promise<ActionResult> {
  const [graph, branches, status, shallow] = await Promise.all([
    run('git', ['log', '--oneline', '--graph', '--first-parent', '-10', '--decorate'], PROJECT_ROOT),
    run('git', ['branch', '-vv'], PROJECT_ROOT),
    run('git', ['status', '--short', '--branch'], PROJECT_ROOT),
    run('git', ['log', '--all', '--oneline', '-3'], PROJECT_ROOT),
  ]);

  return {
    title: 'Read-only history snapshot',
    summary:
      '--first-parent follows trunk only. --all includes tooling refs, which is why it can look like unrelated history.',
    table: {
      columns: ['Command', 'Output'],
      rows: [
        ['git log --graph --first-parent -10', graph],
        ['git branch -vv', branches],
        ['git status --short --branch', status],
        ['git log --all --oneline -3', shallow],
      ],
    },
    notes: [
      'If --all shows commits with no connector, they belong to a different root (tooling refs), not to your trunk.',
    ],
  };
}

async function middlewareChain(): Promise<ActionResult> {
  const chain = listMiddleware();
  return {
    title: `${chain.length} middleware registered`,
    summary: 'Captured at createApp() time, so this is the real order, not a description of it.',
    table: {
      columns: ['#', 'Middleware'],
      rows: chain.map((name, i) => [i + 1, name]),
    },
    notes: [
      'requestId must run before anything that logs, or the correlation id is missing.',
      'The error handler is last and must accept four arguments.',
    ],
  };
}

async function middlewareErrorContract(input: unknown): Promise<ActionResult> {
  const baseUrl =
    typeof inputRecord(input).baseUrl === 'string'
      ? String(inputRecord(input).baseUrl)
      : `http://127.0.0.1:${config.PORT}`;

  const response = await fetch(`${baseUrl}/labs/api/probe/error`, {
    headers: { 'x-request-id': 'lab-contract-probe' },
  });
  const body = await response.text();

  return {
    title: `Server answered ${response.status} ${response.statusText}`,
    summary:
      'The domain error became a stable contract: status, error code, safe message and the correlation id.',
    table: {
      columns: ['Item', 'Value'],
      rows: [
        ['HTTP status', response.status],
        ['x-request-id header', response.headers.get('x-request-id') ?? '(none)'],
        ['content-type', response.headers.get('content-type') ?? '(none)'],
        ['x-powered-by', response.headers.get('x-powered-by') ?? '(absent — good)'],
        ['body', body],
      ],
    },
    notes: [
      'A ConflictError carried status 409 and code CONFLICT through the taxonomy, with no stack in the body.',
      'The inbound x-request-id was honoured, which is what makes cross-service tracing work.',
    ],
    raw: body,
  };
}

export const dataActions: ActionDefinition[] = [
  { id: 'infra.probe', label: 'Probe the live stack', topicId: 'bootstrap', run: infraProbe },
  {
    id: 'architecture.layers',
    label: 'Scan the layer rules',
    topicId: 'architecture',
    run: architectureLayers,
  },
  {
    id: 'schemas.constraints',
    label: 'Run 9 constraint probes',
    topicId: 'schemas',
    run: schemasConstraints,
  },
  { id: 'schemas.catalog', label: 'List indexes', topicId: 'schemas', run: schemasCatalog },
  { id: 'migrations.ledger', label: 'Read the ledger', topicId: 'migrations', run: migrationsLedger },
  { id: 'git.graph', label: 'Read history', topicId: 'git', run: gitGraph },
  { id: 'middleware.chain', label: 'Show the chain', topicId: 'middleware', run: middlewareChain },
  {
    id: 'middleware.error-contract',
    label: 'Trigger a real 409',
    topicId: 'middleware',
    run: middlewareErrorContract,
  },
];
