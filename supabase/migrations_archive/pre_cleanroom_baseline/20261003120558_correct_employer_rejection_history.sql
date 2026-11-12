-- These were applications rejected by employers, not jobs dismissed by the candidate.
update public.jobs
set review_status = 'new'
where source = 'manual_history'
  and review_status = 'rejected'
  and ((company = 'Tiger Data' and title = 'Senior Security Engineer')
    or (company = '1KOMMA5°' and title = 'Head of Security'));

insert into public.applications (job_id, status, notes)
select id, 'rejected', 'Confirmed: applied, then rejected by employer; dates not provided.'
from public.jobs
where source = 'manual_history'
  and ((company = 'Tiger Data' and title = 'Senior Security Engineer')
    or (company = '1KOMMA5°' and title = 'Head of Security'))
on conflict (job_id) do update
set status = excluded.status, notes = excluded.notes, updated_at = now();

alter table public.jobs drop constraint jobs_review_status_check;
alter table public.jobs add constraint jobs_review_status_check
  check (review_status in ('new', 'interested', 'ignored'));

comment on column public.jobs.review_status is
  'Candidate review decision: ignored means dismissed/not interested, not employer rejection.';
comment on column public.applications.status is
  'Application lifecycle: rejected means employer rejected candidate; withdrawn means candidate withdrew.';

create or replace function public.is_suppressed_role(
  p_company text, p_title text, p_source text default null,
  p_source_job_id text default null, p_source_url text default null
) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.jobs h
    left join public.applications a on a.job_id = h.id
    where lower(btrim(h.company)) = lower(btrim(p_company))
      and (a.status in ('applied', 'interview', 'offer', 'hired', 'rejected',
                       'no_response', 'withdrawn') or h.review_status = 'ignored')
      and (
        (h.source_job_id is not null and h.source = p_source
          and h.source_job_id = p_source_job_id)
        or (h.source_url is not null and h.source_url = p_source_url)
        or (h.source_job_id is null and h.source_url is null
          and lower(btrim(h.title)) = lower(btrim(p_title)))
      )
  );
$$;
