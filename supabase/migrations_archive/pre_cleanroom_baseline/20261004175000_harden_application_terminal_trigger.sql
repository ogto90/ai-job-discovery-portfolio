-- Keep the trigger function independent of caller-controlled search_path.
create or replace function public.set_application_terminal_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('rejected', 'no_response', 'withdrawn') then
    new.terminal_at := coalesce(
      case when tg_op = 'UPDATE' then old.terminal_at end,
      new.terminal_at,
      now()
    );
  else
    new.terminal_at := null;
  end if;
  return new;
end;
$$;
