# HookRelay

Outbound webhook delivery service: accepts events, fans them out to endpoint
subscriptions, signs each request, and retries failures with backoff.

## Stack

- Node 24, TypeScript (strict, ESM)
- Express 5
- PostgreSQL 17 (node-postgres, hand-written SQL) with three schemas: app, audit, ops

## Run locally

    docker compose up -d
    npm install
    cp .env.example .env
    npm run migrate -- up
    npm run dev

Health check: `GET /v1/health`

## Layout

    src/api.ts      entrypoint: listen + graceful shutdown
    src/app.ts      composition root
    src/infra/      pg pool, redis client
    src/shared/     errors, request id, error handler
    src/modules/    feature modules (routes -> controller -> service)
    migrations/     forward-only schema migrations