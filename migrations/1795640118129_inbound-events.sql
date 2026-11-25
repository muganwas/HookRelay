-- Up Migration
create table app.inbound_events (
  id                uuid primary key default gen_random_uuid(),
  source            text not null,
  provider_event_id text not null,
  payload           jsonb,
  received_at       timestamptz not null default now(),
  constraint inbound_events_unique unique (source, provider_event_id)
);

comment on table app.inbound_events is 'Dedupe ledger for inbound provider webhooks';

-- Down Migration
drop table if exists app.inbound_events;
