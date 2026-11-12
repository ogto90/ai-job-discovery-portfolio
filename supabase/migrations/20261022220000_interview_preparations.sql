-- A submitted CV is unknown for historical applications until explicitly confirmed.
alter table public.applications
  add column submitted_cv_version_id bigint;

alter table public.applications
  add constraint applications_submitted_cv_user_fk
  foreign key (submitted_cv_version_id, user_id)
  references public.cv_versions(id, user_id) on delete restrict;

alter table public.applications
  add constraint applications_id_user_job_uq unique (id, user_id, job_id);

alter table public.job_match_assessments
  add constraint job_match_assessments_id_user_uq unique (id, user_id);

create table public.interview_preparations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  application_id bigint not null,
  job_id bigint not null references public.jobs(id) on delete restrict,
  idempotency_key uuid not null,
  interview_type text not null,
  interview_datetime timestamptz,
  interviewer_name text,
  interviewer_role text,
  interview_notes text,
  status text not null default 'draft',
  submitted_cv_version_id bigint,
  candidate_profile_id bigint,
  fit_assessment_id bigint,
  source_context jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint interview_preparations_application_user_fk
    foreign key (application_id, user_id, job_id)
    references public.applications(id, user_id, job_id) on delete restrict,
  constraint interview_preparations_cv_user_fk
    foreign key (submitted_cv_version_id, user_id)
    references public.cv_versions(id, user_id) on delete restrict,
  constraint interview_preparations_profile_user_fk
    foreign key (candidate_profile_id, user_id)
    references public.candidate_profiles(id, user_id) on delete restrict,
  constraint interview_preparations_fit_user_fk
    foreign key (fit_assessment_id, user_id)
    references public.job_match_assessments(id, user_id) on delete restrict,
  constraint interview_preparations_type_check check (interview_type in (
    'recruiter', 'hiring_manager', 'technical', 'behavioral', 'leadership_final', 'custom'
  )),
  constraint interview_preparations_status_check check (status in ('draft', 'ready')),
  constraint interview_preparations_context_check check (jsonb_typeof(source_context) = 'object'),
  constraint interview_preparations_idempotency_uq unique (user_id, idempotency_key)
);

create index interview_preparations_application_order_idx
  on public.interview_preparations (user_id, application_id, created_at desc, id desc);

create or replace function public.interview_preparations_guard_update()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if row(new.user_id, new.application_id, new.job_id, new.idempotency_key,
         new.submitted_cv_version_id, new.candidate_profile_id, new.fit_assessment_id,
         new.source_context)
     is distinct from
     row(old.user_id, old.application_id, old.job_id, old.idempotency_key,
         old.submitted_cv_version_id, old.candidate_profile_id, old.fit_assessment_id,
         old.source_context) then
    raise exception 'interview preparation source context is immutable';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

create trigger interview_preparations_guard_update
before update on public.interview_preparations
for each row execute function public.interview_preparations_guard_update();

alter table public.interview_preparations enable row level security;
revoke all on table public.interview_preparations from public, anon, authenticated;
grant select, insert, update on table public.interview_preparations to service_role;
revoke all on function public.interview_preparations_guard_update() from public, anon, authenticated;
grant execute on function public.interview_preparations_guard_update() to service_role;
