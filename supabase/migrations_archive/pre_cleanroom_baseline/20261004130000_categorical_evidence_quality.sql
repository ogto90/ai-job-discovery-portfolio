-- Evidence quality is a categorical evaluator result, not a numeric score.
alter table public.job_evaluations
  drop constraint job_evaluations_evidence_quality_check;

alter table public.job_evaluations
  alter column evidence_quality type text
  using evidence_quality::text;

alter table public.job_evaluations
  add constraint job_evaluations_evidence_quality_check
  check (evidence_quality in ('Low', 'Medium', 'High'));
