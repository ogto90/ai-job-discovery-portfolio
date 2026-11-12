-- Known-incompatible preference decisions belong in Archive. Needs attention
-- should retain genuinely unclear listings that still need the user's review.
do $migration$
declare
  target_oid oid := pg_catalog.to_regprocedure(
    'public.dashboard_job_attention_page(uuid,text,text,integer,text,text,text,integer,integer,jsonb,integer)'
  );
  definition text;
  old_clause text := $old$or (m.live_for_user and not m.ready_to_rate
            and (m.actionable or m.decision_state = 'pending'
              or m.summary->>'static_reason_code' in (
                'location_incompatible','employment_type_incompatible','seniority_incompatible'
              )))$old$;
  new_clause text := $new$or (m.live_for_user and not m.ready_to_rate
            and (m.actionable or m.decision_state = 'pending'))$new$;
begin
  if target_oid is null then
    raise exception 'dashboard_job_attention_page RPC is missing';
  end if;

  select pg_catalog.pg_get_functiondef(target_oid) into definition;
  if pg_catalog.strpos(definition, old_clause) > 0 then
    execute pg_catalog.replace(definition, old_clause, new_clause);
  elsif pg_catalog.strpos(definition, new_clause) = 0 then
    raise exception 'dashboard_job_attention_page has an unexpected Needs attention predicate';
  end if;
end;
$migration$;
