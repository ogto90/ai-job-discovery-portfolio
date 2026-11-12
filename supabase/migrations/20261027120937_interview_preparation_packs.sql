create table public.interview_preparation_packs (
  preparation_id uuid primary key
    references public.interview_preparations(id) on delete cascade,
  generation_status text not null default 'idle'
    check (generation_status in ('idle', 'running', 'ready', 'failed')),
  attempt_key uuid,
  attempt_fingerprint text,
  attempt_started_at timestamptz,
  pack_json jsonb,
  schema_version text,
  source_fingerprint text,
  model text,
  research_sources jsonb not null default '[]'::jsonb
    check (jsonb_typeof(research_sources) = 'array'),
  research_timestamp timestamptz,
  generated_at timestamptz,
  api_usage jsonb not null default '{}'::jsonb
    check (jsonb_typeof(api_usage) = 'object'),
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint interview_preparation_packs_pack_object_check
    check (pack_json is null or jsonb_typeof(pack_json) = 'object'),
  constraint interview_preparation_packs_source_fingerprint_check
    check (source_fingerprint is null or source_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint interview_preparation_packs_attempt_fingerprint_check
    check (attempt_fingerprint is null or attempt_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint interview_preparation_packs_ready_check
    check (generation_status <> 'ready' or (pack_json is not null and generated_at is not null and model is not null))
);

alter table public.interview_preparation_packs enable row level security;
revoke all on table public.interview_preparation_packs from public, anon, authenticated, service_role;
grant select, insert, update on table public.interview_preparation_packs to service_role;

create or replace function public.claim_interview_preparation_pack_generation(
  p_user_id uuid,
  p_preparation_id uuid,
  p_attempt_key uuid,
  p_source_fingerprint text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_row public.interview_preparation_packs%rowtype;
begin
  if p_user_id is null or p_preparation_id is null or p_attempt_key is null
     or p_source_fingerprint is null
     or p_source_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid source fingerprint';
  end if;
  if not exists (
    select 1 from public.interview_preparations p
    where p.id = p_preparation_id and p.user_id = p_user_id
  ) then
    raise exception 'interview preparation not found';
  end if;

  insert into public.interview_preparation_packs (preparation_id)
  values (p_preparation_id)
  on conflict (preparation_id) do nothing;

  select * into current_row
  from public.interview_preparation_packs
  where preparation_id = p_preparation_id
  for update;

  if current_row.attempt_key = p_attempt_key then
    return jsonb_build_object('claimed', false, 'status', current_row.generation_status);
  end if;

  if current_row.generation_status = 'running'
     and current_row.attempt_started_at > now() - interval '15 minutes' then
    return jsonb_build_object('claimed', false, 'status', 'running');
  end if;

  update public.interview_preparation_packs
  set generation_status = 'running',
      attempt_key = p_attempt_key,
      attempt_fingerprint = p_source_fingerprint,
      attempt_started_at = now(),
      failure_code = null,
      updated_at = now()
  where preparation_id = p_preparation_id;

  return jsonb_build_object('claimed', true, 'status', 'running');
end;
$$;

create or replace function public.complete_interview_preparation_pack_generation(
  p_user_id uuid,
  p_preparation_id uuid,
  p_attempt_key uuid,
  p_pack_json jsonb,
  p_schema_version text,
  p_source_fingerprint text,
  p_model text,
  p_research_sources jsonb,
  p_research_timestamp timestamptz,
  p_generated_at timestamptz,
  p_api_usage jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not exists (
    select 1 from public.interview_preparations p
    where p.id = p_preparation_id and p.user_id = p_user_id
  ) then
    raise exception 'interview preparation not found';
  end if;
  if p_pack_json is null
     or p_research_sources is null
     or p_api_usage is null
     or p_research_timestamp is null
     or p_generated_at is null
     or p_source_fingerprint is null
     or jsonb_typeof(p_pack_json) <> 'object'
     or jsonb_typeof(p_research_sources) <> 'array'
     or jsonb_typeof(p_api_usage) <> 'object'
     or p_source_fingerprint !~ '^[0-9a-f]{64}$'
     or p_attempt_key is null
     or p_user_id is null
     or p_preparation_id is null
     or nullif(btrim(p_schema_version), '') is null
     or nullif(btrim(p_model), '') is null then
    raise exception 'invalid preparation pack payload';
  end if;

  update public.interview_preparation_packs
  set generation_status = 'ready',
      pack_json = p_pack_json,
      schema_version = p_schema_version,
      source_fingerprint = p_source_fingerprint,
      model = p_model,
      research_sources = p_research_sources,
      research_timestamp = p_research_timestamp,
      generated_at = p_generated_at,
      api_usage = p_api_usage,
      failure_code = null,
      updated_at = now()
  where preparation_id = p_preparation_id
    and attempt_key = p_attempt_key
    and attempt_fingerprint = p_source_fingerprint
    and generation_status = 'running';
  get diagnostics changed = row_count;
  return jsonb_build_object('saved', changed = 1);
end;
$$;

create or replace function public.fail_interview_preparation_pack_generation(
  p_user_id uuid,
  p_preparation_id uuid,
  p_attempt_key uuid,
  p_failure_code text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not exists (
    select 1 from public.interview_preparations p
    where p.id = p_preparation_id and p.user_id = p_user_id
  ) then
    raise exception 'interview preparation not found';
  end if;
  if p_attempt_key is null or p_failure_code is null or p_failure_code not in (
    'research_unavailable', 'invalid_sources', 'invalid_output', 'refused',
    'incomplete', 'rate_limited', 'timeout', 'api_error', 'persistence_error', 'unsupported_model'
  ) then
    raise exception 'invalid failure code';
  end if;

  update public.interview_preparation_packs
  set generation_status = 'failed',
      failure_code = p_failure_code,
      updated_at = now()
  where preparation_id = p_preparation_id
    and attempt_key = p_attempt_key
    and generation_status = 'running';
  get diagnostics changed = row_count;
  return jsonb_build_object('failed', changed = 1);
end;
$$;

revoke all on function public.claim_interview_preparation_pack_generation(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.complete_interview_preparation_pack_generation(
  uuid, uuid, uuid, jsonb, text, text, text, jsonb, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_interview_preparation_pack_generation(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_interview_preparation_pack_generation(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.complete_interview_preparation_pack_generation(
  uuid, uuid, uuid, jsonb, text, text, text, jsonb, timestamptz, timestamptz, jsonb
) to service_role;
grant execute on function public.fail_interview_preparation_pack_generation(uuid, uuid, uuid, text)
  to service_role;
