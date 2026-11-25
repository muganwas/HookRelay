import type { LabTopic } from './labs.types.js';

export const topics: LabTopic[] = [
  {
    id: 'bootstrap',
    order: 1,
    phase: '0',
    title: 'Docker & Bootstrap',
    status: 'live',
    summary:
      'Postgres and Redis run in containers started from images. The health check reports what is actually reachable, not just whether the process is still running.',
    keyIdeas: [
      'A **named volume** keeps data when a container is deleted. `docker compose down -v` removes it too, which makes it the only honest way to test a setup from scratch.',
      'A **healthcheck** is a command the runtime keeps repeating. It is what turns "up" into "healthy" in `docker compose ps`.',
      '`/v1/health` tries both dependencies and answers 503 when one fails, naming which one. It measures now instead of repeating a stored answer.',
      'The database connection pool is capped at 10 connections on purpose. Four worker replicas will run out, and you will see what that looks like instead of reading about it.',
      'A container is stopped with `SIGTERM`, the "please finish" signal that a graceful shutdown listens for. Node can read `.env` by itself with `process.loadEnvFile`; the migration tool is a separate program and needs its own loader, which is why `dotenv` is installed.',
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
      'Code is organised in layers with one rule: dependencies point one way. A route receives the request, a service holds the logic, infrastructure owns the database. Only one file knows about all of them.',
    keyIdeas: [
      'The database driver (`pg`) is imported in one folder, `infra/`. A service that imports it directly cannot be tested without a database.',
      'Express is imported at runtime only inside `*.routes.ts`. Controllers use `import type`, which disappears when the code is compiled.',
      'A route file is allowed to import Express because that file **is** the adapter to HTTP. The rule bans Express in business logic, not in the adapter.',
      'The error handler must accept four parameters and be registered last. Express counts the parameters to recognise it as an error handler.',
      '`createApp()` is the **composition root**: the one place where real dependencies are wired in. Swap a fake database there and nothing else changes.',
      'The health check uses `Promise.allSettled`, not `Promise.all`. `all` stops at the first failure and throws away the other answer.',
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
      "An EventEmitter is Node's way of letting one part of a program announce that something happened, and immediately calling the functions that asked about it. It is fast, it stays inside one process and one turn of the event loop, and it is what runs underneath the HTTP server, the worker and the database driver.",
    keyIdeas: [
      '`emit()` runs every listener immediately, one after another. An `async` listener returns a promise, and `emit` does **not** wait for it.',
      'If an async listener throws, nobody is waiting to catch it. Since Node 15 that counts as an unhandled rejection and ends the process.',
      "`'error'` is the special case: with no listener attached, emitting an error throws. Any other event with no listener is simply ignored and returns `false`.",
      'Listeners run in the order they were added. `once()` removes itself after firing, and `prependListener` puts a listener at the front.',
      'Node warns at 11 listeners on one event. If a request adds a listener and never removes it, that warning is a real leak: fix the leak, do not raise the limit.',
      'It works only **inside one process**: other replicas cannot hear it, nothing is retried, and a crash loses the event. That is exactly why delivery work goes through a queue instead.',
      "Four different things get called events: an EventEmitter (inside one process, immediate), an EventTarget (same idea, browser style), a message queue (across processes, durable), and a webhook (across companies, over HTTP).",
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
        label: 'emit is synchronous: the async listener is not awaited',
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
      'Three schemas separate data by purpose: `app` for live business data, `audit` for history, `ops` for job bookkeeping. The rules live in the database, so a bug in the application cannot break them.',
    keyIdeas: [
      'A UNIQUE constraint on `(tenant_id, idempotency_key)` treats NULL as "no value", so rows without a key never collide. That is why "no key" means "always a new event".',
      '`timestamptz` stores one instant in UTC and converts it when read. It does not store the timezone as text.',
      'A `text` column plus a CHECK constraint is easier to change than a native enum: you can add or remove allowed values with an ordinary migration.',
      'The audit table deliberately has no foreign key: a record of what happened must survive even if the tenant is deleted.',
      'Public ids are UUIDs because they cannot be guessed. Internal, high-volume ids are `bigint` because they are 8 bytes and insert in order.',
      'Every primary key and unique rule quietly creates a B-tree index. A foreign-key column gets none: that is the one you have to add yourself.',
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
      'A migration is one recorded change to the database structure. The table of applied migrations is what turns a folder of SQL files into a versioned schema, and a big change is split into several safe deploys instead of one clever statement.',
    keyIdeas: [
      '`pgmigrations` records which migration ran and when. The schema has a version, not just a shape.',
      'Expand, then contract: add the new column and keep both in sync, fill in the existing rows, move readers over, and only then delete the old column. That pattern is called expand/contract: three deploys, two of them code-only.',
      '`RENAME COLUMN` takes milliseconds and can still break production: old processes are still asking for the old name.',
      '`CREATE INDEX CONCURRENTLY` builds an index without blocking writes. It cannot run inside a transaction, and a failed build leaves an invalid index you must drop.',
      'Add a rule as `NOT VALID` first, then `VALIDATE` it. That avoids holding a long exclusive lock while every existing row is checked.',
      'A `DEFAULT 0` is a cheap catalog change. `DEFAULT now()` has to write a value into every existing row, which rewrites the whole table.',
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
      'Each piece of work gets its own short-lived branch and is merged with `--no-ff`, so history still shows that a branch existed. Undo shared work with `revert`, and keep `reset` for your own machine.',
    keyIdeas: [
      '`--no-ff` (no fast-forward) always creates a merge commit. You keep a visible record of the branch and the commits it brought in.',
      '`git log --first-parent` follows the trunk and skips side branches, which is the readable history.',
      '`git log --all` also shows refs created by tools, such as editor checkpoints. Extra branches there are not corruption.',
      'A **squash** keeps the main branch tidy but makes `git blame` less precise and `git bisect` coarser.',
      '`revert` makes a new commit that undoes the change. `reset --hard` moves the branch and throws commits away, so never do it on a pushed branch.',
      '`git bisect run <command>` finds the bad commit by halving history, using your command as the judge.',
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
      'Middleware is code that runs around the handler: before it, after it, or instead of it. The order is the behaviour: an id first means later log lines can use it, and the error handler goes last.',
    keyIdeas: [
      'The order here: request id, logging, authentication, validation, handler, 404, error handler.',
      'Register the logger after the request id. The other way round, every log line is missing the id that ties it to a request.',
      'Express 5 catches a rejected promise from an async handler and passes it to the error handler. Express 4 did not, which is why older code wraps everything in try/catch.',
      'Once the response headers are sent you cannot send a different status. Check `res.headersSent` and hand the error on instead.',
      'To verify a signature you need the **raw bytes** exactly as they arrived, so keep the body before JSON parsing turns it into an object.',
      'API keys are stored as a SHA-256 hash, never as plain text. 401 means "I do not know this key"; 403 means "I know it, but it lacks this permission".',
      'The rate limiter counts per API key, not per tenant, so one noisy key cannot use up the whole tenant allowance.',
      '`trust proxy` decides whether `req.ip` is the real client or your load balancer. Get it wrong and every client looks like one IP.',
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
      'A queue lets the request finish before the slow work happens. Jobs are retried with longer and longer waits, and eventually end up in a dead-letter state. Because a job can run more than once, the work has to be safe to repeat.',
    keyIdeas: [
      'The guarantee is **at-least-once**: a job runs one or more times, never zero. Exactly once is not achievable across crashes, so the consumer must be idempotent.',
      'Using the delivery id as the `jobId` makes enqueueing idempotent: adding the same id twice is ignored by the queue.',
      'A 4xx response is a permanent answer, so retrying a 401 nine times helps nobody. Throw `UnrecoverableError` to stop early.',
      'The `failed` event fires on every failed attempt, not only the last one. Compare `attemptsMade` with `attempts` to know when the job is truly dead.',
      'The worker connection must be allowed to perform blocking reads (`maxRetriesPerRequest: null`), otherwise waiting for a job looks like a network error.',
      'Shut down with `worker.close()` so running jobs finish. `process.exit()` leaves them half-done until the stalled check hands them to another worker.',
    ],
    interviewQuestions: [
      'At-least-once vs exactly-once: which do you get, and what does it force on the consumer?',
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
        description: 'Adds a job that throws UnrecoverableError: dead on attempt 1.',
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
      'For repeating work, one part decides **when** it is due (the schedule) and another decides **who** runs it (a database claim). A unique key on the job name and time window is what makes "only one replica runs this" true.',
    keyIdeas: [
      '`upsertJobScheduler` updates an existing schedule instead of adding a second one, so every replica can call it at boot.',
      'BullMQ cron patterns have six fields and start with seconds: `0 0 6 * * *` means 06:00 every day.',
      '`every: 60_000` is a fixed delay that drifts under load. A `pattern` follows clock time.',
      'Claim the time window **before** doing the work. Work first and record second, and two replicas both do it.',
      '`insert ... on conflict do nothing returning id` returning no rows is the signal that another replica already owns this window.',
      'Even with a scheduler, cron work must be idempotent: retries, clock changes and manual runs all happen.',
    ],
    interviewQuestions: [
      'Three ways cron in a container breaks with multiple replicas.',
      'Why claim the window before doing the work?',
      'What is the difference between a scheduler and a lock here: do you need both?',
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
      'An index is a sorted shortcut that lets the database find rows without reading the table. It makes reads faster and writes slower, so you add one because a query is slow, and then measure the difference.',
    keyIdeas: [
      'Every index costs time on insert, update and delete, plus disk space. Add one for a slow query, not because a column appears in a WHERE clause.',
      'A two-column index `(a, b)` serves `a` and `a,b`, but never `b` alone. Think of a phone book sorted by surname, then first name.',
      'A **partial** index only covers the rows a query cares about, so it is smaller, cheaper to update and more likely to stay in memory.',
      'A **covering** index already contains every column the query needs, so the table itself is never read. Check `Heap Fetches` in the plan to confirm.',
      'A foreign-key column is not indexed automatically. Without an index, deleting one parent row can scan the whole child table.',
      '`pg_stat_user_indexes.idx_scan = 0` means an index has never been used: it is pure cost, and a candidate for deletion.',
    ],
    interviewQuestions: [
      'Six indexes on one table: what is the write cost?',
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
      'A query plan is the database explaining how it intends to answer your query. `EXPLAIN ANALYZE` actually runs it and shows what really happened, which is the only performance number worth quoting.',
    keyIdeas: [
      '`EXPLAIN` on its own shows what the database **thinks** it will do. Adding `ANALYZE` runs the query and reports real rows and real times.',
      'A large gap between estimated rows and actual rows means the statistics are stale. Run `ANALYZE` on that table.',
      'A sequential scan (a seq scan) on a large table with a narrow filter usually means a missing index. On a small table it is often the fastest choice.',
      '`Sort Method: external merge` with `Batches > 1` means the sort did not fit in memory (`work_mem`) and spilled to disk.',
      'Join choice is a cost decision: nested loops suit small inputs, hash joins suit large unsorted ones.',
      '`pg_stat_statements` ranks queries by total time, which tells you where to look first.',
    ],
    interviewQuestions: [
      '"Slow in prod, fast locally": name six causes.',
      'How do you know a plan is wrong rather than the query?',
      'What does a high `Heap Fetches` count tell you?',
      'When would you raise `work_mem`, and when is that the wrong fix?',
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
      'A webhook is a request another company sends you when something happens. You prove it is genuine by signing the body with a shared secret, and you include a timestamp so an old captured request cannot be replayed.',
    keyIdeas: [
      'Sign the timestamp together with the body. Sign the body alone and one captured request stays valid forever.',
      'Reject signatures older than a few minutes. That window is how long a replay is still possible.',
      'Compare signatures in constant time. A normal `===` comparison can leak the answer through how long it takes.',
      'Treat the reply as a signal: 2xx means done, 429 and 5xx mean retry later, any other 4xx means stop.',
      'Send a stable event id so the receiver can recognise a repeat and ignore it.',
      'To rotate a secret, accept the old one for verification while signing with the new one, then retire the old one.',
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
      'Sometimes the other side cannot send you anything, because a firewall blocks inbound traffic. Then you ask on a timer. Done well that means conditional requests and randomised waits; done badly it is a self-inflicted load test.',
    keyIdeas: [
      '`ETag` plus `If-None-Match` lets the server answer "nothing changed" without a body, so the cost follows changes rather than poll frequency.',
      'A long poll keeps the request open for a short while, which reduces delay without needing a socket connection.',
      'Randomise the wait. Without jitter, every client retries at the same moment and the spike is your own doing.',
      'Polling as a webhook fallback needs a stored cursor (how far you got) and a lock, so only one replica polls.',
      'Prefer webhooks for latency and cost. Prefer polling when inbound traffic is impossible.',
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
      'Logs here are structured logging: one JSON object per line, with secrets removed before the line is written and an id that ties every line to one request. The audit log is separate: it is permanent business history, not debugging output.',
    keyIdeas: [
      'Write structured JSON instead of formatted text. You filter and group logs by field; you do not read them line by line.',
      'Give each request its own logger carrying `requestId` and `tenantId`, and pass the same id into job payloads so one story runs from request to delivery.',
      'Redact at the logger, once, so a field someone forgot to hide cannot leak.',
      'In containers, write to stdout and let the platform collect it. Writing to a file inside a container needs rotation, or it fills the disk.',
      'Redis Streams can be replayed and read by several consumers. Pub/Sub cannot, which makes it the wrong tool for logs.',
      'Audit log rows are business records kept for years. Application logs are operational and kept for days.',
      'In this project `requestLogger` writes when the response finishes, pino applies the redaction rules, and `appendLog` appends to `logs:events` capped at about 10,000 entries.',
      'The audit path is `recordAudit()` behind a service, so a future endpoint can record history without writing any SQL.',
    ],
    interviewQuestions: [
      'Logs vs metrics vs traces: what question does each answer?',
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
  {
    id: 'caching',
    order: 15,
    phase: '11c',
    title: 'Caching',
    status: 'live',
    summary:
      'A cache keeps a copy of expensive data closer to the reader, in its own keyspace, so repeated requests can skip the database. The two hard parts are deciding how long a copy may be wrong, and what to do when the cache itself fails.',
    keyIdeas: [
      'Cache-aside means: check the cache, on a miss read the database, store the result with a TTL (time to live, meaning how long the copy is kept), then return it. The application owns the cache; the database does not know it exists.',
      'A cache is a **correctness trade**: you accept serving data that is a little old. The only question is how old, and the TTL answers it.',
      'Delete the key when the data changes, and do it **after** the transaction commits. The TTL is a safety net, not the strategy.',
      'A stampede is many callers missing the same key at once. Single-flight lets one caller load it while the rest wait; across several servers you need a Redis lock or randomised expiry.',
      'Negative caching stores the "not found" answer for a few seconds, so someone guessing ids cannot turn your cache into a database load generator.',
      'A cache must **fail open**: when it is down, read from the database. A cache you cannot live without has become a single point of failure.',
    ],
    interviewQuestions: [
      'Walk me through cache-aside for a read endpoint. Where does invalidation go?',
      'Why invalidate after commit rather than before?',
      'Ten thousand keys expire at the same second. What happens and how do you prevent it?',
      'What is cache penetration, and how is it different from a stampede?',
      'What would you cache in this system, and what would you never cache?',
      'How do you keep the cache consistent across several API replicas?',
      'What happens to your read path when the cache is down?',
    ],
    snippets: [
      {
        label: 'cache-aside with a TTL',
        language: 'ts',
        code: `const key = \`tenant-summary:\${tenantId}\`;

const cached = await cacheGet<TenantSummary>(key);
if (cached) return { ...cached, source: 'cache' };

const summary = await computeSummary(tenantId);   // the expensive query
await cacheSet(key, summary, 30);                 // TTL is a safety net
return { ...summary, source: 'db' };`,
      },
      {
        label: 'single flight for a stampede',
        language: 'ts',
        code: `let pending = inFlight.get(key);
const leader = pending === undefined;

if (!pending) {
  pending = compute(key)
    .then(async (value) => { await cacheSet(key, value, 30); return value; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
}

const value = await pending;   // one database read, many waiters
return { value, source: leader ? 'db' : 'coalesced' };`,
      },
      {
        label: 'cross-process lock (what single-flight cannot do)',
        language: 'ts',
        code: `// SET NX PX is the primitive: only one replica wins the lock.
const won = await redis.set(\`lock:\${key}\`, '1', 'PX', 5000, 'NX');
if (!won) {
  await sleep(50);
  return cacheGet(key);      // re-check, someone else is filling it
}

try {
  const value = await compute(key);
  await cacheSet(key, value, 30);
  return value;
} finally {
  await redis.del(\`lock:\${key}\`);
}`,
      },
      {
        label: 'negative caching',
        language: 'ts',
        code: `const summary = await computeSummary(tenantId);

// 5s, not 30s: the row may be created a moment later.
await cacheSet(key, summary ?? { __missing: true }, summary ? 30 : 5);

return summary;   // null -> 404, but the next request never hits the database`,
      },
    ],
    actions: [
      {
        id: 'cache.hit-miss',
        label: 'Measure a cache miss vs hit',
        description: 'Invalidates, then reads three times: one database computation, two cache hits.',
      },
      {
        id: 'cache.invalidate',
        label: 'Invalidate on write',
        description: 'Warms the key, invalidates it, and shows the next read going back to the database.',
      },
      {
        id: 'cache.stampede',
        label: 'Fire 12 concurrent misses',
        description: 'Single-flight collapses twelve simultaneous misses into one database read.',
      },
      {
        id: 'cache.penetration',
        label: 'Request ids that do not exist',
        description: 'Five requests for a missing tenant: one database read, four negative-cache hits.',
      },
      {
        id: 'cache.staleness',
        label: 'Show stale data after a write',
        description: 'Writes without invalidating, proving the cache serves the old count until cleared.',
      },
      {
        id: 'cache.status',
        label: 'Check the cache service',
        description: 'Reachability, isolation mode, key count and what the fallback is.',
      },
    ],
  },
  {
    id: 'concurrency',
    order: 16,
    phase: '11b',
    title: 'Transactions & isolation',
    status: 'live',
    summary:
      'Two database sessions touching the same row is where the rules become visible. The same counter ends at 5, 1 or 2 depending on the isolation level and the locks you chose. Underneath it all, MVCC keeps several versions of a row so readers never block writers.',
    keyIdeas: [
      '`READ COMMITTED` is the default: every **statement** sees the latest committed data. Two reads in one transaction can disagree, and it does not prevent lost updates.',
      'Read a value into your code, add one, write it back: that is the lost update. `SET value = value + 1` happens inside the database, so it is atomic.',
      '`SELECT ... FOR UPDATE` reserves the row: the second writer waits until the first commits. The lock lasts until the end of the transaction, so keep transactions short.',
      'A deadlock is two transactions each holding what the other needs. PostgreSQL notices after about a second, aborts one with `40P01`, and expects a retry.',
      '`SERIALIZABLE` is optimistic: it lets work run and rejects conflicts with `40001`, so your code must retry the whole transaction with backoff.',
      '`REPEATABLE READ` gives one snapshot for the entire transaction. Reports use it so their own numbers stay consistent.',
    ],
    interviewQuestions: [
      'Two requests increment the same counter and one increment vanishes. Why, and how do you fix it?',
      'What exactly does `SELECT ... FOR UPDATE` lock, and for how long?',
      'How does a deadlock happen, how do you detect it, and how do you prevent it?',
      'Under `SERIALIZABLE`, what error do you get and what must your code do about it?',
      'Which isolation level would you pick for a multi-table report, and why?',
      'Why can adding a retry loop make a hot row worse?',
      'Why is `UPDATE ... SET value = value + 1` safer than reading the value and writing it back?',
    ],
    snippets: [
      {
        label: 'the lost update',
        language: 'sql',
        code: `-- session A                    -- session B
BEGIN;                          BEGIN;
SELECT value FROM counter;      -- 0
                                SELECT value FROM counter; -- 0
UPDATE counter SET value = 1;   -- read 0 + 1
COMMIT;
                                UPDATE counter SET value = 1; -- read 0 + 1
                                COMMIT;
-- final value: 1, not 2`,
      },
      {
        label: 'serialize it with a row lock',
        language: 'sql',
        code: `BEGIN;
SELECT value FROM counter WHERE key = $1 FOR UPDATE; -- B blocks here
UPDATE counter SET value = $2 WHERE key = $1;
COMMIT; -- B proceeds with the committed value`,
      },
      {
        label: 'serializable needs a retry loop',
        language: 'ts',
        code: `for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    await client.query('begin isolation level serializable');
    // ...read, compute, write...
    await client.query('commit');
    return;
  } catch (err) {
    await client.query('rollback');
    if ((err as { code?: string }).code !== '40001' || attempt === 3) throw err;
    await sleep(50 * 2 ** attempt + Math.random() * 50);
  }
}`,
      },
      {
        label: 'same reads, different levels',
        language: 'sql',
        code: `BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT value FROM counter;  -- 0
-- another session commits value = 5
SELECT value FROM counter;  -- 5   (new snapshot per statement)

BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT value FROM counter;  -- 0
-- another session commits value = 5
SELECT value FROM counter;  -- 0   (same snapshot)`,
      },
    ],
    actions: [
      {
        id: 'concurrency.lost-update',
        label: 'Lose an update',
        description: 'Two transactions read 0 and both write 1; the final value is 1, with no error.',
      },
      {
        id: 'concurrency.for-update',
        label: 'Lock the row with FOR UPDATE',
        description: 'The second reader blocks, then reads the committed value; both increments survive.',
      },
      {
        id: 'concurrency.deadlock',
        label: 'Trigger a deadlock',
        description: 'Opposite lock order, one transaction aborted with 40P01.',
      },
      {
        id: 'concurrency.serializable',
        label: 'Force a serialization failure',
        description: 'SERIALIZABLE returns 40001, then a clean retry succeeds.',
      },
      {
        id: 'concurrency.isolation',
        label: 'Compare isolation levels',
        description: 'The same two reads under READ COMMITTED and REPEATABLE READ, side by side.',
      },
    ],
  },
  {
    id: 'capstone',
    order: 17,
    phase: '13',
    title: 'Capstone: operate it',
    status: 'live',
    summary:
      'The earlier cards build the system. This one measures it under load and breaks its dependencies on purpose, so you can talk about observed behaviour instead of a diagram.',
    keyIdeas: [
      'The fast path does no waiting: validate, write, enqueue, return. Time spent talking to a customer endpoint belongs in the worker.',
      'Quote **p99** (the time under which 99% of requests finish). Averages hide the slow tail, and the tail is what people feel and what an SLO (service level objective) is written against.',
      'A connection pool is a queue with a hard limit. When it is full, even `/v1/health` waits, and an orchestrator may restart a container that was only busy.',
      'A Redis outage is not one behaviour: reads keep working, rate limiting fails open, and enqueue fails **after** the transaction committed. That gap is why the outbox pattern exists.',
      'A slow customer endpoint is absorbed by the queue until workers are saturated. After that, delay grows in the queue; it never becomes API latency.',
      'Order of checks during an incident: worker count, queue depth, delivery states, pool counters, table size. Read the logs only after those numbers.',
      'Every number on this card comes from the running system, so you can quote measured latencies rather than guesses.',
    ],
    interviewQuestions: [
      'p99 regressed after a deploy. How do you find the cause, and what do you roll back first?',
      'The delivery queue is backing up. What are the first three things you check?',
      'Redis is down for two minutes. What still works, what fails, and what has to be repaired afterwards?',
      'How do you prove the connection pool is exhausted, from inside the application?',
      'Why is "add more replicas" sometimes the wrong answer to a pool problem?',
      'A customer endpoint consistently takes 30 seconds. What breaks first in your system?',
      'What would you alert on, and at what threshold: queue depth, worker count, or error rate?',
      'Which of these failures would you page someone for at 3am, and which can wait until morning?',
    ],
    snippets: [
      {
        label: 'bounded concurrency for a load test',
        language: 'ts',
        code: `let cursor = 0;
const runners = Array.from({ length: 20 }, async () => {
  for (;;) {
    const index = cursor++;
    if (index >= 200) return;
    await call(index); // at most 20 in flight
  }
});
await Promise.all(runners);`,
      },
      {
        label: 'percentiles, not averages',
        language: 'ts',
        code: `const sorted = latencies.sort((a, b) => a - b);
const p = (q: number) => sorted[Math.ceil((q / 100) * sorted.length) - 1];
console.log({ p50: p(50), p95: p(95), p99: p(99) });`,
      },
      {
        label: 'prove pool saturation',
        language: 'ts',
        code: `const held = [];
for (let i = 0; i < pool.max; i++) held.push(await pool.connect());

const waiter = pool.connect();      // this one is now queued
await sleep(100);
console.log('waiting:', pool.waitingCount); // 1

held.pop().release();               // frees a slot
await waiter;                       // resolves
// finally { held.forEach(c => c.release()) }`,
      },
      {
        label: 'fail-open limiter',
        language: 'ts',
        code: `try {
  count = await redis.incr(key);
} catch {
  return next(); // throttling must not become an outage
}`,
      },
    ],
    actions: [
      {
        id: 'capstone.load',
        label: 'Load test the ingest path',
        description: '200 requests at concurrency 20 through auth, validation, fan-out and enqueue; reports p50/p95/p99.',
      },
      {
        id: 'capstone.pool',
        label: 'Saturate the connection pool',
        description: 'Checks out every pool slot, proves the next caller waits, then frees one and watches it proceed.',
      },
      {
        id: 'capstone.redis-down',
        label: 'Probe a dead Redis',
        description: 'Times a failed connect and maps which features degrade, which fail open and which fail hard.',
      },
      {
        id: 'capstone.slow-receiver',
        label: 'Deliver to a slow receiver',
        description: 'A 2.5s receiver: the API stays fast, the worker absorbs the wait.',
      },
      {
        id: 'capstone.readout',
        label: 'Live system readout',
        description: 'Workers, queue depth, delivery states, attempt timings, pool counters and table sizes in one table.',
      },
    ],
  },
];

export function getTopic(id: string): LabTopic | undefined {
  return topics.find((t) => t.id === id);
}
