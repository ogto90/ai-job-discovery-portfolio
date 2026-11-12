-- Preserve deterministic decimal evaluation metrics without lossy rounding.
alter table public.job_evaluations
  alter column fit_score type numeric(5,2) using fit_score::numeric,
  alter column opportunity_score type numeric(5,2) using opportunity_score::numeric,
  alter column requirement_coverage type numeric(5,2) using requirement_coverage::numeric,
  alter column confidence type numeric(5,4) using confidence::numeric;
