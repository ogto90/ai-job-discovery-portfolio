do $$
begin
  if exists (select 1 from public.job_evaluations) then
    raise exception 'job_evaluations must be empty before candidate-profile lineage migration';
  end if;
end;
$$;

create table public.candidate_profiles (
  id bigint generated always as identity primary key,
  cv_version_id bigint not null
    references public.cv_versions(id) on delete restrict,
  schema_version text not null
    check (btrim(schema_version) <> ''),
  parser_version text not null
    check (btrim(parser_version) <> ''),
  model text not null
    check (btrim(model) <> ''),
  input_sha256 text not null
    check (input_sha256 ~ '^[0-9a-f]{64}$'),
  profile_json jsonb not null
    check (jsonb_typeof(profile_json) = 'object'),
  created_at timestamptz not null default now(),
  is_active boolean not null default false
);

comment on table public.candidate_profiles is
  'Immutable, versioned CandidateProfile snapshots generated from CV versions. Application code owns full Pydantic validation before insertion.';
comment on column public.candidate_profiles.schema_version is
  'CandidateProfile data-contract version.';
comment on column public.candidate_profiles.parser_version is
  'Complete extraction and normalization behavior version, including prompt/template configuration.';
comment on column public.candidate_profiles.is_active is
  'At most one profile generation may be active for a CV version; historical generations remain preserved.';

create index candidate_profiles_cv_created_idx
  on public.candidate_profiles (cv_version_id, created_at desc);

create unique index candidate_profiles_one_active_per_cv_uq
  on public.candidate_profiles (cv_version_id)
  where is_active;

alter table public.job_evaluations
  drop constraint job_evaluations_cv_version_id_fkey;

drop index public.job_evaluations_cv_version_idx;

alter table public.job_evaluations
  drop column cv_version_id,
  add column candidate_profile_id bigint not null
    references public.candidate_profiles(id) on delete restrict;

create index job_evaluations_candidate_profile_time_idx
  on public.job_evaluations (candidate_profile_id, evaluated_at desc);

alter table public.job_evaluations
  drop constraint job_evaluations_job_id_fkey;

alter table public.job_evaluations
  add constraint job_evaluations_job_id_fkey
  foreign key (job_id) references public.jobs(id) on delete restrict;

alter table public.candidate_profiles enable row level security;

revoke all on public.candidate_profiles from anon, authenticated;
grant select, insert, update, delete on public.candidate_profiles to service_role;

-- Snapshot fields are intentionally application-layer immutable. The only normal
-- post-insert change is toggling is_active for profile generation selection.
