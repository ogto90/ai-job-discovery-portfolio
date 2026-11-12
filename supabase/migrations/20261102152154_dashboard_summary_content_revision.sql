-- Keep the general change cursor, but do not rebuild Python summaries for a
-- repeat observation alone. Backfill with the original stamp so valid summaries
-- remain valid at deployment. DDL holds the table lock throughout this migration.
alter table public.jobs add column summary_input_updated_at timestamptz;
alter table public.jobs disable trigger jobs_set_updated_at;
update public.jobs set summary_input_updated_at = updated_at;
alter table public.jobs enable trigger jobs_set_updated_at;
alter table public.jobs alter column summary_input_updated_at set not null;
alter table public.jobs alter column summary_input_updated_at set default now();

create or replace function public.set_jobs_updated_at()
returns trigger language plpgsql security invoker set search_path = 'pg_catalog' as $$
begin
  new.updated_at := current_timestamp;
  if (to_jsonb(new) - array['updated_at','last_seen_at','summary_input_updated_at'])
     is distinct from
     (to_jsonb(old) - array['updated_at','last_seen_at','summary_input_updated_at']) then
    new.summary_input_updated_at := greatest(clock_timestamp(), old.summary_input_updated_at + interval '1 microsecond');
  else
    new.summary_input_updated_at := old.summary_input_updated_at;
  end if;
  return new;
end;
$$;
revoke all on function public.set_jobs_updated_at() from public, anon, authenticated;
grant execute on function public.set_jobs_updated_at() to service_role;

-- Preserve all existing filtering, ownership checks, signatures and grants.
-- Only jobs' dependency stamps change; user/job evidence revisions still apply.
do $$
declare f record; definition text; changed integer := 0;
begin
  for f in select oid, proname from pg_proc
    where pronamespace = 'public'::regnamespace and proname in (
      'dashboard_summary_next_batch','dashboard_summary_selected_batch',
      'dashboard_summary_store_batch','dashboard_job_page',
      'dashboard_job_attention_page','dashboard_job_detail')
  loop
    definition := pg_get_functiondef(f.oid);
    if position('j.updated_at' in definition) = 0 then
      raise exception 'Expected job timestamp reference missing in %', f.proname;
    end if;
    definition := replace(definition, 'j.updated_at', 'j.summary_input_updated_at');
    definition := replace(definition, 'h.updated_at', 'h.summary_input_updated_at');
    if f.proname in ('dashboard_job_page','dashboard_job_attention_page') then
      if position('select s.job_id, s.summary,' in definition) = 0 then
        raise exception 'Expected summary projection missing in %', f.proname;
      end if;
      -- Observation time affects ordering/display, not derived eligibility.
      definition := replace(definition, 'select s.job_id, s.summary,',
        'select s.job_id, s.summary || jsonb_build_object(''last_seen_at'', j.last_seen_at) as summary,');
    end if;
    execute definition;
    changed := changed + 1;
  end loop;
  if changed <> 6 then raise exception 'Expected six dashboard functions, found %', changed; end if;
end;
$$;
