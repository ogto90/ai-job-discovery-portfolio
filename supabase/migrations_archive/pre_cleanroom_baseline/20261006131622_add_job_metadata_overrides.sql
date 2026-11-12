-- User corrections are separate from globally shared source-ingested job data.
create table public.job_metadata_overrides (
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id bigint not null references public.jobs(id) on delete restrict,
  company_override text,
  title_override text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, job_id),
  constraint job_metadata_overrides_nonempty_check
    check (company_override is not null or title_override is not null),
  constraint job_metadata_overrides_company_check
    check (company_override is null or (
      company_override = btrim(company_override)
      and char_length(company_override) between 1 and 140
      and company_override !~ E'[\r\n]'
    )),
  constraint job_metadata_overrides_title_check
    check (title_override is null or (
      title_override = btrim(title_override)
      and char_length(title_override) between 1 and 180
      and title_override !~ E'[\r\n]'
    ))
);

create trigger job_metadata_overrides_set_updated_at
before update on public.job_metadata_overrides
for each row execute function public.set_user_owned_updated_at();

alter table public.job_metadata_overrides enable row level security;

revoke all on table public.job_metadata_overrides from public, anon, authenticated;
grant select, insert, update, delete on table public.job_metadata_overrides to service_role;
