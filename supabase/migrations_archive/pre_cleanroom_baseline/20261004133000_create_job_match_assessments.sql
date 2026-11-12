create table public.job_match_assessments (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id bigint not null references public.jobs(id) on delete restrict,
  candidate_profile_id bigint not null,
  search_profile_id bigint not null,
  evaluation_fingerprint text not null,
  jd_sha256 text not null,
  job_snapshot jsonb not null,
  search_context_snapshot jsonb not null,
  match_score smallint not null,
  recommendation text not null,
  confidence text not null,
  strengths jsonb not null default '[]'::jsonb,
  material_gaps jsonb not null default '[]'::jsonb,
  hard_blockers jsonb not null default '[]'::jsonb,
  summary text not null,
  matcher_version text not null,
  model text not null,
  created_at timestamptz not null default now(),
  constraint job_match_assessments_candidate_profile_user_fk
    foreign key (candidate_profile_id, user_id)
    references public.candidate_profiles(id, user_id) on delete restrict,
  constraint job_match_assessments_search_profile_user_fk
    foreign key (search_profile_id, user_id)
    references public.search_profiles(id, user_id) on delete restrict,
  constraint job_match_assessments_fingerprint_check
    check (evaluation_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint job_match_assessments_jd_sha256_check
    check (jd_sha256 ~ '^[0-9a-f]{64}$'),
  constraint job_match_assessments_job_snapshot_check
    check (jsonb_typeof(job_snapshot) = 'object'),
  constraint job_match_assessments_search_context_snapshot_check
    check (jsonb_typeof(search_context_snapshot) = 'object'),
  constraint job_match_assessments_match_score_check
    check (match_score between 0 and 100),
  constraint job_match_assessments_recommendation_check
    check (recommendation in ('Apply', 'Consider', 'Skip')),
  constraint job_match_assessments_confidence_check
    check (confidence in ('Low', 'Medium', 'High')),
  constraint job_match_assessments_strengths_check
    check (jsonb_typeof(strengths) = 'array'),
  constraint job_match_assessments_material_gaps_check
    check (jsonb_typeof(material_gaps) = 'array'),
  constraint job_match_assessments_hard_blockers_check
    check (jsonb_typeof(hard_blockers) = 'array'),
  constraint job_match_assessments_summary_check
    check (btrim(summary) <> ''),
  constraint job_match_assessments_matcher_version_check
    check (btrim(matcher_version) <> ''),
  constraint job_match_assessments_model_check
    check (btrim(model) <> ''),
  constraint job_match_assessments_user_fingerprint_uq
    unique (user_id, evaluation_fingerprint)
);

create index job_match_assessments_user_job_created_idx
  on public.job_match_assessments (user_id, job_id, created_at desc);

create index job_match_assessments_user_profiles_created_idx
  on public.job_match_assessments
    (user_id, candidate_profile_id, search_profile_id, created_at desc);

alter table public.job_match_assessments enable row level security;

-- The application uses trusted server-side Supabase credentials. Keep browser
-- roles out of this table and its identity sequence.
revoke all on table public.job_match_assessments from anon, authenticated;
grant select, insert, update, delete on table public.job_match_assessments to service_role;
revoke all on sequence public.job_match_assessments_id_seq from anon, authenticated;
grant usage, select, update on sequence public.job_match_assessments_id_seq to service_role;
