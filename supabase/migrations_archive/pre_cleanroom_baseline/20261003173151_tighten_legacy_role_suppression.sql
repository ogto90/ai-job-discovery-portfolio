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
       and h.source = p_source and h.source_job_id = p_source_job_id)
      or (p_source_url is not null
          and (h.source_url = p_source_url or h.application_url = p_source_url))
      or (
        h.source_job_id is null
        and h.source_url is null
        and h.application_url is null
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
