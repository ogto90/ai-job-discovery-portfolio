-- Establish user ownership while keeping jobs globally shared.
-- Storage object copying is intentionally separate because PostgreSQL cannot
-- transactionally move bytes in Supabase Storage.

do $$
begin
  if (select count(*) from auth.users) <> 1 then
    raise exception 'Expected exactly one Auth user before ownership migration';
  end if;
end;
$$;

create table public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_enabled boolean not null default false,
  email_recipient text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not email_enabled or coalesce(btrim(email_recipient), '') <> '')
);

create table public.search_profiles (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  min_fit_score smallint not null default 0 check (min_fit_score between 0 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
);

create index search_profiles_user_active_idx
  on public.search_profiles (user_id, is_active, updated_at desc);

alter table public.cv_versions add column user_id uuid;
update public.cv_versions set user_id = (select id from auth.users);
alter table public.cv_versions alter column user_id set not null;
alter table public.cv_versions
  add constraint cv_versions_user_fk foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.cv_versions add constraint cv_versions_id_user_uq unique (id, user_id);

drop index public.cv_versions_one_active_base_uq;
create unique index cv_versions_one_active_base_per_user_uq
  on public.cv_versions (user_id) where is_base and is_active;
create index cv_versions_user_created_idx
  on public.cv_versions (user_id, created_at desc);

alter table public.candidate_profiles add column user_id uuid;
update public.candidate_profiles set user_id = (select id from auth.users);
alter table public.candidate_profiles alter column user_id set not null;
alter table public.candidate_profiles
  add constraint candidate_profiles_user_fk foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.candidate_profiles drop constraint candidate_profiles_cv_version_id_fkey;
alter table public.candidate_profiles
  add constraint candidate_profiles_cv_user_fk
  foreign key (cv_version_id, user_id)
  references public.cv_versions(id, user_id) on delete restrict;
alter table public.candidate_profiles add constraint candidate_profiles_id_user_uq unique (id, user_id);
create index candidate_profiles_user_created_idx
  on public.candidate_profiles (user_id, created_at desc);

alter table public.applications add column user_id uuid;
update public.applications set user_id = (select id from auth.users);
alter table public.applications alter column user_id set not null;
alter table public.applications
  add constraint applications_user_fk foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.applications drop constraint applications_job_id_key;
alter table public.applications add constraint applications_user_job_uq unique (user_id, job_id);
alter table public.applications drop constraint applications_cv_version_id_fkey;
alter table public.applications
  add constraint applications_cv_user_fk
  foreign key (cv_version_id, user_id)
  references public.cv_versions(id, user_id) on delete restrict;
create index applications_user_status_updated_idx
  on public.applications (user_id, status, updated_at desc);

alter table public.search_runs add column user_id uuid;
alter table public.search_runs add column search_profile_id bigint;
alter table public.search_runs add column search_profile_snapshot jsonb;
alter table public.search_runs add constraint search_runs_snapshot_object_check
  check (search_profile_snapshot is null or jsonb_typeof(search_profile_snapshot) = 'object');
update public.search_runs set user_id = (select id from auth.users);
alter table public.search_runs alter column user_id set not null;
alter table public.search_runs alter column search_profile_snapshot set default '{}'::jsonb;
alter table public.search_runs alter column search_profile_snapshot set not null;
alter table public.search_runs
  add constraint search_runs_user_fk foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.search_runs
  add constraint search_runs_profile_user_fk
  foreign key (search_profile_id, user_id)
  references public.search_profiles(id, user_id) on delete restrict;
create index search_runs_user_started_idx
  on public.search_runs (user_id, started_at desc);
create index search_runs_profile_started_idx
  on public.search_runs (search_profile_id, started_at desc);

alter table public.job_evaluations add column user_id uuid;
alter table public.job_evaluations add column search_profile_id bigint;
alter table public.job_evaluations add column search_profile_snapshot jsonb;
alter table public.job_evaluations add constraint job_evaluations_snapshot_object_check
  check (search_profile_snapshot is null or jsonb_typeof(search_profile_snapshot) = 'object');
update public.job_evaluations set user_id = (select id from auth.users);
alter table public.job_evaluations alter column user_id set not null;
alter table public.job_evaluations alter column search_profile_snapshot set default '{}'::jsonb;
alter table public.job_evaluations alter column search_profile_snapshot set not null;
alter table public.job_evaluations
  add constraint job_evaluations_user_fk foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.job_evaluations
  add constraint job_evaluations_profile_user_fk
  foreign key (search_profile_id, user_id)
  references public.search_profiles(id, user_id) on delete restrict;
alter table public.job_evaluations drop column match_score;
create index job_evaluations_user_job_time_idx
  on public.job_evaluations (user_id, job_id, evaluated_at desc);
create index job_evaluations_profile_time_idx
  on public.job_evaluations (user_id, search_profile_id, evaluated_at desc);

-- Review decisions are user-specific; jobs remain global.
create table public.job_reviews (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id bigint not null references public.jobs(id) on delete restrict,
  status text not null check (status in ('interested', 'ignored')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, job_id)
);
create index job_reviews_user_status_idx
  on public.job_reviews (user_id, status, updated_at desc);
insert into public.job_reviews (user_id, job_id, status)
select (select id from auth.users), id, review_status
from public.jobs
where review_status in ('interested', 'ignored');
alter table public.jobs drop constraint jobs_review_status_check;
drop index public.jobs_review_seen_idx;
alter table public.jobs drop column review_status;

-- Discovery is many-to-many: the same global job may appear in many runs.
alter table public.jobs drop constraint jobs_search_run_id_fkey;
drop index public.jobs_search_run_idx;
alter table public.jobs drop column search_run_id;
create table public.search_run_jobs (
  search_run_id bigint not null references public.search_runs(id) on delete cascade,
  job_id bigint not null references public.jobs(id) on delete restrict,
  discovered_at timestamptz not null default now(),
  discovery_context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(discovery_context) = 'object'),
  primary key (search_run_id, job_id)
);
create index search_run_jobs_job_idx on public.search_run_jobs (job_id, discovered_at desc);

-- Seed the first user-owned profile from the existing single-user settings row.
with inserted_profile as (
  insert into public.search_profiles (user_id, name, definition, min_fit_score)
  select u.id,
         'Cybersecurity leadership',
         jsonb_build_object(
           'target_titles', s.target_roles,
           'role_families', s.role_families,
           'discovery_modes', s.discovery_modes,
           'remote_only', s.remote_only,
           'english_only', s.english_only,
           'excluded_title_patterns', s.excluded_title_patterns,
           'salary', jsonb_build_object(
             'target', s.salary_target_amount,
             'currency', s.salary_target_currency,
             'period', s.salary_target_period
           ),
           'eligibility_constraints', jsonb_build_object(
             'remote_scope', 'Austria/EU/EEA/EMEA/Europe/worldwide'
           )
         ),
         s.min_match_score
  from auth.users u cross join public.settings s
  where s.id = 1
  returning user_id
)
insert into public.user_preferences (user_id, email_enabled, email_recipient)
select u.id, s.email_enabled, s.email_recipient
from auth.users u cross join public.settings s
where s.id = 1
  and exists (select 1 from inserted_profile p where p.user_id = u.id);

drop table public.settings;

-- User-owned timestamp maintenance.
create or replace function public.set_user_owned_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = current_timestamp;
  return new;
end;
$$;

drop trigger if exists user_preferences_set_updated_at on public.user_preferences;
create trigger user_preferences_set_updated_at before update on public.user_preferences
for each row execute function public.set_user_owned_updated_at();
drop trigger if exists search_profiles_set_updated_at on public.search_profiles;
create trigger search_profiles_set_updated_at before update on public.search_profiles
for each row execute function public.set_user_owned_updated_at();
drop trigger if exists job_reviews_set_updated_at on public.job_reviews;
create trigger job_reviews_set_updated_at before update on public.job_reviews
for each row execute function public.set_user_owned_updated_at();

-- Same-user suppression; the old unscoped function would leak one user's history.
drop function public.is_suppressed_role(text, text, text, text, text);
create function public.is_suppressed_role(
  p_user_id uuid, p_company text, p_title text, p_source text default null,
  p_source_job_id text default null, p_source_url text default null
) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.jobs h
    left join public.applications a on a.job_id = h.id and a.user_id = p_user_id
    left join public.job_reviews r on r.job_id = h.id and r.user_id = p_user_id
    where (
      (h.source_job_id is not null and p_source_job_id is not null
       and h.source = p_source and h.source_job_id = p_source_job_id)
      or (p_source_url is not null
          and (h.source_url = p_source_url or h.application_url = p_source_url))
      or (h.source_job_id is null and h.source_url is null
          and p_source_job_id is null and p_source_url is null
          and lower(regexp_replace(btrim(h.company), '\s+', ' ', 'g')) =
              lower(regexp_replace(btrim(p_company), '\s+', ' ', 'g'))
          and lower(regexp_replace(btrim(h.title), '\s+', ' ', 'g')) =
              lower(regexp_replace(btrim(p_title), '\s+', ' ', 'g')))
    )
    and (a.status in ('applied', 'interview', 'offer', 'hired', 'rejected',
                      'no_response', 'withdrawn') or r.status = 'ignored')
  );
$$;

-- RLS and grants: no anonymous access; authenticated access is ownership-bound.
alter table public.user_preferences enable row level security;
alter table public.search_profiles enable row level security;
alter table public.search_runs enable row level security;
alter table public.search_run_jobs enable row level security;
alter table public.cv_versions enable row level security;
alter table public.candidate_profiles enable row level security;
alter table public.job_evaluations enable row level security;
alter table public.applications enable row level security;
alter table public.job_reviews enable row level security;

revoke all on public.user_preferences, public.search_profiles, public.search_runs,
  public.search_run_jobs, public.cv_versions, public.candidate_profiles,
  public.job_evaluations, public.applications, public.job_reviews
  from anon, authenticated;
revoke all on sequence public.search_profiles_id_seq, public.job_reviews_id_seq
  from anon, authenticated;
grant select on public.jobs to authenticated;
grant select, insert, update, delete on public.user_preferences, public.search_profiles,
  public.search_runs, public.search_run_jobs, public.cv_versions,
  public.candidate_profiles, public.job_evaluations, public.applications, public.job_reviews
  to authenticated;
grant usage, select, update on sequence public.search_profiles_id_seq,
  public.search_runs_id_seq, public.applications_id_seq, public.cv_versions_id_seq,
  public.candidate_profiles_id_seq, public.job_evaluations_id_seq, public.job_reviews_id_seq
  to authenticated;
grant select, insert, update, delete on public.user_preferences, public.search_profiles,
  public.search_runs, public.search_run_jobs, public.cv_versions,
  public.candidate_profiles, public.job_evaluations, public.applications, public.job_reviews
  to service_role;
grant usage, select, update on sequence public.search_profiles_id_seq,
  public.job_reviews_id_seq to service_role;

create policy user_preferences_owner on public.user_preferences for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy search_profiles_owner on public.search_profiles for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy search_runs_owner on public.search_runs for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy cv_versions_owner on public.cv_versions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy candidate_profiles_owner on public.candidate_profiles for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy job_evaluations_owner on public.job_evaluations for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy applications_owner on public.applications for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy job_reviews_owner on public.job_reviews for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy jobs_authenticated_read on public.jobs for select to authenticated
  using (true);
create policy search_run_jobs_owner_read on public.search_run_jobs for select to authenticated
  using (exists (select 1 from public.search_runs r where r.id = search_run_id and r.user_id = (select auth.uid())));
create policy search_run_jobs_owner_insert on public.search_run_jobs for insert to authenticated
  with check (exists (select 1 from public.search_runs r where r.id = search_run_id and r.user_id = (select auth.uid())));
create policy search_run_jobs_owner_delete on public.search_run_jobs for delete to authenticated
  using (exists (select 1 from public.search_runs r where r.id = search_run_id and r.user_id = (select auth.uid())));

-- Future Storage access is user-path scoped. Existing objects remain at their
-- old paths until the separate verified byte-copy step completes.
create policy cv_artifacts_authenticated_read on storage.objects for select to authenticated
  using (bucket_id = 'cv-artifacts' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy cv_artifacts_authenticated_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'cv-artifacts' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy cv_artifacts_authenticated_update on storage.objects for update to authenticated
  using (bucket_id = 'cv-artifacts' and split_part(name, '/', 1) = (select auth.uid())::text)
  with check (bucket_id = 'cv-artifacts' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy cv_artifacts_authenticated_delete on storage.objects for delete to authenticated
  using (bucket_id = 'cv-artifacts' and split_part(name, '/', 1) = (select auth.uid())::text);

revoke all on function public.is_suppressed_role(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.is_suppressed_role(uuid, text, text, text, text, text)
  to service_role;
