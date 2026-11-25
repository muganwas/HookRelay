# HookRelay

Outbound webhook delivery service: accepts events, fans them out to endpoint
subscriptions, signs each request, and retries failures with backoff.

In plain words: a customer tells us "something happened"; we store it, work out
who wants to know, and call each of their URLs with a signed message. If a URL is
down we try again later instead of losing the message.

## What this project is for

This is a study project, not a product. It exists to solve a familiar problem:
backend concepts are easy to read about and much harder to recognise in real code.

So instead of a folder of isolated snippets, the concepts are built into one
small, honest system. A real request path needs middleware, validation, a schema,
migrations, transactions, indexes, a queue, a scheduled job, retries, logs,
caching and polling. Seeing them work together is what shows how they interact,
and where they compete for the same time, memory and locks.

Three rules shape it:

- **Every concept runs.** Each demo executes against the real PostgreSQL and
  Redis containers in this repo and reports measured numbers: p99 latency, rows
  scanned, queue depth, cache hits, lock waits. Nothing is mocked, and no number
  is quoted from memory.
- **Plain language first.** Every topic opens with why the thing exists before
  how it works, abbreviations are expanded on first use, and the prose avoids
  jargon stacked on jargon.
- **The gaps are written down.** What is deliberately not built, and what would
  fail first, lives in [docs/DESIGN.md](./docs/DESIGN.md). Being able to name the
  gaps and the trade-offs is part of the exercise.

Topics covered, in study order: Docker and bootstrap, backend architecture,
Node.js events, PostgreSQL schemas, migrations, Git workflow, middleware, queues,
cron jobs, indexes, query plans, webhooks, polling, logs, caching, transactions
and isolation, and a capstone that measures the whole thing under load.

It is written for people preparing for a backend interview (Node.js, TypeScript,
PostgreSQL, Git, Docker) and for anyone who prefers to learn by running a system
rather than by reading about one.

New to the vocabulary? Every abbreviation used here (TTL, HMAC, ETag, MVCC,
FK, PK, SLO and the rest) is explained in the built-in glossary at
**http://localhost:3000/labs** (the *Glossary* button), and the same text appears
when you hover any dotted-underline word in the labs.

## Stack

- Node 24, TypeScript (strict, ESM)
- Express 5
- PostgreSQL 17 (node-postgres, hand-written SQL): migrations via node-pg-migrate

## Branching model

`main` is the released branch. `development` is the integration branch. Nothing
lands on `main` except through a pull request from `development`.

    main            ← only via PR from development
      └── development        ← integration; all work lands here first
            ├── feat/…       ← one short-lived branch per change
            ├── fix/…
            └── chore/…

Workflow for every change:

    git switch development
    git pull --ff-only
    git switch -c feat/short-description

    # ...commits...

    git switch development
    git merge --no-ff feat/short-description
    git push origin development

Then open a PR from `development` into `main`. `--no-ff` keeps the feature
visible as a bubble in history, so `git log --first-parent development` shows
one line per change instead of every intermediate commit.

Two rules that matter:

- Never commit directly to `main`, and never force-push either shared branch.
- `development` must stay green: run `npm test` before merging into it.

## Run with Docker (recommended)

    docker compose up -d --build

That starts five services:

| Service | What it does |
|---|---|
| `postgres` | Postgres 17, named volume, healthcheck |
| `redis` | Redis 7 with AOF, healthcheck |
| `cache` | a **second, throwaway** Redis for the caching labs (port 6380, no volume) |
| `migrate` | one-shot: applies migrations, then exits 0 |
| `api` | the HTTP server on http://localhost:3000 |
| `worker` | the BullMQ worker, separate process |

`api` and `worker` wait for `migrate` to finish successfully, so a fresh
`docker compose up` never runs against a missing schema.

The `cache` service is deliberately **not** a dependency of `api`: it has no
volume, no `depends_on`, and nothing already working uses it. Stop it with
`docker compose stop cache` and reads keep succeeding from Postgres: that is
the fail-open behaviour the caching card demonstrates.

Useful commands:

    docker compose ps                 # status + health
    docker compose logs -f api        # follow the server
    docker compose logs -f worker     # follow job processing
    docker compose down               # stop (keeps data)
    docker compose down -v            # stop and wipe the volumes

Two demos only work on the host: the **Git** card needs a `git` binary and the
`.git` directory, and the **architecture** card scans `src/` there (in Docker it
scans the compiled `dist/` instead). Both say so in their output.

## Run on the host (for development)

    docker compose up -d postgres redis
    npm install
    cp .env.example .env
    npm run migrate -- up
    npm run dev          # http://localhost:3000
    npm run worker       # second terminal, for queue demos

`npm start` runs the compiled build, so run `npm run build` first.

Health check: `GET /v1/health`

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/events` | API key + `events:write` | ingest, fan out, enqueue (`Idempotency-Key` supported) |
| GET | `/v1/deliveries/:id` | API key + `deliveries:read` | status; supports `?wait=` long-poll and ETag |
| GET | `/v1/deliveries/:id/attempts` | API key + `deliveries:read` | attempt history |
| POST | `/v1/echo` | API key + `echo:write` | scratch endpoint used by the middleware labs |
| POST | `/v1/webhooks/inbound/:source` | HMAC signature | provider-facing receiver with dedupe |
| GET | `/v1/tenants/:id/summary` | API key + `tenants:read` | cached aggregate (`x-cache: hit`/`miss`/`negative`) |
| POST | `/v1/tenants/:id/summary/invalidate` | API key + `tenants:write` | drop the cached aggregate |
| GET | `/v1/health` | none | dependency check |

## Interview labs

Open **http://localhost:3000/labs**: a study guide covering every topic built in
this repo, with one-click demos that run against the real Postgres and Redis.

- 17 topics, each with key ideas, runnable snippets and an interview drill
- a **glossary** of every abbreviation and short form (127 entries, grouped and
  searchable), also shown on hover wherever a term appears in the text
- 54 one-click demos: constraint probes, migration drift, layer-rule scan, EventEmitter
  semantics, queue retries and dedupe, cron claim race, index before/after, query
  plans, log redaction and stream tail, audit writes, API-key auth, rate limiting,
  raw-body hashing, signed end-to-end delivery, inbound dedupe, ETag and long-poll,
  cache hit/miss, invalidation, stampedes, penetration, staleness, lost updates,
  row locks, deadlocks, serialization failures, load percentiles, pool saturation
  and a live system readout
- Progress is stored in localStorage

Architecture, failure modes and trade-offs are written up in
[docs/DESIGN.md](./docs/DESIGN.md).

Some demos need the worker running in a second terminal (`npm run worker`).
The index demos seed ~100k rows and clean up after themselves.

## Tests

    npm test            # topic catalogue + every non-heavy action + HTTP surface
    npm run test:heavy  # seeds 20k rows, builds a real index, cleans up

The suite talks to the containers from `docker compose up -d` and needs `.env`.

## Layout

    src/api.ts      entrypoint: listen + graceful shutdown
    src/app.ts      composition root
    src/infra/      pg pool, redis client, queue connection, fail-open cache client
    src/shared/     errors, request id, error handler, middleware registry
    src/modules/    feature modules (routes -> controller -> service)
    src/modules/labs/  topic content + one-click demo actions
    public/labs/    the study-guide UI (no build step)
    migrations/     forward-only schema migrations
    test/           node:test suites