-- Manual listing checks are user-specific and must not rewrite the shared job
-- lifecycle. A live confirmation can unblock that user's rating workflow.
create table public.user_job_verifications (
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id bigint not null references public.jobs(id) on delete restrict,
  verification_status text not null
    check (verification_status in ('confirmed_live', 'confirmed_closed', 'unable_to_verify')),
  verification_reason text,
  checked_at timestamptz not null default now(),
  primary key (user_id, job_id),
  constraint user_job_verifications_reason_check check (
    verification_status = 'confirmed_live'
    or coalesce(btrim(verification_reason), '') <> ''
  )
);

alter table public.user_job_verifications enable row level security;
revoke all on table public.user_job_verifications from anon, authenticated;
grant select, insert, update, delete on table public.user_job_verifications to service_role;

comment on table public.user_job_verifications is
  'Per-user manual listing checks; does not modify the globally shared jobs availability state.';
