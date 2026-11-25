-- Up Migration
create table ops.lab_counter (
  key        text primary key,
  value      integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on table ops.lab_counter is 'Scratch counters for the concurrency labs';

-- Down Migration
drop table if exists ops.lab_counter;