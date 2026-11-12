create or replace function public.dashboard_summary_selected_batch(
  p_user_id uuid,
  p_job_ids bigint[],
  p_limit integer default 50
)
returns table(
  job_id bigint,
  observed_job_updated_at timestamptz,
  observed_profile_revision bigint,
  observed_job_revision bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'user_id is required';
  end if;
  if coalesce(cardinality(p_job_ids), 0) > 5000 then
    raise exception 'at most 5000 selected job ids are allowed';
  end if;

  insert into public.dashboard_summary_user_state(user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  return query
    select j.id, j.updated_at, us.profile_revision, coalesce(js.job_revision, 1)
    from (
      select distinct selected.job_id
      from unnest(coalesce(p_job_ids, array[]::bigint[])) as selected(job_id)
      where selected.job_id > 0
    ) requested
    join public.jobs j on j.id = requested.job_id
    join public.dashboard_summary_user_state us on us.user_id = p_user_id
    left join public.dashboard_summary_job_state js
      on js.user_id = p_user_id and js.job_id = j.id
    left join public.dashboard_job_summaries s
      on s.user_id = p_user_id and s.job_id = j.id
    where (j.manual_owner_user_id is null or j.manual_owner_user_id = p_user_id)
      and (s.job_id is null
        or s.job_updated_at is distinct from j.updated_at
        or s.profile_revision is distinct from us.profile_revision
        or s.job_revision is distinct from coalesce(js.job_revision, 1)
        or s.summary_algorithm_version <> 1)
    order by j.id
    limit least(greatest(coalesce(p_limit, 50), 1), 50);
end;
$$;

revoke all on function public.dashboard_summary_selected_batch(uuid,bigint[],integer)
  from public, anon, authenticated;
grant execute on function public.dashboard_summary_selected_batch(uuid,bigint[],integer)
  to service_role;
