-- Up Migration
alter table app.deliveries add column if not exists attempt_count integer;

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
$$;

create trigger deliveries_sync_attempt_count
before insert or update on app.deliveries
for each row execute function app.deliveries_sync_attempt_count();

-- Down Migration
drop trigger if exists deliveries_sync_attempt_count on app.deliveries;
drop function if exists app.deliveries_sync_attempt_count();
alter table app.deliveries drop column if exists attempt_count;