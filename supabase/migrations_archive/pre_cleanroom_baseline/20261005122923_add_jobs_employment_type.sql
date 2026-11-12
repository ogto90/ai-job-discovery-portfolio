-- Preserve the source-provided employment classification for profile-driven
-- eligibility. NULL means the source did not establish a type.
alter table public.jobs
  add column employment_type text;

alter table public.jobs
  add constraint jobs_employment_type_nonblank
  check (employment_type is null or length(btrim(employment_type)) > 0);
