-- The acceptance migration moved the store RPC validation to algorithm v2,
-- but its INSERT still hard-coded version 1. Repair that single literal.
do $$
declare
  target oid := 'public.dashboard_summary_store_batch(uuid,jsonb)'::regprocedure;
  definition text;
  updated_definition text;
  old_fragment constant text := $old$(r->>'job_revision')::bigint, 1,$old$;
  new_fragment constant text := $new$(r->>'job_revision')::bigint, 2,$new$;
begin
  definition := pg_catalog.pg_get_functiondef(target);
  if length(definition) - length(replace(definition, old_fragment, '')) <> length(old_fragment) then
    raise exception 'Expected exactly one hard-coded dashboard summary version literal';
  end if;
  updated_definition := replace(definition, old_fragment, new_fragment);
  execute updated_definition;
end;
$$;
