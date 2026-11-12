-- Store concise, evidence-based Fit explanations alongside the score cache.
-- Existing score-only rows remain valid with empty explanation arrays.

alter table public.job_match_assessments
  add column strengths jsonb not null default '[]'::jsonb,
  add column gaps jsonb not null default '[]'::jsonb;

alter table public.job_match_assessments
  add constraint job_match_assessments_strengths_check
    check (jsonb_typeof(strengths) = 'array'),
  add constraint job_match_assessments_gaps_check
    check (jsonb_typeof(gaps) = 'array');
