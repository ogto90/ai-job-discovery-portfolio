-- Archive suppresses the same requisition on future discovery, just as Ignore did.
create or replace function public.is_suppressed_role(
  p_user_id uuid,
  p_company text,
  p_title text,
  p_source text default null,
  p_source_job_id text default null,
  p_source_url text default null
) returns boolean
language sql stable
set search_path to ''
as $$
  select exists (
    select 1
    from public.jobs h
    left join public.applications a on a.job_id = h.id and a.user_id = p_user_id
    left join public.job_reviews r on r.job_id = h.id and r.user_id = p_user_id
    where (
      (h.source_job_id is not null and p_source_job_id is not null
       and h.source = p_source and h.source_job_id = p_source_job_id)
      or (p_source_url is not null
          and (h.source_url = p_source_url or h.application_url = p_source_url))
      or (h.source_job_id is null and h.source_url is null
          and p_source_job_id is null and p_source_url is null
          and lower(regexp_replace(btrim(h.company), '\s+', ' ', 'g')) =
              lower(regexp_replace(btrim(p_company), '\s+', ' ', 'g'))
          and lower(regexp_replace(btrim(h.title), '\s+', ' ', 'g')) =
              lower(regexp_replace(btrim(p_title), '\s+', ' ', 'g')))
    )
    and (a.status in ('applied', 'interview', 'offer', 'hired', 'rejected',
                      'no_response', 'withdrawn') or r.status in ('ignored', 'archived'))
  );
$$;

update public.job_reviews set status = 'archived' where status = 'ignored';
