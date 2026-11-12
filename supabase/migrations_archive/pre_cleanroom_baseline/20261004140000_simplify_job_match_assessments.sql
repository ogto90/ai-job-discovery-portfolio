-- Replace the legacy holistic assessment contract with the score-only Fit cache.
-- The single holistic_match_v1 row was archived locally before this migration.

do $$
declare
  legacy_count integer;
begin
  select count(*) into legacy_count
  from public.job_match_assessments
  where matcher_version = 'holistic_match_v1';

  if legacy_count <> 1 then
    raise exception 'Expected exactly one legacy holistic_match_v1 row before cleanup; found %', legacy_count;
  end if;

  delete from public.job_match_assessments
  where matcher_version = 'holistic_match_v1';
end;
$$;

alter table public.job_match_assessments
  drop constraint job_match_assessments_search_profile_user_fk,
  drop constraint job_match_assessments_search_context_snapshot_check,
  drop constraint job_match_assessments_recommendation_check,
  drop constraint job_match_assessments_confidence_check,
  drop constraint job_match_assessments_strengths_check,
  drop constraint job_match_assessments_material_gaps_check,
  drop constraint job_match_assessments_hard_blockers_check,
  drop constraint job_match_assessments_summary_check;

drop index public.job_match_assessments_user_profiles_created_idx;

alter table public.job_match_assessments
  drop column search_profile_id,
  drop column search_context_snapshot,
  drop column recommendation,
  drop column confidence,
  drop column strengths,
  drop column material_gaps,
  drop column hard_blockers,
  drop column summary;

alter table public.job_match_assessments
  rename column match_score to fit_score;

alter table public.job_match_assessments
  drop constraint job_match_assessments_match_score_check;

alter table public.job_match_assessments
  add constraint job_match_assessments_fit_score_check
    check (fit_score between 0 and 100);

create index job_match_assessments_user_candidate_created_idx
  on public.job_match_assessments (user_id, candidate_profile_id, created_at desc);
