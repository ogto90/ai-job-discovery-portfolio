-- Fit and Opportunity are evaluated independently. A Fit-only evaluation
-- must be representable without a placeholder Opportunity score.
alter table public.job_evaluations
  alter column opportunity_score drop not null;
