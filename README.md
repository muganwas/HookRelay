# HookRelay

Outbound webhook delivery service: accepts events, fans them out to endpoint
subscriptions, signs each request, and retries failures with backoff.

## Stack

- Node 24, TypeScript (strict, ESM)
- Express 5
- PostgreSQL 17 (node-postgres, hand-written SQL) — migrations via node-pg-migrate

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

That starts four services:

| Service | What it does |
|---|---|
| `postgres` | Postgres 17, named volume, healthcheck |
| `redis` | Redis 7 with AOF, healthcheck |
| `migrate` | one-shot: applies migrations, then exits 0 |
| `api` | the HTTP server on http://localhost:3000 |
| `worker` | the BullMQ worker, separate process |

`api` and `worker` wait for `migrate` to finish successfully, so a fresh
`docker compose up` never runs against a missing schema.

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

## Interview labs

Open **http://localhost:3000/labs** — a study guide covering every topic built in
this repo, with one-click demos that run against the real Postgres and Redis.

- 14 topics, each with key ideas, runnable snippets and an interview drill
- 31 one-click demos: constraint probes, migration drift, layer-rule scan, EventEmitter
  semantics, queue retries and dedupe, cron claim race, index before/after, query
  plans, log redaction and stream tail, audit writes, HMAC verification, ETag revalidation
- Progress is stored in localStorage

Some demos need the worker running in a second terminal (`npm run worker`).
The index demos seed ~100k rows and clean up after themselves.

## Tests

    npm test            # topic catalogue + every non-heavy action + HTTP surface
    npm run test:heavy  # seeds 20k rows, builds a real index, cleans up

The suite talks to the containers from `docker compose up -d` and needs `.env`.

## Layout

    src/api.ts      entrypoint: listen + graceful shutdown
    src/app.ts      composition root
    src/infra/      pg pool, redis client, queue connection
    src/shared/     errors, request id, error handler, middleware registry
    src/modules/    feature modules (routes -> controller -> service)
    src/modules/labs/  topic content + one-click demo actions
    public/labs/    the study-guide UI (no build step)
    migrations/     forward-only schema migrations
    test/           node:test suites