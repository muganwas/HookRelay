# HookRelay

Outbound webhook delivery service: accepts events, fans them out to endpoint
subscriptions, signs each request, and retries failures with backoff.

## Stack

- Node 24, TypeScript (strict, ESM)
- Express 5
- PostgreSQL 17 (node-postgres, hand-written SQL) — migrations via node-pg-migrate

## Run locally

    docker compose up -d
    npm install
    cp .env.example .env
    npm run migrate -- up
    npm run dev

Health check: `GET /v1/health`

## Interview labs

Open **http://localhost:3000/labs** — a study guide covering every topic built in
this repo, with one-click demos that run against the real Postgres and Redis.

- 13 topics, each with key ideas, runnable snippets and an interview drill
- 14 demos: constraint probes, migration drift, layer-rule scan, git history,
  queue retries and dedupe, cron claim race, index before/after, query plans,
  HMAC verification, ETag revalidation
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