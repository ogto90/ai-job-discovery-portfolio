-- User-scoped workflow milestones and versioned AI interpretations of Fit gaps.
-- Fit assessments and physical jobs remain unchanged.

alter table public.applications
  add column interview_at timestamptz,
  add column offer_at timestamptz,
  add column hired_at timestamptz,
  add column rejected_at timestamptz,
  add column withdrawn_at timestamptz,
  add column status_changed_at timestamptz;

alter table public.job_reviews
  drop constraint job_reviews_status_check,
  add constraint job_reviews_status_check
    check (status in ('interested', 'ignored', 'archived'));

-- A composite reference prevents a gap interpretation from being attached to
-- an assessment belonging to another user/profile/job.
alter table public.job_match_assessments
  add constraint job_match_assessments_lineage_uq
    unique (id, user_id, candidate_profile_id, job_id);

create table public.job_fit_gap_mappings (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_profile_id bigint not null,
  job_id bigint not null references public.jobs(id) on delete restrict,
  assessment_id bigint not null,
  source_gap_id text not null,
  source_gap_text text not null,
  category text not null,
  normalized_key text not null,
  category_description text not null,
  confidence numeric(5,4),
  generalization_version text not null,
  model text not null,
  normalized_at timestamptz not null default now(),
  constraint job_fit_gap_mappings_candidate_user_fk
    foreign key (candidate_profile_id, user_id)
    references public.candidate_profiles(id, user_id) on delete restrict,
  constraint job_fit_gap_mappings_assessment_lineage_fk
    foreign key (assessment_id, user_id, candidate_profile_id, job_id)
    references public.job_match_assessments(id, user_id, candidate_profile_id, job_id)
    on delete restrict,
  constraint job_fit_gap_mappings_source_id_check
    check (btrim(source_gap_id) <> ''),
  constraint job_fit_gap_mappings_source_text_check
    check (btrim(source_gap_text) <> ''),
  constraint job_fit_gap_mappings_category_check
    check (btrim(category) <> ''),
  constraint job_fit_gap_mappings_key_check
    check (normalized_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  constraint job_fit_gap_mappings_description_check
    check (btrim(category_description) <> ''),
  constraint job_fit_gap_mappings_confidence_check
    check (confidence is null or confidence between 0 and 1),
  constraint job_fit_gap_mappings_version_check
    check (btrim(generalization_version) <> ''),
  constraint job_fit_gap_mappings_model_check
    check (btrim(model) <> ''),
  constraint job_fit_gap_mappings_source_version_uq
    unique (user_id, candidate_profile_id, assessment_id, source_gap_id, generalization_version)
);

create index job_fit_gap_mappings_analytics_idx
  on public.job_fit_gap_mappings
    (user_id, candidate_profile_id, generalization_version, normalized_key);

alter table public.job_fit_gap_mappings enable row level security;
revoke all on table public.job_fit_gap_mappings from anon, authenticated;
grant select, insert, update, delete on table public.job_fit_gap_mappings to service_role;
revoke all on sequence public.job_fit_gap_mappings_id_seq from anon, authenticated;
grant usage, select, update on sequence public.job_fit_gap_mappings_id_seq to service_role;
