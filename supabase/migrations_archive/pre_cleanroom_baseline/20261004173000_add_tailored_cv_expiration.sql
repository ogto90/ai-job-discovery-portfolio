-- Retain tailored-CV lineage while allowing their private artifacts to expire.
-- Base CVs always keep both lifecycle fields NULL.

alter table public.cv_versions
  add column expires_at timestamptz,
  add column artifacts_deleted_at timestamptz;

alter table public.cv_versions
  add constraint cv_versions_artifact_expiration_check
  check (
    (is_base and expires_at is null and artifacts_deleted_at is null)
    or not is_base
  );

create index cv_versions_tailored_expiry_idx
  on public.cv_versions (user_id, expires_at)
  where not is_base and artifacts_deleted_at is null and expires_at is not null;

alter table public.applications
  add column terminal_at timestamptz;

create or replace function public.set_application_terminal_at()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('rejected', 'no_response', 'withdrawn') then
    new.terminal_at := coalesce(old.terminal_at, new.terminal_at, now());
  else
    new.terminal_at := null;
  end if;
  return new;
end;
$$;

create trigger applications_set_terminal_at
before insert or update of status on public.applications
for each row execute function public.set_application_terminal_at();

update public.applications
set terminal_at = coalesce(terminal_at, updated_at)
where status in ('rejected', 'no_response', 'withdrawn')
  and terminal_at is null;
