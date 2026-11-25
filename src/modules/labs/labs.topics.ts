import type { LabTopic } from './labs.types.js';

export const topics: LabTopic[] = [
  {
    id: 'bootstrap',
    order: 1,
    phase: '0',
    title: 'Docker & Bootstrap',
    status: 'live',
    summary:
      'Postgres and Redis run as containers with healthchecks and named volumes. The health endpoint proves dependencies, not just liveness.',
    keyIdeas: [
      'A named volume outlives the container; `docker compose down -v` is the only honest test of a migration.',
      'A healthcheck in compose is what lets `docker compose ps` say "healthy" instead of just "up".',
      '`/v1/health` returns 503 and names the failing dependency — it measures, it does not report a cached flag.',
      '`pool.max = 10` is deliberately too small for 4 worker replicas: you will hit it and measure it.',
      '`process.loadEnvFile` is built into Node; the migration CLI needs its own loader because it is a separate process.',
    ],
    interviewQuestions: [
      'What is the difference between liveness and readiness?',
      'Why does a health check that borrows from the main connection pool cause outages?',
      'What survives `docker compose down` but not `docker compose down -v`?',
      'Why should config validation exit the process instead of throwing later?',
    ],
    snippets: [
      {
        label: 'compose: healthcheck + named volume',
        language: 'yaml',
        code: `services:
  postgres:
    image: postgres:17-alpine
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hookrelay -d hookrelay"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:`,
      },
      {
        label: 'health service: measure both deps concurrently',
        language: 'ts',
        code: `const [db, redis] = await Promise.allSettled([deps.pingDb(), deps.pingRedis()]);

const checks = {
  db: db.status === 'fulfilled' ? 'ok' : 'fail',
  redis: redis.status === 'fulfilled' ? 'ok' : 'fail',
};

// allSettled (not all): a rejection in one must not hide the other's result.`,
      },
      {
        label: 'fail-fast config',
        language: 'ts',
        code: `if (existsSync('.env')) process.loadEnvFile('.env');

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}
export const config = parsed.data;`,
      },
    ],
    actions: [
      {
        id: 'infra.probe',
        label: 'Probe the live stack',
        description: 'Reads Postgres version/timezone, Redis version/uptime and the pool counters.',
      },
    ],
  },
  {
    id: 'architecture',
    order: 2,
    phase: '1',
    title: 'Backend Architecture',
    status: 'live',
    summary:
      'One direction of dependency: routes -> controller -> service -> repository -> infra. The composition root is the only place that knows every layer.',
    keyIdeas: [
      '`pg` lives only in `infra/`. A service must be unit-testable with no database.',
      '`express` may appear at runtime only in `*.routes.ts`; controllers import `RequestHandler` as `import type`, which erases at compile time.',
      'Routes are the HTTP adapter, so importing `Router` there is correct — the rule bans express in services, not in routes.',
      'The error handler must take four arguments and be registered last; Express detects it by arity.',
      '`createApp()` is a composition root: swap a dependency there and nothing else changes.',
      '`Promise.allSettled` in the health service, not `Promise.all` — `all` short-circuits and loses the other result.',
    ],
    interviewQuestions: [
      'Where does a transaction that spans two repositories live, and why not inside a repository?',
      'Why must the error-handling middleware have exactly four parameters?',
      'What does the client see for a thrown TypeError, and what do you see?',
      'Why is `import type` meaningful at runtime for a Node ESM app?',
    ],
    snippets: [
      {
        label: 'composition root',
        language: 'ts',
        code: `export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));

  const healthService = createHealthService({ pingDb, pingRedis });
  const healthController = createHealthController(healthService);
  app.use('/v1/health', createHealthRouter(healthController));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}`,
      },
      {
        label: 'error taxonomy + serializer',
        language: 'ts',
        code: `export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return _next(err);

  const isApp = err instanceof AppError;
  if (!isApp) console.error({ requestId: req.id }, 'unhandled error', err);

  res.status(isApp ? err.status : 500).json({
    error: {
      code: isApp ? err.code : 'INTERNAL',
      message: isApp ? err.message : 'Internal server error',
    },
    requestId: req.id,
  });
};`,
      },
    ],
    actions: [
      {
        id: 'architecture.layers',
        label: 'Scan the layer rules',
        description: 'Reads every source file and checks the import rules. Violations are listed, not assumed absent.',
      },
    ],
  },
  {
    id: 'node-events',
    order: 3,
    phase: '1b',
    title: 'Node.js Events (EventEmitter)',
    status: 'live',
    summary:
      "EventEmitter is Node's in-process pub/sub primitive: synchronous, non-durable, and the machinery under our HTTP server, the worker, pg and ioredis.",
    keyIdeas: [
      '`emit()` is synchronous. Every listener runs inline before it returns — an `async` listener returns a promise that `emit` does **not** await.',
      'A rejection inside an async listener is not caught by the emitter. On Node 15+ it becomes an unhandled rejection and terminates the process.',
      "`'error'` is the one special event: with no listener, `emit('error')` throws. Every other event with no listener is a silent no-op returning `false`.",
      'Listeners run in registration order; `once()` auto-removes after firing; `prependListener` jumps the queue.',
      'Node warns at 11 listeners per event. A listener added per request and never removed is the classic leak — fix the leak, not the threshold.',
      'It is **in-process only**: invisible to other replicas, no retry, lost on crash. That is precisely why delivery work goes through BullMQ instead of `emitter.emit`.',
      'Four different things get called "events": EventEmitter (in-process, sync), EventTarget (in-process, DOM-style), a message queue (cross-process, durable), and a webhook (cross-company, over HTTP).',
    ],
    interviewQuestions: [
      'Is `emit()` synchronous or asynchronous, and what does that mean for error handling?',
      "What happens when you emit `'error'` and nobody is listening?",
      "How does an async listener's rejection surface, and how do you handle it?",
      'When is EventEmitter the right tool, and when is using it instead of a queue a bug?',
      'What causes `MaxListenersExceededWarning`, and why is the default 11?',
      "How is `req.on('data')` related to EventEmitter, and what is backpressure?",
    ],
    snippets: [
      {
        label: 'emit is synchronous — the async listener is not awaited',
        language: 'ts',
        code: `emitter.on('demo', () => trace.push('A'));
emitter.on('demo', async () => {
  trace.push('B start');
  await sleep(15);
  trace.push('B end');
});

trace.push('caller: before emit');
const hadListeners = emitter.emit('demo'); // true
trace.push('caller: after emit');

// order: before emit, A, B start, after emit, ... B end`,
      },
      {
        label: "'error' throws when unhandled",
        language: 'ts',
        code: `const emitter = new EventEmitter();

emitter.emit('nobody-listening');        // false, silently dropped
emitter.emit('error', new Error('boom')); // throws synchronously

emitter.on('error', (err) => log(err));  // now it is delivered instead
emitter.emit('error', new Error('handled'));`,
      },
      {
        label: 'captureRejections routes async errors instead of crashing',
        language: 'ts',
        code: `const key = Symbol.for('nodejs.rejection');
const emitter = new EventEmitter({ captureRejections: true });

(emitter as unknown as Record<symbol, (e: unknown) => void>)[key] = (err) => {
  logger.error({ err }, 'listener failed');
};

emitter.on('job', async () => {
  throw new Error('handled by the rejection callback');
});`,
      },
      {
        label: 'in-process vs durable: why the queue exists',
        language: 'ts',
        code: `// in-process: fast, synchronous, lost on crash, invisible to other replicas
emitter.emit('delivery.created', delivery);

// cross-process: persisted in Redis, retried, observable, survives restarts
await queue.add('deliver', delivery, { jobId: delivery.id });`,
      },
    ],
    actions: [
      {
        id: 'events.order',
        label: 'Prove emit is synchronous',
        description: 'Traces listener order and shows the async listener finishing after the caller continues.',
      },
      {
        id: 'events.error',
        label: "Emit 'error' with and without a listener",
        description: 'A normal event is dropped silently; an unhandled error event throws out of emit.',
      },
      {
        id: 'events.leak',
        label: 'Trigger the listener leak warning',
        description: 'Adds 12 listeners to one event and captures MaxListenersExceededWarning.',
      },
      {
        id: 'events.async-crash',
        label: 'Crash a child process with an async listener',
        description: 'Runs the unsafe variant in a separate process, then shows captureRejections fixing it.',
      },
      {
        id: 'events.where-used',
        label: 'Find EventEmitter in this repo',
        description: 'Scans app code for .on/.once/.emit and lists the real touchpoints.',
      },
    ],
  },
  {
    id: 'schemas',
    order: 4,
    phase: '2',
    title: 'PostgreSQL Schemas',
    status: 'live',
    summary:
      'Three schemas (app / audit / ops) split by permission and retention. Constraints are the contract; the database enforces it, not the application.',
    keyIdeas: [
      '`unique (tenant_id, idempotency_key)` ignores NULLs by default, so "no key" means "always a new event".',
      '`timestamptz` stores an 8-byte UTC instant and converts using the session timezone — it stores no timezone text.',
      '`text` + `CHECK` beats a native enum when the value set evolves: dropping a check is an ordinary migration.',
      'No FK on `audit.audit_log.tenant_id`: audit must outlive its subject.',
      'External ids are UUIDs (unguessable); internal high-volume ids are `bigint` (8 bytes, sequential inserts).',
      'Every PRIMARY KEY and UNIQUE constraint silently creates a B-tree index. FK columns get none.',
    ],
    interviewQuestions: [
      'How many rows may share a NULL idempotency key, and why?',
      'What happens when you `CASCADE` a delete over 10M child rows?',
      'Why is the composite `(event_id, endpoint_id)` index useless for "deliveries of endpoint X"?',
      'Which indexes exist on `deliveries` and what created them?',
    ],
    snippets: [
      {
        label: 'idempotency depends on NULL semantics',
        language: 'sql',
        code: `constraint events_idempotency_unique unique (tenant_id, idempotency_key)

-- NULLs are distinct by default, so this inserts twice:
insert into app.events (id, tenant_id, type, payload, idempotency_key)
values (gen_random_uuid(), $1, 'order.created', '{}', null);`,
      },
      {
        label: 'evolving status without an enum',
        language: 'sql',
        code: `constraint deliveries_status_valid check (
  status in ('pending','in_progress','retrying','succeeded','dead','cancelled')
)

-- to add a value: drop + add the check (ordinary migration)
-- with a native enum you cannot remove a value at all`,
      },
      {
        label: 'the audit table deliberately has no FK',
        language: 'sql',
        code: `create table audit.audit_log (
  id          bigint generated always as identity primary key,
  tenant_id   uuid,   -- historical value, not a live pointer
  actor       text not null,
  action      text not null,
  entity_type text not null,
  entity_id   text not null,
  diff        jsonb,
  request_id  text,
  created_at  timestamptz not null default now()
);`,
      },
    ],
    actions: [
      {
        id: 'schemas.constraints',
        label: 'Run 9 constraint probes',
        description: 'Replays real violations inside a transaction and reports expected vs actual SQLSTATE, then rolls back.',
      },
      {
        id: 'schemas.catalog',
        label: 'List indexes and constraints',
        description: 'Shows what the database actually created, including the indexes you never wrote.',
      },
    ],
  },
  {
    id: 'migrations',
    order: 5,
    phase: '3',
    title: 'Migrations',
    status: 'live',
    summary:
      'The ledger table is what makes a folder of SQL into a versioned schema. Zero-downtime changes are three separate deploys, not one clever statement.',
    keyIdeas: [
      '`pgmigrations` records which migration ran and when — the schema has a version, not just a shape.',
      'Expand/contract: add the new column + a sync trigger, backfill, then contract. Three deploys, two of them code-only.',
      '`RENAME COLUMN` takes milliseconds and is still a production incident: old processes keep asking for the old name.',
      '`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and a failed build leaves an invalid index behind.',
      '`NOT VALID` then `VALIDATE` avoids a long exclusive lock when adding a CHECK or FK.',
      '`DEFAULT 0` is a catalog change; `DEFAULT now()` rewrites the whole table.',
    ],
    interviewQuestions: [
      'Why is a folder of .sql files worse than a migrations table, concretely?',
      'How do you rename a column with zero downtime?',
      'What does a half-applied migration leave behind, and how do you recover?',
      'How do you add a NOT NULL column with a default to a 50M-row table?',
    ],
    snippets: [
      {
        label: 'expand step: keep both readers working',
        language: 'sql',
        code: `alter table app.deliveries add column if not exists attempt_count integer;

create or replace function app.deliveries_sync_attempt_count() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.attempt_count := coalesce(new.attempt_count, new.attempts_count);
  elsif new.attempt_count is not distinct from old.attempt_count
        and new.attempts_count is distinct from old.attempts_count then
    new.attempt_count := new.attempts_count;
  end if;
  return new;
end;
$$;`,
      },
      {
        label: 'contract step: validate without a long lock',
        language: 'sql',
        code: `alter table app.deliveries
  add constraint deliveries_attempt_count_not_null
  check (attempt_count is not null) not valid;

alter table app.deliveries validate constraint deliveries_attempt_count_not_null;

alter table app.deliveries alter column attempt_count set default 0;
alter table app.deliveries alter column attempt_count set not null;
alter table app.deliveries drop constraint deliveries_attempt_count_not_null;
alter table app.deliveries drop column attempts_count;`,
      },
      {
        label: 'batched backfill that does not block workers',
        language: 'sql',
        code: `with batch as (
  select id from app.deliveries
  where attempt_count is null
  order by id
  limit 1000
  for update skip locked
)
update app.deliveries d
set attempt_count = d.attempts_count
from batch b
where d.id = b.id;`,
      },
    ],
    actions: [
      {
        id: 'migrations.ledger',
        label: 'Read the ledger + detect drift',
        description: 'Compares applied migrations in pgmigrations against the files on disk.',
      },
    ],
  },
  {
    id: 'git',
    order: 6,
    phase: '4',
    title: 'Git: branches, PRs, merges',
    status: 'live',
    summary:
      'One short-lived branch per phase, merged with --no-ff so the branch stays visible. Revert for shared history, reset only locally.',
    keyIdeas: [
      '`--no-ff` keeps a merge commit, so the branch is readable in history later.',
      '`git log --first-parent` shows trunk history without wading through side branches.',
      '`git log --all` includes tooling refs (agent checkpoints), which can look like corrupt history.',
      'Squash keeps main clean but coarsens `git blame` and `git bisect`.',
      '`revert` is a new commit; `reset --hard` moves the pointer and erases commits — never on a pushed branch.',
      '`git bisect run <command>` automates the search using any command that exits non-zero on failure.',
    ],
    interviewQuestions: [
      'Merge vs rebase: what does each do to history, and when is rebase the wrong choice?',
      'Why is revert preferred over reset on a shared branch?',
      'How do you undo a merged PR that is already on main?',
      'What does `--force-with-lease` protect against that `--force` does not?',
    ],
    snippets: [
      {
        label: 'the workflow used in this repo',
        language: 'bash',
        code: `git switch -c feat/queues-and-cron
# ...commits...
git switch main
git merge --no-ff feat/queues-and-cron
git log --oneline --graph --first-parent -8`,
      },
      {
        label: 'bisect with an automated predicate',
        language: 'bash',
        code: `git bisect start
git bisect bad
git bisect good main
git bisect run npm run typecheck
git bisect reset`,
      },
      {
        label: 'undo a merge commit',
        language: 'bash',
        code: `# -m 1 keeps the first parent (main) and undoes what the branch brought in
git revert -m 1 <merge-sha>`,
      },
    ],
    actions: [
      {
        id: 'git.graph',
        label: 'Read this repo’s history',
        description: 'Runs read-only git commands: first-parent graph, branches, working tree status.',
      },
    ],
  },
  {
    id: 'middleware',
    order: 7,
    phase: '5',
    title: 'Middleware',
    status: 'live',
    summary:
      'Order is behaviour. requestId first so every later log line has it; the error handler last and with four arguments.',
    keyIdeas: [
      'Order: requestId -> logger -> auth -> validate -> handler -> notFound -> errorHandler.',
      'Swapping requestId after the logger means the log line has no correlation id.',
      'Express 5 forwards rejected promises from async handlers automatically; Express 4 did not.',
      '`res.headersSent` guard: once headers are flushed, delegating to `next(err)` is the only safe move.',
      'Raw body for HMAC must be captured before JSON parsing (`express.json({ verify })`).',
      '`requireApiKey` stores only a SHA-256 hash and looks the token up by hash: 401 means unknown, 403 means known but missing a scope.',
      'The limiter keys on the API key id, not the tenant, so one noisy key cannot throttle the rest of a tenant.',
      '`trust proxy` decides whether `req.ip` is the client or your load balancer.',
    ],
    interviewQuestions: [
      'Name the middleware order and what breaks if two are swapped.',
      'Why does the error handler need four parameters?',
      'What happens if you write to res after headers were sent?',
      'Where do you capture the raw body, and why not after parsing?',
    ],
    snippets: [
      {
        label: 'the chain, in order',
        language: 'ts',
        code: `app.disable('x-powered-by');
app.use(requestId);                      // 1. correlation id
app.use(express.json({ limit: '1mb' })); // 2. body parsing
app.use('/v1/health', createHealthRouter(healthController));
app.use(notFound);                       // 3. 404 -> AppError
app.use(errorHandler);                   // 4. must be last, 4 args`,
      },
      {
        label: 'raw body before parsing (webhook signatures)',
        language: 'ts',
        code: `app.use(express.json({
  verify: (req, _res, buf) => {
    (req as RawBodyRequest).rawBody = buf;
  },
}));`,
      },
    ],
    actions: [
      {
        id: 'middleware.chain',
        label: 'Show the mounted chain',
        description: 'Reads the live registry captured during createApp().',
      },
      {
        id: 'middleware.error-contract',
        label: 'Trigger a real 409',
        description: 'HTTP-requests this server and shows the exact status, body and requestId.',
      },
      {
        id: 'middleware.auth',
        label: 'Authenticate with an API key',
        description: 'Issues real keys and shows valid, missing, unknown, wrong-scope and revoked cases.',
      },
      {
        id: 'middleware.validation',
        label: 'Validate a body',
        description: 'Sends four invalid bodies and one valid one; each failure returns structured issues.',
      },
      {
        id: 'middleware.ratelimit',
        label: 'Exceed the rate limit',
        description: 'Fires limit+2 requests on one key and shows 429 with Retry-After.',
      },
      {
        id: 'middleware.rawbody',
        label: 'Prove raw bytes are captured',
        description: 'Compares the client hash with the server hash over an oddly formatted body.',
      },
    ],
  },
  {
    id: 'queues',
    order: 8,
    phase: '7',
    title: 'Queues (BullMQ)',
    status: 'live',
    summary:
      'At-least-once delivery with retries, exponential backoff and a dead-letter state. `jobId` gives idempotency; `UnrecoverableError` stops pointless retries.',
    keyIdeas: [
      'BullMQ gives at-least-once. Exactly-once is impossible, so the consumer must be idempotent.',
      '`jobId = deliveryId` makes enqueueing idempotent: a second add with the same id is ignored.',
      '4xx is deterministic — retrying a 401 nine times is pure waste. Throw `UnrecoverableError`.',
      '`failed` fires on every failed attempt; check `job.attemptsMade >= job.opts.attempts` for the terminal state.',
      'Worker connections need `maxRetriesPerRequest: null`; blocking reads must not be capped.',
      'Graceful shutdown (`worker.close()`) waits for in-flight jobs. `process.exit()` leaves them active until the stalled check re-delivers them.',
    ],
    interviewQuestions: [
      'At-least-once vs exactly-once — which do you get, and what does it force on the consumer?',
      'What failure does `jobId = deliveryId` prevent, and what does it not prevent?',
      'Why exponential backoff, and why add jitter?',
      'What happens to an active job if the worker is killed mid-flight?',
    ],
    snippets: [
      {
        label: 'queue defaults: retry policy',
        language: 'ts',
        code: `new Queue('deliveries', {
  connection: createRedisConnection(), // maxRetriesPerRequest: null
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400, count: 5_000 },
  },
});`,
      },
      {
        label: 'classify the failure before you retry',
        language: 'ts',
        code: `if (host.startsWith('fail-400')) {
  // deterministic: retrying only burns attempts
  throw new UnrecoverableError('400 from receiver');
}
throw new Error('503 from receiver'); // retryable`,
      },
      {
        label: 'terminal vs intermediate (the event fires every time)',
        language: 'ts',
        code: `worker.on('failed', (job, err) => {
  if (!job) return;
  const max = job.opts.attempts ?? 1;
  const terminal = job.attemptsMade >= max;
  console.log(terminal ? 'dead' : 'retrying', job.id, err.message);
});`,
      },
    ],
    actions: [
      {
        id: 'queues.enqueue-ok',
        label: 'Enqueue a healthy delivery',
        description: 'Adds a job that the worker will complete on the first attempt.',
      },
      {
        id: 'queues.enqueue-500',
        label: 'Enqueue a retryable failure',
        description: 'Adds a job that throws, so exponential backoff kicks in.',
      },
      {
        id: 'queues.enqueue-400',
        label: 'Enqueue an unrecoverable 4xx',
        description: 'Adds a job that throws UnrecoverableError — dead on attempt 1.',
      },
      {
        id: 'queues.dedupe',
        label: 'Prove jobId dedupe',
        description: 'Adds the same jobId twice to an isolated queue and counts what landed.',
      },
      {
        id: 'queues.snapshot',
        label: 'Snapshot queue state',
        description: 'Counts jobs by state and lists connected workers.',
      },
    ],
  },
  {
    id: 'cron',
    order: 9,
    phase: '8',
    title: 'Cron jobs',
    status: 'live',
    summary:
      'A scheduler decides when; a database claim decides who. The unique (job_name, window_start) constraint makes the claim atomic.',
    keyIdeas: [
      '`upsertJobScheduler` is safe to call from every replica at boot — it updates instead of duplicating.',
      'Cron patterns in BullMQ are six fields: seconds first. `0 0 6 * * *` is 06:00 daily.',
      '`every: 60_000` is a fixed interval that drifts under load; `pattern` is wall-clock time.',
      'Claim the window before doing the work. If you work first and record second, both replicas work.',
      '`insert ... on conflict do nothing returning id` returning zero rows is the "someone else owns this window" signal.',
      'Cron jobs must be idempotent even with a scheduler: retries, clock changes and manual runs all exist.',
    ],
    interviewQuestions: [
      'Three ways cron in a container breaks with multiple replicas.',
      'Why claim the window before doing the work?',
      'What is the difference between a scheduler and a lock here — do you need both?',
      'What happens if a cron job runs twice concurrently and only writes at the end?',
    ],
    snippets: [
      {
        label: 'schedulers are idempotent by upsert',
        language: 'ts',
        code: `await queue.upsertJobScheduler('retry-sweeper', { every: 60_000 });
await queue.upsertJobScheduler('daily-digest', {
  pattern: '0 0 6 * * *',
  tz: 'UTC',
});`,
      },
      {
        label: 'claim first, work second',
        language: 'ts',
        code: `const claimed = await pool.query(
  \`insert into ops.job_runs (job_name, window_start)
   values ($1, $2)
   on conflict (job_name, window_start) do nothing
   returning id\`,
  [job.name, windowStart],
);

if (claimed.rowCount === 0) return; // another replica owns this window`,
      },
    ],
    actions: [
      {
        id: 'cron.claim-race',
        label: 'Race two replicas for one window',
        description: 'Two connections insert the same (job_name, window_start) concurrently. Exactly one wins.',
      },
      {
        id: 'cron.schedulers',
        label: 'List registered schedulers',
        description: 'Reads the schedulers BullMQ actually holds in Redis.',
      },
    ],
  },
  {
    id: 'indexes',
    order: 10,
    phase: '11',
    title: 'Indexes',
    status: 'live',
    summary:
      'Seed a realistic table, then measure the same query before and after the index the worker needs.',
    keyIdeas: [
      'Every index taxes writes and disk. Add one because a query is slow, not because a column is queried.',
      'Composite indexes follow leftmost-prefix: `(a, b)` serves `a` and `a,b`, never `b` alone.',
      'Partial indexes are smaller and hotter: index only the rows the query can match.',
      'Covering indexes (`INCLUDE`) enable index-only scans — watch `Heap Fetches` to confirm it.',
      'FK columns are not auto-indexed; a cascade without one can full-scan the child per parent.',
      '`pg_stat_user_indexes.idx_scan = 0` is the signal that an index is dead weight.',
    ],
    interviewQuestions: [
      'Six indexes on one table — what is the write cost?',
      'Why does the planner ignore your index on a low-cardinality column?',
      'When is a partial index better than a full one?',
      'Why can a composite index not serve a query on its second column?',
    ],
    snippets: [
      {
        label: 'the worker hot query and its partial index',
        language: 'sql',
        code: `select id from app.deliveries
where status = 'retrying' and next_attempt_at <= now()
order by next_attempt_at
limit 100;

create index deliveries_sweep_lab
  on app.deliveries (next_attempt_at)
  where status in ('pending', 'retrying');`,
      },
      {
        label: 'covering index for an index-only scan',
        language: 'sql',
        code: `create index deliveries_cover_lab
  on app.deliveries (endpoint_id, created_at desc)
  include (status);

-- look for "Heap Fetches: 0" in EXPLAIN (ANALYZE, BUFFERS)`,
      },
    ],
    actions: [
      {
        id: 'indexes.seed',
        label: 'Seed 100k lab rows',
        description: 'Generates events + deliveries tagged type=lab.seed. Heavy but idempotent.',
      },
      {
        id: 'indexes.before-after',
        label: 'Measure before vs after',
        description: 'Drops the lab index, runs EXPLAIN ANALYZE, creates it, runs again, compares.',
      },
      {
        id: 'indexes.cleanup',
        label: 'Delete lab rows',
        description: 'Removes the seed and shows the cascade cost.',
      },
    ],
  },
  {
    id: 'query-plans',
    order: 11,
    phase: '12',
    title: 'Query plans',
    status: 'live',
    summary:
      'EXPLAIN ANALYZE BUFFERS is the only honest performance measurement. Compare estimated rows to actual rows to find stale stats.',
    keyIdeas: [
      '`EXPLAIN` alone is a guess; `ANALYZE` executes and reports reality — never on a write in production without a transaction.',
      'A large gap between `rows=` estimated and actual means stale statistics: run `ANALYZE`.',
      'Seq scan on a big table with a selective filter is the smell. On a small table it is often correct.',
      '`Sort Method: external merge` and `Batches > 1` mean `work_mem` spilled to disk.',
      'Nested loop is right for small inputs; hash join for large unsorted ones. The planner chooses by cost.',
      '`pg_stat_statements` ranks queries by total time, which is where you look first.',
    ],
    interviewQuestions: [
      '"Slow in prod, fast locally" — name six causes.',
      'How do you know a plan is wrong rather than the query?',
      'What does a high `Heap Fetches` count tell you?',
      'When would you raise `work_mem` — and when is that the wrong fix?',
    ],
    snippets: [
      {
        label: 'the only measurement worth quoting',
        language: 'sql',
        code: `explain (analyze, buffers, verbose)
select d.id, e.type
from app.deliveries d
join app.events e on e.id = d.event_id
where d.status = 'retrying'
order by d.next_attempt_at
limit 50;`,
      },
      {
        label: 'where the tables stand',
        language: 'sql',
        code: `select relname, seq_scan, idx_scan, n_live_tup, last_analyze
from pg_stat_user_tables
where schemaname = 'app'
order by seq_scan desc;`,
      },
    ],
    actions: [
      {
        id: 'plans.stats',
        label: 'Table access statistics',
        description: 'seq_scan vs idx_scan, live tuples and last ANALYZE per table.',
      },
      {
        id: 'plans.explain',
        label: 'Explain the hot join',
        description: 'Runs EXPLAIN (ANALYZE, BUFFERS) and flattens the plan tree.',
      },
    ],
  },
  {
    id: 'webhooks',
    order: 12,
    phase: '9',
    title: 'Webhooks',
    status: 'live',
    summary:
      'Sign `timestamp.body` so a captured payload cannot be replayed later. Stable event ids let receivers dedupe.',
    keyIdeas: [
      'Sign `t.body`, not the body alone: otherwise a captured request is valid forever.',
      'Reject signatures older than ~5 minutes — that is the replay window you accept.',
      'Verify with a constant-time comparison, not `===`.',
      'Classify the response: 2xx success, 429/5xx retry, other 4xx dead.',
      'Send a stable `X-Event-Id` so the receiver can be idempotent.',
      'Rotate secrets by accepting the previous one for verification while signing with the new one.',
    ],
    interviewQuestions: [
      'Why include a timestamp in the signed string?',
      'Exactly-once delivery: why is it impossible, and what do you build instead?',
      'How do you verify a signature without leaking it through timing?',
      'How do you rotate a webhook secret without breaking receivers?',
    ],
    snippets: [
      {
        label: 'sign and verify',
        language: 'ts',
        code: `const t = Math.floor(Date.now() / 1000);
const signature = createHmac('sha256', secret).update(\`\${t}.\${body}\`).digest('hex');

// receiver
if (Math.abs(now - t) > 300) return reject('stale');
if (!timingSafeEqual(hex(signature), hex(received))) return reject('bad signature');`,
      },
    ],
    actions: [
      {
        id: 'webhooks.hmac',
        label: 'Sign, tamper, replay',
        description: 'Computes a real HMAC, then checks a tampered body and a stale timestamp.',
      },
      {
        id: 'webhooks.outbound',
        label: 'Deliver a signed event end to end',
        description: 'Creates an event, the worker signs and delivers it back to the inbound receiver, dedupe row verified.',
      },
      {
        id: 'webhooks.inbound',
        label: 'Accept, dedupe and reject',
        description: 'Posts five inbound requests: fresh, replay, tampered, stale and unsigned.',
      },
    ],
  },
  {
    id: 'polling',
    order: 13,
    phase: '10',
    title: 'Polling',
    status: 'live',
    summary:
      'When the consumer cannot accept inbound traffic, poll — but make it cheap with ETag/304 and keep jitter in the retry loop.',
    keyIdeas: [
      '`ETag` + `If-None-Match` returns 304 with no body: bandwidth scales with changes, not with polls.',
      'Long-poll holds the request open for a bounded time to cut latency without a socket.',
      'Backoff must be randomized or every client retries in the same instant.',
      'Polling the provider as a webhook fallback needs a stored cursor and a lock so only one replica polls.',
      'Prefer webhooks for latency and cost; prefer polling when inbound traffic is impossible.',
    ],
    interviewQuestions: [
      'The customer firewall blocks inbound. Now what?',
      'What does 304 save, and what does it not save?',
      'Why does jitter matter more than the backoff curve?',
      'How do you poll safely with three replicas?',
    ],
    snippets: [
      {
        label: 'conditional request',
        language: 'http',
        code: `GET /labs/api/topics HTTP/1.1
If-None-Match: W/"1a2b3c"

HTTP/1.1 304 Not Modified`,
      },
      {
        label: 'jittered backoff',
        language: 'ts',
        code: `const cap = 30_000;
const base = 500;
const delay = Math.random() * Math.min(cap, base * 2 ** attempt);`,
      },
    ],
    actions: [
      {
        id: 'polling.etag',
        label: 'Round-trip 200 then 304',
        description: 'Requests this server twice, honouring If-None-Match.',
      },
      {
        id: 'polling.lifecycle',
        label: 'Poll a delivery with ETag and long-poll',
        description: 'Creates a delivery, then shows the 200, the 304 and a long-poll returning on terminal state.',
      },
    ],
  },
  {
    id: 'logs',
    order: 14,
    phase: '6',
    title: 'Logs',
    status: 'live',
    summary:
      'One JSON object per line, redacted before it is written, correlated by requestId, and kept separate from the append-only audit trail.',
    keyIdeas: [
      'Structured JSON, not string concatenation: logs are queried, not read.',
      'Child logger per request carrying `requestId`, `tenantId`; pass the id into job payloads for end-to-end tracing.',
      'Redact secrets at the logger level so a forgotten field cannot leak.',
      'Write to stdout in containers; the platform collects. Files need rotation or they fill the disk.',
      'Redis Streams for log fan-out, not Pub/Sub: Streams can replay and support consumer groups.',
      'Audit rows are business records with years of retention; app logs are operational with days.',
      'Wired here: `requestLogger` listens on `res.on("finish")`, pino applies redaction, and `appendLog` writes to `logs:events` with MAXLEN ~ 10000.',
      'The audit write path is `recordAudit()` in `modules/audit` — a service, so any future endpoint can call it without knowing the SQL.',
    ],
    interviewQuestions: [
      'Logs vs metrics vs traces — what question does each answer?',
      'Why is Pub/Sub the wrong choice for a log pipeline?',
      'How do you correlate a log line with the HTTP request that caused it?',
      'What do you alert on?',
    ],
    snippets: [
      {
        label: 'pino with redaction and correlation',
        language: 'ts',
        code: `const logger = pino({
  redact: ['req.headers.authorization', '*.secret', '*.apiKey'],
});

const log = logger.child({ requestId: req.id, tenantId: req.tenantId });
log.info({ deliveryId }, 'delivery attempted');`,
      },
      {
        label: 'redis streams with a bounded length',
        language: 'bash',
        code: `redis-cli XADD logs:events MAXLEN '~' 10000 '*' level info msg "delivery.done"
redis-cli XREAD COUNT 10 BLOCK 0 STREAMS logs:events '$'`,
      },
    ],
    actions: [
      {
        id: 'logs.structured',
        label: 'Render a structured line',
        description: 'Logs with secrets present and shows the redacted JSON that actually gets written.',
      },
      {
        id: 'logs.stream',
        label: 'Append to the Redis Stream',
        description: 'XADDs three entries, reads them back newest-first, and reports the capped length.',
      },
      {
        id: 'logs.correlation',
        label: 'Trace one request by id',
        description: 'Calls the health endpoint with a known x-request-id, then finds that line in the stream.',
      },
      {
        id: 'logs.audit',
        label: 'Write and read an audit row',
        description: 'Uses the real audit service to insert and re-read a business event.',
      },
    ],
  },
];

export function getTopic(id: string): LabTopic | undefined {
  return topics.find((t) => t.id === id);
}
