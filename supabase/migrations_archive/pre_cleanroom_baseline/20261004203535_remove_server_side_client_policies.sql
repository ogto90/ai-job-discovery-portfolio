-- This is a server-side Streamlit application. Application data access uses
-- the trusted server credential; browser-facing roles must have no policies.
-- Table grants are separately restricted to service_role.
DROP POLICY IF EXISTS applications_owner ON public.applications;
DROP POLICY IF EXISTS candidate_profiles_owner ON public.candidate_profiles;
DROP POLICY IF EXISTS cv_versions_owner ON public.cv_versions;
DROP POLICY IF EXISTS job_evaluations_owner ON public.job_evaluations;
DROP POLICY IF EXISTS job_reviews_owner ON public.job_reviews;
DROP POLICY IF EXISTS jobs_authenticated_read ON public.jobs;
DROP POLICY IF EXISTS search_profiles_owner ON public.search_profiles;
DROP POLICY IF EXISTS search_runs_owner ON public.search_runs;
DROP POLICY IF EXISTS search_run_jobs_owner_read ON public.search_run_jobs;
DROP POLICY IF EXISTS search_run_jobs_owner_insert ON public.search_run_jobs;
DROP POLICY IF EXISTS search_run_jobs_owner_delete ON public.search_run_jobs;
