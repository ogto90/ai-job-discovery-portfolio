revoke all on sequence
  public.applications_id_seq,
  public.candidate_profiles_id_seq,
  public.cv_versions_id_seq,
  public.job_evaluations_id_seq,
  public.jobs_id_seq,
  public.search_runs_id_seq
from anon, authenticated;

grant usage, select, update on sequence
  public.applications_id_seq,
  public.candidate_profiles_id_seq,
  public.cv_versions_id_seq,
  public.job_evaluations_id_seq,
  public.jobs_id_seq,
  public.search_runs_id_seq
to service_role;

-- Application migrations create public objects as postgres. Keep future tables
-- and identity sequences inaccessible to browser roles by default. The existing
-- service_role defaults are preserved.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
