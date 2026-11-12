-- All writes use disposable synthetic data only.
do $$
declare
  u uuid := '00000000-0000-0000-0000-000000000001';
  stamp timestamptz;
  before_summary jsonb;
  stale_payload jsonb;
  outcome jsonb;
  changed_count integer;
begin
  select summary_input_updated_at into stamp from public.jobs where id=2;
  select summary into before_summary from public.dashboard_job_summaries where user_id=u and job_id=2;
  if exists(select 1 from public.dashboard_summary_selected_batch(u,array[2]::bigint[],50)) then
    raise exception 'Backfill invalidated a fresh summary';
  end if;
  update public.jobs set last_seen_at='2030-01-01', title=title where id=2;
  if (select summary_input_updated_at from public.jobs where id=2) <> stamp then
    raise exception 'Repeat observation advanced content stamp';
  end if;
  if exists(select 1 from public.dashboard_summary_selected_batch(u,array[2]::bigint[],50)) then
    raise exception 'Repeat observation queued a rebuild';
  end if;
  if (select summary from public.dashboard_job_summaries where user_id=u and job_id=2) <> before_summary then
    raise exception 'Repeat observation rewrote stored Python decisions';
  end if;
  -- Read every bounded page and verify last-seen is hydrated from the live job.
  if not exists (
    select 1 from generate_series(1,5) p,
      lateral jsonb_array_elements(public.dashboard_job_page(u,p_view=>'All',p_page=>p)->'items') card
    where (card->>'id')::bigint=2 and (card->>'last_seen_at')::timestamptz='2030-01-01'::timestamptz
  ) then raise exception 'Page did not expose current observation time'; end if;
  select jsonb_build_array(to_jsonb(s) - 'user_id') into stale_payload
    from public.dashboard_job_summaries s where user_id=u and job_id=2;
  update public.jobs set description='A new job description' where id=2;
  if (select summary_input_updated_at from public.jobs where id=2) <= stamp then
    raise exception 'Content change did not advance dependency stamp';
  end if;
  select count(*) into changed_count from public.dashboard_summary_selected_batch(u,array[2]::bigint[],50);
  if changed_count <> 1 then raise exception 'Content change failed to queue rebuild'; end if;
  outcome := public.dashboard_summary_store_batch(u,stale_payload);
  if (outcome->>'saved')::int <> 0 or (outcome->>'stale')::int <> 1 then
    raise exception 'Concurrent content update accepted stale summary: %',outcome;
  end if;
  -- Independently changed profile inputs must still invalidate unchanged jobs.
  update public.dashboard_summary_user_state set profile_revision=profile_revision+1 where user_id=u;
  if not exists(select 1 from public.dashboard_summary_selected_batch(u,array[3]::bigint[],50)) then
    raise exception 'Profile change failed to invalidate summaries';
  end if;
  if exists(select 1 from pg_proc where pronamespace='public'::regnamespace
       and proname like 'dashboard_%' and (prosecdef or has_function_privilege('anon',oid,'execute')
       or has_function_privilege('authenticated',oid,'execute'))) then
    raise exception 'Dashboard permissions broadened';
  end if;
  raise notice 'PASS: backfill, observation-only update, live last-seen, content invalidation, stale writer rejection, profile invalidation, permissions';
end $$;
