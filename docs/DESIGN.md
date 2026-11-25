# HookRelay: design notes

What the system does, how it fails, and why the pieces are shaped this way.
Written to be defended in a design review, not to describe the file tree.

If a word here is unfamiliar, the labs have a glossary of every abbreviation and
short form: **http://localhost:3000/labs** → *Glossary*.

## Problem

Accept events over HTTP, deliver them to customer endpoints as signed webhooks,
retry failures, and stay observable and recoverable throughout.

In plain words: someone sends us "this happened". We save it, decide who is
subscribed, and call their URL with a signature. If the call fails we keep trying
on a schedule, and we keep a permanent record of what happened either way.

The hard requirements are the ones that shape everything else:

- **At-least-once delivery.** A webhook must not be silently dropped.
- **Idempotency at the edges.** Both our ingest and the customer's receiver will
  see duplicates; both need a stable key.
- **The API must not wait on customers.** A 30-second receiver cannot become a
  30-second request.
- **Money-grade audit.** What changed, who changed it, and when, independent of
  operational logs.

## Request path

```
POST /v1/events
  requestId -> requestLogger -> json(verify: rawBody) -> auth -> rateLimit -> validate
    -> createEvent
         BEGIN
           INSERT app.events      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
           SELECT endpoints       WHERE type = ANY(subscribed_events) AND status = 'active'
           INSERT app.deliveries  ON CONFLICT (event_id, endpoint_id) DO NOTHING
         COMMIT
         enqueue(deliveryId) x N        <- after commit, never inside it
  202 { eventId, deliveryIds, deduped }
```

Two ordering decisions carry the design:

1. **Enqueue after commit.** A worker must never receive a job for a row that
   rolled back.
2. **Claim, then work.** The cron path inserts `(job_name, window_start)` before
   doing anything, so the unique constraint decides which replica runs.

## Delivery path

```
worker (separate process)
  job(deliveryId)
    load delivery + event + endpoint
    if delivery.status = 'succeeded' -> return        (replay safety)
    body = canonical JSON
    signature = HMAC-SHA256(secret, `${t}.${body}`)
    POST endpoint.url     10s AbortController, redirect: manual
    classify: 2xx success | 429/5xx retry | other 4xx dead
    record attempt + update delivery + endpoint counters
    throw  -> BullMQ retries with exponential backoff
```

Classification is the part that is usually wrong in real systems: retrying a
`401` nine times is pure waste, and dropping a `429` loses a recoverable
delivery.

## Data model

| Schema | Table | Why it exists |
|---|---|---|
| `app` | `tenants`, `api_keys`, `endpoints` | identity and subscriptions |
| `app` | `events`, `deliveries`, `delivery_attempts` | the work itself |
| `app` | `inbound_events` | dedupe ledger for provider webhooks |
| `audit` | `audit_log` | append-only business record, no FK to tenants |
| `ops` | `job_runs` | cron claim + run history |

Three schemas because permissions and retention differ, not for tidiness:
`audit_log` is insert-only and kept for years, `job_runs` is pruned in weeks.

Ids: UUIDs on externally visible rows (unguessable, non-enumerable),
`bigint identity` on high-volume internal rows (`delivery_attempts`) because
8 bytes beats 16 in every index that references it.

## Failure modes

| Failure | What happens | Why that is acceptable |
|---|---|---|
| Receiver returns 500 | Retried up to 5 attempts with doubling backoff, then `dead` | The delivery is not lost; it is visible as dead |
| Receiver returns 400 | `UnrecoverableError`, dead immediately | Repeating a deterministic failure only burns attempts |
| Worker killed mid-job | Job stays `active`; BullMQ's stalled check re-delivers it | At-least-once; the processor skips `succeeded` rows |
| Redis down | Reads keep working; limiter fails open; **enqueue fails after commit** | Known gap: see below |
| Pool saturated | Everything using the pool queues, including health checks | Health checks should use a separate small pool |
| Duplicate inbound webhook | `ON CONFLICT DO NOTHING` on `(source, provider_event_id)` | 200 `duplicate: true` tells the provider to stop retrying |
| Clock skew | Signature rejected outside a 300s window | The timestamp is inside the signed string |
| Cache down | Summary reads fall through to Postgres, slower but correct | The cache is an optimisation, so it fails open |

### The gap worth naming: enqueue after commit

If Redis is unavailable between `COMMIT` and `enqueue`, the event and its
delivery rows exist but no job does. The delivery sits in `pending` forever.

The fix is the **transactional outbox**: write the job intent into the same
transaction (an `outbox` table), and let a relay read unprocessed rows and
publish them. Delivery then becomes at-least-once from the database, not from
the queue. This build does not implement it; the `retry-sweeper` cron is the
partial mitigation (it can find stuck rows, but it does not currently re-enqueue).

## Caching

`GET /v1/tenants/:id/summary` is cache-aside: Redis, then Postgres, then a
30-second TTL. Three decisions are deliberate:

- **Its own service.** `cache` is a second Redis in compose (port 6380, no
  volume). Nothing else uses it, so the caching labs cannot corrupt queues,
  idempotency keys or the log stream. When `CACHE_URL` is unset the client falls
  back to the main Redis on **db 1**, so host development and the test suite work
  without the extra container.
- **Fail open.** Every cache call is wrapped: a connection error returns a miss.
  A dead cache costs latency, never availability.
- **Two TTLs.** 30s for a real summary, 5s for a *negative* entry, so ids that do
  not exist cannot be used to turn the cache into a database load generator.

Single-flight (`Map<key, Promise>`) collapses concurrent misses inside one
process. It does not span replicas: that needs `SET NX PX` in Redis, which the
caching card shows as a snippet and names as the gap.

## Observability

- **Logs:** pino JSON, redaction inside the logger, correlation id propagated
  from `x-request-id` into job payloads.
- **Log fan-out:** Redis Streams with `MAXLEN ~ 10000`, replayable, unlike
  Pub/Sub.
- **Audit:** separate table, separate retention, written through a service.
- **Health:** `/v1/health` measures Postgres and Redis separately and names the
  failing dependency.

## Measured behaviour

From the capstone card, with the API and worker in containers on one machine:

- ingest p50/p95/p99 under 200 requests at concurrency 20
- pool saturation blocks the 11th caller when `max = 10`
- a 2.5s receiver leaves the API response in the low tens of milliseconds
- a dead Redis fails a connection attempt in well under a second

These are shapes, not benchmarks: the load client and the server share one CPU.

## Deliberately not built

- **Outbox relay** for the enqueue-after-commit gap.
- **Secret rotation**: `endpoints.secret_previous` exists, unused.
- **SSRF protection**: no private-IP blocking on endpoint URLs.
- **Replay endpoint**: dead deliveries cannot be re-queued from the API.
- **Per-tenant fairness**: one noisy tenant can occupy all workers.
- **Multi-region**: no locality or failover story.

Being able to name these, and say what you would do first, is worth more in an
interview than pretending the system is finished.
