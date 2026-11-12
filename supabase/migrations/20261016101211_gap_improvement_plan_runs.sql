-- Keep the latest evidence-grounded improvement plan set for each user/profile.
create table public.gap_improvement_plan_runs (
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_profile_id bigint not null,
  plan_version text not null,
  plans jsonb not null,
  generated_at timestamptz not null default now(),
  constraint gap_improvement_plan_runs_profile_user_fk
    foreign key (candidate_profile_id, user_id)
    references public.candidate_profiles(id, user_id) on delete cascade,
  constraint gap_improvement_plan_runs_version_check
    check (btrim(plan_version) <> ''),
  constraint gap_improvement_plan_runs_plans_check
    check (jsonb_typeof(plans) = 'object'),
  primary key (user_id, candidate_profile_id)
);

alter table public.gap_improvement_plan_runs enable row level security;
revoke all on table public.gap_improvement_plan_runs from anon, authenticated;
grant select, insert, update, delete on table public.gap_improvement_plan_runs to service_role;
