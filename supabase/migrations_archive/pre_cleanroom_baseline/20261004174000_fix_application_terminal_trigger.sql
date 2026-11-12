-- Do not reference OLD on INSERT; preserve an existing terminal timestamp only
-- when a terminal application row is being updated.
create or replace function public.set_application_terminal_at()
returns trigger
language plpgsql
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
