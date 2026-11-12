alter table public.settings alter column min_match_score set default 60;
update public.settings set min_match_score = 60, updated_at = now() where id = 1;

alter table public.search_runs
  add column discovery_mode text not null default 'targeted'
    check (discovery_mode in ('targeted', 'broad'));

-- Historical decisions may not have a surviving posting URL. Live-source jobs still require one.
alter table public.jobs alter column source_url drop not null;
alter table public.jobs add constraint jobs_live_source_url_required
  check (source = 'manual_history' or source_url is not null);
alter table public.jobs drop constraint jobs_review_status_check;
alter table public.jobs add constraint jobs_review_status_check
  check (review_status in ('new', 'interested', 'ignored', 'rejected'));
create unique index jobs_manual_history_exact_role_uq
  on public.jobs (lower(btrim(company)), lower(btrim(title)))
  where source = 'manual_history';

alter table public.job_evaluations
  add column scoring_version text not null check (btrim(scoring_version) <> ''),
  add column model text not null check (btrim(model) <> ''),
  add column fit_score smallint not null check (fit_score between 0 and 100),
  add column opportunity_score smallint not null check (opportunity_score between 0 and 100),
  add column requirement_coverage smallint not null check (requirement_coverage between 0 and 100),
  add column evidence_quality smallint not null check (evidence_quality between 0 and 100),
  add column hard_gap_count smallint not null check (hard_gap_count >= 0),
  add column confidence numeric(4,3) not null check (confidence between 0 and 1),
  add column requirement_evidence jsonb not null default '[]'::jsonb
    check (jsonb_typeof(requirement_evidence) = 'array');

alter table public.cv_versions
  add column storage_bucket text not null default 'cv-artifacts'
    check (btrim(storage_bucket) <> ''),
  add column is_base boolean not null default false,
  add column is_active boolean not null default false,
  add constraint cv_versions_base_not_job_specific check (not is_base or job_id is null),
  add constraint cv_versions_active_must_be_base check (not is_active or is_base);
create unique index cv_versions_one_active_base_uq
  on public.cv_versions ((1)) where is_base and is_active;

insert into storage.buckets (id, name, public)
values ('cv-artifacts', 'cv-artifacts', false)
on conflict (id) do nothing;

insert into public.jobs (source, company, title, description_kind, availability_status, review_status)
values
  ('manual_history', 'Nebius', 'Security Solutions Engineer', 'missing', 'unknown', 'new'),
  ('manual_history', 'Pliant', 'Security Engineering Manager', 'missing', 'unknown', 'new'),
  ('manual_history', 'Apheris', 'Security Lead', 'missing', 'unknown', 'new'),
  ('manual_history', 'Maze', 'Senior Security Engineer', 'missing', 'unknown', 'new'),
  ('manual_history', 'Tiger Data', 'Senior Security Engineer', 'missing', 'unknown', 'rejected'),
  ('manual_history', '1KOMMA5°', 'Head of Security', 'missing', 'unknown', 'rejected');

insert into public.applications (job_id, status, notes)
select id, 'applied', 'Confirmed application history; application date not provided.'
from public.jobs
where source = 'manual_history'
  and company in ('Nebius', 'Pliant', 'Apheris', 'Maze');

-- A historical role without a requisition ID is matched on company plus exact title.
-- A known historical requisition is matched by source ID or URL within the same company.
create function public.is_suppressed_role(
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
                       'no_response', 'withdrawn') or h.review_status = 'rejected')
      and (
        (h.source_job_id is not null and h.source = p_source
          and h.source_job_id = p_source_job_id)
        or (h.source_url is not null and h.source_url = p_source_url)
        or (h.source_job_id is null and h.source_url is null
          and lower(btrim(h.title)) = lower(btrim(p_title)))
      )
  );
$$;
revoke all on function public.is_suppressed_role(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.is_suppressed_role(text, text, text, text, text)
  to service_role;
