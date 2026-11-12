-- Search runs and evaluations are historical snapshots of a concrete profile.
alter table public.search_runs
  alter column search_profile_id set not null;

alter table public.job_evaluations
  alter column search_profile_id set not null;

-- Future user-owned CV artifacts use <user_id>/base/.... Tailored artifacts
-- should use <user_id>/tailored/<job-id>/.... This deployment is intentionally
-- server-side only, so browser roles stay out of application tables, identity
-- sequences, and private CV objects.
revoke all on table
  public.jobs,
  public.applications,
  public.cv_versions,
  public.candidate_profiles,
  public.job_evaluations,
  public.search_runs,
  public.search_profiles,
  public.user_preferences,
  public.job_reviews,
  public.search_run_jobs
from anon, authenticated;

revoke all on sequence
  public.jobs_id_seq,
  public.applications_id_seq,
  public.cv_versions_id_seq,
  public.candidate_profiles_id_seq,
  public.job_evaluations_id_seq,
  public.search_runs_id_seq,
  public.search_profiles_id_seq,
  public.job_reviews_id_seq
from anon, authenticated;

drop policy if exists cv_artifacts_authenticated_read on storage.objects;
drop policy if exists cv_artifacts_authenticated_insert on storage.objects;
drop policy if exists cv_artifacts_authenticated_update on storage.objects;
drop policy if exists cv_artifacts_authenticated_delete on storage.objects;
