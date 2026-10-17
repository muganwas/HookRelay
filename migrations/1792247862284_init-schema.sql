-- Up Migration
create schema if not exists app;
create schema if not exists audit;
create schema if not exists ops;

comment on schema app   is 'Business data owned by the service';
comment on schema audit is 'Append-only audit trail, never mutated by the app';
comment on schema ops   is 'Operational bookkeeping: job runs, cursors';

create table app.tenants (
  id         uuid primary key,
  name       text not null,
  created_at timestamptz not null default now(),
  constraint tenants_name_len check (char_length(btrim(name)) between 1 and 100)
);

create table app.api_keys (
  id           uuid primary key,
  tenant_id    uuid not null references app.tenants (id) on delete cascade,
  name         text not null,
  prefix       text not null,
  key_hash     bytea not null,
  scopes       text[] not null default '{}',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint api_keys_hash_unique   unique (key_hash),
  constraint api_keys_prefix_unique unique (prefix)
);

create table app.endpoints (
  id                   uuid primary key,
  tenant_id            uuid not null references app.tenants (id) on delete cascade,
  url                  text not null,
  secret               text not null,
  secret_previous      text,
  subscribed_events    text[] not null default '{}',
  status               text not null default 'active',
  consecutive_failures integer not null default 0,
  disabled_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint endpoints_url_scheme          check (url ~ '^https?://[^\s]+$'),
  constraint endpoints_status_valid        check (status in ('active', 'paused', 'disabled')),
  constraint endpoints_failures_nonneg     check (consecutive_failures >= 0),
  constraint endpoints_tenant_url_unique   unique (tenant_id, url)
);

create table app.events (
  id              uuid primary key,
  tenant_id       uuid not null references app.tenants (id) on delete cascade,
  type            text not null,
  payload         jsonb not null,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  constraint events_idempotency_unique unique (tenant_id, idempotency_key)
);

create table app.deliveries (
  id                   uuid primary key,
  event_id             uuid not null references app.events (id) on delete cascade,
  endpoint_id          uuid not null references app.endpoints (id) on delete cascade,
  status               text not null default 'pending',
  attempts_count       integer not null default 0,
  next_attempt_at      timestamptz,
  last_error           text,
  last_response_status integer,
  finished_at          timestamptz,
  created_at           timestamptz not null default now(),
  constraint deliveries_status_valid check (
    status in ('pending', 'in_progress', 'retrying', 'succeeded', 'dead', 'cancelled')
  ),
  constraint deliveries_attempts_nonneg check (attempts_count >= 0),
  constraint deliveries_event_endpoint_unique unique (event_id, endpoint_id)
);

create table app.delivery_attempts (
  id              bigint generated always as identity primary key,
  delivery_id     uuid not null references app.deliveries (id) on delete cascade,
  attempt_no      integer not null,
  response_status integer,
  response_body   text,
  duration_ms     integer,
  error           text,
  created_at      timestamptz not null default now(),
  constraint delivery_attempts_no_positive check (attempt_no > 0),
  constraint delivery_attempts_unique      unique (delivery_id, attempt_no)
);

create table audit.audit_log (
  id          bigint generated always as identity primary key,
  tenant_id   uuid,                       -- deliberately no FK
  actor       text not null,
  action      text not null,
  entity_type text not null,
  entity_id   text not null,
  diff        jsonb,
  request_id  text,
  created_at  timestamptz not null default now()
);

create table ops.job_runs (
  id              bigint generated always as identity primary key,
  job_name        text not null,
  window_start    timestamptz not null,
  status          text not null default 'running',
  items_processed integer not null default 0,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  error           text,
  constraint job_runs_status_valid check (status in ('running', 'succeeded', 'failed')),
  constraint job_runs_window_unique unique (job_name, window_start)
);

alter database hookrelay set search_path = app, public;
-- Down Migration
alter database hookrelay reset search_path;
drop schema if exists audit cascade;
drop schema if exists ops cascade;
drop schema if exists app cascade;