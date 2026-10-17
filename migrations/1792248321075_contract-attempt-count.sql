-- Up Migration
alter table app.deliveries
  add constraint deliveries_attempt_count_not_null check (attempt_count is not null) not valid;

alter table app.deliveries validate constraint deliveries_attempt_count_not_null;

alter table app.deliveries alter column attempt_count set default 0;
alter table app.deliveries alter column attempt_count set not null;
alter table app.deliveries drop constraint deliveries_attempt_count_not_null;

alter table app.deliveries
  add constraint deliveries_attempt_count_nonneg check (attempt_count >= 0);

drop trigger deliveries_sync_attempt_count on app.deliveries;
drop function app.deliveries_sync_attempt_count();

alter table app.deliveries drop column attempts_count;

-- Down Migration
alter table app.deliveries add column attempts_count integer;
update app.deliveries set attempts_count = attempt_count;
alter table app.deliveries alter column attempts_count set default 0;
alter table app.deliveries alter column attempts_count set not null;
alter table app.deliveries drop constraint deliveries_attempt_count_nonneg;
alter table app.deliveries drop column attempt_count;