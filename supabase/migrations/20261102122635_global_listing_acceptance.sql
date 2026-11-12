alter table public.user_job_preference_overrides
  drop constraint user_job_preference_overrides_preferences_check;

alter table public.user_job_preference_overrides
  add constraint user_job_preference_overrides_preferences_check
  check (
    cardinality(overridden_preferences) between 1 and 6
    and overridden_preferences <@ array[
      'role', 'location', 'work_model', 'language',
      'employment_type', 'seniority'
    ]::text[]
  );

drop trigger if exists dashboard_work_model_revision
  on public.user_job_work_model_verifications;
drop trigger if exists dashboard_language_revision
  on public.user_job_language_verifications;

-- The eligibility rules changed: language and work arrangement no longer gate
-- a listing. Advancing the version makes existing summaries rebuild through
-- the normal bounded worker instead of exposing stale decisions.
do $$
declare
  target record;
  definition text;
  updated_definition text;
begin
  for target in
    select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'dashboard_summary_next_batch',
        'dashboard_summary_store_batch',
        'dashboard_job_page',
        'dashboard_job_attention_page',
        'dashboard_job_detail',
        'dashboard_summary_selected_batch'
      )
  loop
    definition := pg_catalog.pg_get_functiondef(target.oid);
    updated_definition := replace(definition, 'summary_algorithm_version <> 1', 'summary_algorithm_version <> 2');
    updated_definition := replace(updated_definition, 'summary_algorithm_version = 1', 'summary_algorithm_version = 2');
    updated_definition := replace(
      updated_definition,
      $old$(r->>'summary_algorithm_version')::integer = 1$old$,
      $new$(r->>'summary_algorithm_version')::integer = 2$new$
    );
    updated_definition := replace(
      updated_definition,
      $old$or (m.live_for_user and not m.ready_to_rate
            and (m.actionable or m.decision_state = 'pending'))$old$,
      $new$or (m.live_for_user and not m.ready_to_rate
            and (m.actionable or m.decision_state = 'pending'
              or m.summary->>'static_reason_code' in (
                'location_incompatible','employment_type_incompatible','seniority_incompatible'
              )))$new$
    );
    updated_definition := replace(
      updated_definition,
      $old$('work_model_incompatible','location_incompatible','language_incompatible','employment_type_incompatible','seniority_incompatible')$old$,
      $new$('location_incompatible','employment_type_incompatible','seniority_incompatible')$new$
    );
    if updated_definition is distinct from definition then
      execute updated_definition;
    end if;
  end loop;
end;
$$;
