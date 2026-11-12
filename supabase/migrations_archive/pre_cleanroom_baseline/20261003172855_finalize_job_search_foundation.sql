alter table public.job_evaluations
  add column cv_version_id bigint not null
    references public.cv_versions(id) on delete restrict;

create index job_evaluations_cv_version_idx
  on public.job_evaluations (cv_version_id, evaluated_at desc);

create or replace function public.set_applications_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = current_timestamp;
  return new;
end;
$$;

drop trigger if exists applications_set_updated_at on public.applications;
create trigger applications_set_updated_at
before update on public.applications
for each row
execute function public.set_applications_updated_at();

alter table public.settings
  add column discovery_modes text[] not null
    default array['targeted', 'broad']::text[],
  add column role_families text[] not null
    default array[
      'Security Engineer', 'Senior Security Engineer', 'Application Security',
      'Product Security', 'Security Lead', 'Security Engineering Lead',
      'Security Engineering Manager', 'Security Manager', 'DevSecOps',
      'Security Architect', 'Security Automation', 'Security Platform',
      'Cloud Security', 'Infrastructure Security', 'IAM Security'
    ]::text[],
  add column excluded_title_patterns text[] not null
    default array['Analyst', 'SOC']::text[],
  add column salary_target_amount numeric(12,2),
  add column salary_target_currency text not null default 'EUR'
    check (btrim(salary_target_currency) <> ''),
  add column salary_target_period text not null default 'annual'
    check (salary_target_period in ('hourly', 'monthly', 'annual')),
  add constraint settings_discovery_modes_check
    check (discovery_modes <@ array['targeted', 'broad']::text[]
      and 'targeted' = any(discovery_modes)
      and 'broad' = any(discovery_modes)),
  add constraint settings_salary_target_amount_check
    check (salary_target_amount is null or salary_target_amount >= 0);

update public.settings
set discovery_modes = array['targeted', 'broad']::text[],
    role_families = array[
      'Security Engineer', 'Senior Security Engineer', 'Application Security',
      'Product Security', 'Security Lead', 'Security Engineering Lead',
      'Security Engineering Manager', 'Security Manager', 'DevSecOps',
      'Security Architect', 'Security Automation', 'Security Platform',
      'Cloud Security', 'Infrastructure Security', 'IAM Security'
    ]::text[],
    excluded_title_patterns = array['Analyst', 'SOC']::text[],
    min_match_score = 60,
    remote_only = true,
    english_only = true,
    updated_at = current_timestamp
where id = 1;

-- Reconciliation-safe suppression rules:
-- 1) A stable source identity (source + source_job_id) is authoritative.
-- 2) An exact source/application URL is authoritative when supplied.
-- 3) Company + normalized exact title is only a legacy fallback when neither side
--    has a stable identifier. A repost with a new ID or URL therefore remains visible.
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
    where (
      (h.source_job_id is not null and p_source_job_id is not null
       and h.source = p_source
       and h.source_job_id = p_source_job_id)
      or (p_source_url is not null
          and (h.source_url = p_source_url or h.application_url = p_source_url))
      or (
        h.source_job_id is null
        and h.source_url is null
        and p_source_job_id is null
        and p_source_url is null
        and lower(regexp_replace(btrim(h.company), '\s+', ' ', 'g')) =
            lower(regexp_replace(btrim(p_company), '\s+', ' ', 'g'))
        and lower(regexp_replace(btrim(h.title), '\s+', ' ', 'g')) =
            lower(regexp_replace(btrim(p_title), '\s+', ' ', 'g'))
      )
    )
    and (a.status in ('applied', 'interview', 'offer', 'hired', 'rejected',
                      'no_response', 'withdrawn') or h.review_status = 'ignored')
  );
$$;
