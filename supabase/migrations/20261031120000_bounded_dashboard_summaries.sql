-- Compact, versioned per-user dashboard read model. Expensive Python
-- eligibility/fingerprint decisions are persisted; lifecycle and Fit state
-- are joined at request time so user actions stay immediately visible.

create table public.dashboard_summary_user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile_revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table public.dashboard_summary_job_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id bigint not null references public.jobs(id) on delete cascade,
  job_revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, job_id)
);

create table public.dashboard_job_summaries (
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id bigint not null references public.jobs(id) on delete cascade,
  job_updated_at timestamptz not null,
  profile_revision bigint not null,
  job_revision bigint not null,
  summary_algorithm_version integer not null,
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  identity_company text not null,
  identity_title text not null,
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  built_at timestamptz not null default now(),
  primary key (user_id, job_id),
  constraint dashboard_job_summaries_no_heavy_payload check (
    not (summary ?| array['description', 'fit_strengths', 'fit_gaps', 'fit_job_snapshot'])
  )
);

create index dashboard_job_summaries_current_idx
  on public.dashboard_job_summaries (user_id, profile_revision, job_id);
create index dashboard_job_summaries_identity_idx
  on public.dashboard_job_summaries (user_id, identity_company, identity_title, job_id);
create index cv_versions_dashboard_tailored_idx
  on public.cv_versions (user_id, source_cv_version_id, job_id, created_at desc, id desc)
  where not is_base and job_id is not null;
create index dashboard_summary_job_state_job_idx
  on public.dashboard_summary_job_state (user_id, job_id, job_revision);
create index job_match_assessments_dashboard_latest_idx
  on public.job_match_assessments (user_id, matcher_version, job_id, created_at desc, id desc)
  include (candidate_profile_id, fit_score, evaluation_fingerprint);
create index job_match_assessments_dashboard_fingerprint_idx
  on public.job_match_assessments (user_id, matcher_version, evaluation_fingerprint, created_at desc, id desc)
  include (candidate_profile_id, job_id, fit_score);

alter table public.dashboard_summary_user_state enable row level security;
alter table public.dashboard_summary_job_state enable row level security;
alter table public.dashboard_job_summaries enable row level security;
revoke all on public.dashboard_summary_user_state, public.dashboard_summary_job_state,
  public.dashboard_job_summaries from public, anon, authenticated;
revoke all on public.dashboard_summary_user_state, public.dashboard_summary_job_state,
  public.dashboard_job_summaries from service_role;
grant select, insert, update on public.dashboard_summary_user_state,
  public.dashboard_summary_job_state, public.dashboard_job_summaries to service_role;

create or replace function public.bump_dashboard_profile_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_user_id uuid;
begin
  if tg_table_name = 'cv_versions' then
    if not coalesce(case when tg_op = 'DELETE' then old.is_base else new.is_base end, false) then
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end if;
  end if;
  if tg_table_name = 'candidate_profiles' then
    if tg_op = 'DELETE' and not old.is_active then return old; end if;
    if tg_op = 'INSERT' and not new.is_active then return new; end if;
    if tg_op = 'UPDATE' and not old.is_active and not new.is_active then return new; end if;
  end if;
  v_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  -- On deletion, invalidate an existing summary state row without inserting:
  -- Auth-user cascades may already have removed its parent/state rows.
  if tg_op = 'DELETE' then
    update public.dashboard_summary_user_state
      set profile_revision = profile_revision + 1, updated_at = now()
      where user_id = v_user_id;
    return old;
  end if;
  insert into public.dashboard_summary_user_state(user_id, profile_revision)
  values (v_user_id, 2)
  on conflict (user_id) do update
    set profile_revision = public.dashboard_summary_user_state.profile_revision + 1,
        updated_at = now();
  return new;
end;
$$;

create or replace function public.bump_dashboard_job_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_user_id uuid; v_job_id bigint;
begin
  if tg_op = 'DELETE' then
    update public.dashboard_summary_job_state
      set job_revision = job_revision + 1, updated_at = now()
      where user_id = old.user_id and job_id = old.job_id;
    return old;
  end if;
  if tg_op <> 'INSERT' then
    if old.job_id is not null then
      insert into public.dashboard_summary_job_state(user_id, job_id, job_revision)
      values (old.user_id, old.job_id, 2)
      on conflict (user_id, job_id) do update
        set job_revision = public.dashboard_summary_job_state.job_revision + 1,
            updated_at = now();
    end if;
  end if;
  if tg_op <> 'DELETE' then
    if new.job_id is not null then
      insert into public.dashboard_summary_job_state(user_id, job_id, job_revision)
      values (new.user_id, new.job_id, 2)
      on conflict (user_id, job_id) do update
        set job_revision = public.dashboard_summary_job_state.job_revision + 1,
            updated_at = now();
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.bump_dashboard_profile_revision() from public, anon, authenticated;
revoke all on function public.bump_dashboard_job_revision() from public, anon, authenticated;
grant execute on function public.bump_dashboard_profile_revision() to service_role;
grant execute on function public.bump_dashboard_job_revision() to service_role;

create trigger dashboard_candidate_profile_revision
  after insert or update or delete on public.candidate_profiles
  for each row execute function public.bump_dashboard_profile_revision();
create trigger dashboard_search_profile_revision
  after insert or update or delete on public.search_profiles
  for each row execute function public.bump_dashboard_profile_revision();
create trigger dashboard_base_cv_revision
  after insert or update or delete on public.cv_versions
  for each row
  execute function public.bump_dashboard_profile_revision();

-- These user/job inputs alter Python-derived eligibility or card metadata.
-- Lifecycle (applications/reviews), Fit assessments and duplicate decisions
-- are intentionally joined live by the page RPC below.
create trigger dashboard_metadata_revision after insert or update or delete
  on public.job_metadata_overrides for each row execute function public.bump_dashboard_job_revision();
create trigger dashboard_verification_revision after insert or update or delete
  on public.user_job_verifications for each row execute function public.bump_dashboard_job_revision();
create trigger dashboard_work_model_revision after insert or update or delete
  on public.user_job_work_model_verifications for each row execute function public.bump_dashboard_job_revision();
create trigger dashboard_language_revision after insert or update or delete
  on public.user_job_language_verifications for each row execute function public.bump_dashboard_job_revision();
create trigger dashboard_location_revision after insert or update or delete
  on public.user_job_location_verifications for each row execute function public.bump_dashboard_job_revision();
create trigger dashboard_employment_revision after insert or update or delete
  on public.user_job_employment_type_verifications for each row execute function public.bump_dashboard_job_revision();
create trigger dashboard_preference_revision after insert or update or delete
  on public.user_job_preference_overrides for each row execute function public.bump_dashboard_job_revision();
create or replace function public.dashboard_summary_next_batch(
  p_user_id uuid, p_after_job_id bigint default 0, p_limit integer default 50
)
returns table(job_id bigint, observed_job_updated_at timestamptz,
              observed_profile_revision bigint, observed_job_revision bigint)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_user_id is null then raise exception 'user_id is required'; end if;
  insert into public.dashboard_summary_user_state(user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  return query
    select j.id, j.updated_at, us.profile_revision, coalesce(js.job_revision, 1)
    from public.jobs j
    cross join public.dashboard_summary_user_state us
    left join public.dashboard_summary_job_state js
      on js.user_id = p_user_id and js.job_id = j.id
    left join public.dashboard_job_summaries s
      on s.user_id = p_user_id and s.job_id = j.id
    where us.user_id = p_user_id
      and (j.manual_owner_user_id is null or j.manual_owner_user_id = p_user_id)
      and j.id > greatest(coalesce(p_after_job_id, 0), 0)
      and (s.job_id is null
        or s.job_updated_at is distinct from j.updated_at
        or s.profile_revision is distinct from us.profile_revision
        or s.job_revision is distinct from coalesce(js.job_revision, 1)
        or s.summary_algorithm_version <> 1)
    order by j.id
    limit least(greatest(coalesce(p_limit, 50), 1), 50);
end;
$$;

create or replace function public.dashboard_summary_store_batch(p_user_id uuid, p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r jsonb; v_job_id bigint; v_saved integer := 0; v_stale integer := 0;
begin
  if p_user_id is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 50 then
    raise exception 'A user and at most 50 summary rows are required';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_job_id := (r->>'job_id')::bigint;
    insert into public.dashboard_summary_user_state(user_id) values (p_user_id)
      on conflict (user_id) do nothing;
    insert into public.dashboard_summary_job_state(user_id, job_id, job_revision)
      values (p_user_id, v_job_id, 1) on conflict (user_id, job_id) do nothing;
    -- Hold the dependency rows through this RPC transaction. Concurrent job,
    -- profile, or per-job evidence writes either commit first and fail the
    -- equality check, or commit after this summary and immediately stale it.
    perform 1 from public.jobs j where j.id = v_job_id for share;
    perform 1 from public.dashboard_summary_user_state us where us.user_id = p_user_id for share;
    perform 1 from public.dashboard_summary_job_state js
      where js.user_id = p_user_id and js.job_id = v_job_id for share;
    if exists (
      select 1 from public.jobs j
      join public.dashboard_summary_user_state us on us.user_id = p_user_id
      left join public.dashboard_summary_job_state js on js.user_id = p_user_id and js.job_id = j.id
      where j.id = v_job_id
        and (j.manual_owner_user_id is null or j.manual_owner_user_id = p_user_id)
        and j.updated_at = (r->>'job_updated_at')::timestamptz
        and us.profile_revision = (r->>'profile_revision')::bigint
        and coalesce(js.job_revision, 1) = (r->>'job_revision')::bigint
    ) and (r->>'summary_algorithm_version')::integer = 1
      and jsonb_typeof(r->'summary') = 'object'
      and not ((r->'summary') ?| array['description', 'fit_strengths', 'fit_gaps', 'fit_job_snapshot']) then
      insert into public.dashboard_job_summaries(
        user_id, job_id, job_updated_at, profile_revision, job_revision,
        summary_algorithm_version, input_fingerprint, identity_company,
        identity_title, summary, built_at
      ) values (
        p_user_id, v_job_id, (r->>'job_updated_at')::timestamptz,
        (r->>'profile_revision')::bigint, (r->>'job_revision')::bigint, 1,
        r->>'input_fingerprint', r->>'identity_company', r->>'identity_title',
        r->'summary', now()
      ) on conflict (user_id, job_id) do update set
        job_updated_at = excluded.job_updated_at,
        profile_revision = excluded.profile_revision,
        job_revision = excluded.job_revision,
        summary_algorithm_version = excluded.summary_algorithm_version,
        input_fingerprint = excluded.input_fingerprint,
        identity_company = excluded.identity_company,
        identity_title = excluded.identity_title,
        summary = excluded.summary,
        built_at = excluded.built_at;
      v_saved := v_saved + 1;
    else
      v_stale := v_stale + 1;
    end if;
  end loop;
  return jsonb_build_object('saved', v_saved, 'stale', v_stale);
end;
$$;

-- The page RPC performs global filtering, ordering and paging. It returns
-- compact cards and at most ten stale job previews; it never returns a bulk
-- backfill list or description/assessment detail payload.
create or replace function public.dashboard_job_page(
  p_user_id uuid, p_view text default 'Pending / unresolved',
  p_score_state text default 'All', p_minimum_fit integer default 0,
  p_search text default '', p_archive_category text default 'All',
  p_work_model text default 'All', p_page integer default 1,
  p_page_size integer default 50, p_failed_fingerprints jsonb default '{}'::jsonb,
  p_pending_page integer default 1
)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
begin
  insert into public.dashboard_summary_user_state(user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  return (
with state as (
  select us.profile_revision from public.dashboard_summary_user_state us where us.user_id = p_user_id
), stale as (
  select j.id, j.company, j.title
  from public.jobs j cross join state us
  left join public.dashboard_summary_job_state js on js.user_id = p_user_id and js.job_id = j.id
  left join public.dashboard_job_summaries s on s.user_id = p_user_id and s.job_id = j.id
  where (j.manual_owner_user_id is null or j.manual_owner_user_id = p_user_id)
    and (s.job_id is null or s.job_updated_at is distinct from j.updated_at
      or s.profile_revision is distinct from us.profile_revision
      or s.job_revision is distinct from coalesce(js.job_revision, 1)
      or s.summary_algorithm_version <> 1)
), stale_handled as (
  select st.id
  from stale st
  join lateral (
    select a.status
    from public.applications a
    where a.user_id = p_user_id and a.job_id = st.id
    order by a.updated_at desc, a.id desc limit 1
  ) app on true
  where app.status in ('applied','interview','offer','hired','rejected','withdrawn','no_response')
), cv_context as (
  select min(cv.id) as cv_id, min(cv.storage_bucket) as storage_bucket, count(*) as cv_count
  from public.cv_versions cv
  where cv.user_id = p_user_id and cv.is_base and cv.is_active
), user_context as (
  select cv.cv_id, cv.storage_bucket, cv.cv_count,
    (select case when count(*) = 1 then min(cp.id) end
     from public.candidate_profiles cp
     where cp.user_id = p_user_id and cp.cv_version_id = cv.cv_id and cp.is_active) as active_profile_id
  from cv_context cv
), live_rows as (
  select s.job_id, s.summary, s.identity_company, s.identity_title,
    app.status as application_status,
    app.applied_at, app.interview_at, app.offer_at, app.hired_at,
    app.rejected_at, app.withdrawn_at, app.status_changed_at,
    rv.status as saved_review_status,
    latest_fit.id as fit_assessment_id,
    latest_fit.job_id as fit_assessment_job_id,
    latest_fit.fit_score,
    latest_fit.candidate_profile_id as fit_candidate_profile_id,
    latest_any.id as latest_assessment_id,
    latest_any.fit_score as latest_fit_score,
    latest_any.candidate_profile_id as latest_candidate_profile_id,
    tailored.id as tailored_cv_id,
    tailored.storage_bucket as tailored_cv_bucket,
    tailored.tex_file_path as tailored_tex_path,
    tailored.pdf_file_path as tailored_pdf_path,
    tailored.expires_at as tailored_expires_at,
    tailored.artifacts_deleted_at as tailored_artifacts_deleted_at,
    dup.id as matched_job_id, dup.company as matched_company, dup.title as matched_title,
    coalesce(dup.status, dr.decision) as duplicate_match_status,
    dup.match_updated_at,
    dr.decision as duplicate_review_decision,
    dr.matched_job_id as duplicate_review_matched_job_id,
    case when dup.id is null then null
      when dr.matched_job_id = dup.id and dr.decision in ('same_listing','different_listing') then dr.decision
      else 'pending' end as duplicate_review_status,
    case when latest_fit.id is null and latest_any.id is not null then latest_any.fit_score end as historical_fit_score,
    case when latest_fit.id is null and latest_any.id is not null
      and latest_any.fit_score is not null
      and nullif(s.summary->>'active_profile_id', '') is not null
      and latest_any.candidate_profile_id is distinct from (s.summary->>'active_profile_id')::bigint
      then true else false end as previous_profile_rating,
    case when latest_fit.id is not null then 'current'
      when latest_any.id is not null then 'stale' else 'none' end as fit_status,
    latest_any.id as stale_fit_assessment_id,
    case when latest_fit.id is not null then latest_fit.fit_score
      when latest_any.id is not null then latest_any.fit_score end as displayed_fit_score,
    case when app.status in ('applied','interview','offer','hired','rejected','withdrawn','no_response') then app.status
      when rv.status in ('ignored','archived') then rv.status
      when latest_fit.id is not null or (latest_any.fit_score is not null and latest_any.candidate_profile_id is distinct from (s.summary->>'active_profile_id')::bigint) then 'rated'
      else 'new' end as review_status,
    (p_failed_fingerprints->>s.job_id::text = s.summary->>'fit_fingerprint') as rating_failed
  from public.dashboard_job_summaries s
  join public.jobs j on j.id = s.job_id
  cross join state us
  left join public.dashboard_summary_job_state js on js.user_id = p_user_id and js.job_id = s.job_id
  left join lateral (
    select a.* from public.applications a where a.user_id = p_user_id and a.job_id = s.job_id
    order by a.updated_at desc, a.id desc limit 1
  ) app on true
  left join lateral (
    select r.* from public.job_reviews r where r.user_id = p_user_id and r.job_id = s.job_id
    order by r.updated_at desc, r.id desc limit 1
  ) rv on true
  left join lateral (
    select a.id, a.job_id, a.candidate_profile_id, a.fit_score
    from public.job_match_assessments a
    where a.user_id = p_user_id and a.matcher_version = 'holistic_fit_v1'
      and a.evaluation_fingerprint = s.summary->>'fit_fingerprint'
    order by a.created_at desc, a.id desc limit 1
  ) latest_fit on true
  left join lateral (
    select a.id, a.candidate_profile_id, a.fit_score
    from public.job_match_assessments a
    where a.user_id = p_user_id and a.job_id = s.job_id
      and a.matcher_version = 'holistic_fit_v1'
    order by a.created_at desc, a.id desc limit 1
  ) latest_any on true
  left join lateral (
    select cv.id, cv.storage_bucket, cv.tex_file_path, cv.pdf_file_path,
      cv.expires_at, cv.artifacts_deleted_at
    from public.cv_versions cv
    where cv.user_id = p_user_id and cv.job_id = s.job_id and not cv.is_base
      and cv.source_cv_version_id = (select uc.cv_id from user_context uc)
    order by cv.created_at desc, cv.id desc limit 1
  ) tailored on true
  left join lateral (
    select a.decision, a.matched_job_id
    from public.user_job_duplicate_reviews a
    where a.user_id = p_user_id and a.job_id = s.job_id
    -- This relation is keyed by (user_id, job_id), so there is only one row.
    order by a.updated_at desc limit 1
  ) dr on true
  left join lateral (
    select h.id, ps.identity_company as company, ps.identity_title as title,
      coalesce(a.status_changed_at, a.applied_at) as match_updated_at,
      coalesce(a.status, r.status) as status
    from public.dashboard_job_summaries ps
    join public.jobs h on h.id = ps.job_id
    left join lateral (
      select aa.status, aa.status_changed_at, aa.applied_at
      from public.applications aa
      where aa.user_id = p_user_id and aa.job_id = h.id
      order by aa.updated_at desc, aa.id desc limit 1
    ) a on true
    left join lateral (
      select rr.status
      from public.job_reviews rr
      where rr.user_id = p_user_id and rr.job_id = h.id
      order by rr.updated_at desc, rr.id desc limit 1
    ) r on true
    where ps.user_id = p_user_id and ps.job_id <> s.job_id
      and coalesce(app.status, '') not in ('applied','interview','offer','hired','rejected','no_response','withdrawn')
      and ps.identity_company = s.identity_company and ps.identity_title = s.identity_title
      and ps.job_updated_at = h.updated_at and ps.profile_revision = us.profile_revision
      and ps.job_revision = coalesce((select sj.job_revision from public.dashboard_summary_job_state sj where sj.user_id = p_user_id and sj.job_id = h.id), 1)
      and ps.summary_algorithm_version = 1
      and coalesce(a.status, '') in ('applied','interview','offer','hired','rejected','no_response','withdrawn')
    order by coalesce(a.status_changed_at, a.applied_at) desc nulls last, h.id asc
    limit 1
  ) dup on true
  where s.user_id = p_user_id
    and s.job_updated_at = j.updated_at
    and s.profile_revision = us.profile_revision
    and s.job_revision = coalesce(js.job_revision, 1)
    and s.summary_algorithm_version = 1
    and (j.manual_owner_user_id is null or j.manual_owner_user_id = p_user_id)
), enriched as (
  select l.*,
    (l.review_status in ('ignored','archived')) as archived,
    (l.application_status in ('applied','interview','offer','hired','rejected','withdrawn','no_response')) as handled,
    coalesce((l.summary->>'is_manual')::boolean, false) as is_manual,
    coalesce((l.summary->>'metadata_unresolved')::boolean, false) as metadata_unresolved,
    coalesce((l.summary->>'static_actionable')::boolean, false)
      and coalesce(l.duplicate_review_status, '') not in ('pending','same_listing') as actionable,
    case when l.summary->>'availability_status' = 'expired' then false
      when l.summary->>'user_verification_status' = 'confirmed_live' then true
      when l.summary->>'user_verification_status' in ('confirmed_closed','unable_to_verify') then false
      else l.summary->>'availability_status' = 'active' end as live_for_user,
    case when l.review_status in ('ignored','archived') then 'archive'
      when l.application_status in ('applied','interview','offer','hired','rejected','withdrawn','no_response') then 'handled'
      when (l.summary->>'static_reason_code') in ('listing_closed','profile_exclusion','outside_target_roles','location_incompatible','metadata_unresolved','work_model_incompatible','language_incompatible','employment_type_incompatible','seniority_incompatible') then l.summary->>'static_decision_state'
      when l.fit_assessment_id is not null or l.previous_profile_rating then 'rated'
      else l.summary->>'static_decision_state' end as decision_state
  from live_rows l
), matched as (
  select e.*,
    case when e.duplicate_review_status = 'same_listing' then true else false end as duplicate_hidden,
    case when e.fit_assessment_id is not null or e.latest_fit_score is not null then true else false end as has_fit_history,
    (e.fit_assessment_id is null and not e.previous_profile_rating
      and e.summary->>'description_kind' <> 'full'
      and e.live_for_user and e.actionable
      and e.review_status not in ('hired','rejected','withdrawn','no_response','ignored','archived','applied','interview','offer')) as jd_required,
    (e.fit_assessment_id is null and not e.previous_profile_rating
      and e.summary->>'description_kind' = 'full'
      and coalesce((e.summary->>'description_available')::boolean, false)
      and e.live_for_user and e.actionable
      and e.review_status not in ('hired','rejected','withdrawn','no_response','ignored','archived','applied','interview','offer')
      and not e.rating_failed) as ready_to_rate,
    (e.rating_failed and e.fit_assessment_id is null and not e.previous_profile_rating
      and e.summary->>'description_kind' = 'full' and e.live_for_user and e.actionable
      and e.review_status not in ('hired','rejected','withdrawn','no_response','ignored','archived','applied','interview','offer')) as rating_failed_flag
  from enriched e
), filtered as (
  select m.*,
    (m.summary || jsonb_build_object(
      'review_status', m.review_status, 'application_status', m.application_status,
      'applied_at', m.applied_at, 'interview_at', m.interview_at, 'offer_at', m.offer_at,
      'hired_at', m.hired_at, 'rejected_at', m.rejected_at, 'withdrawn_at', m.withdrawn_at,
      'status_changed_at', m.status_changed_at,
      'fit_assessment_id', m.fit_assessment_id, 'fit_assessment_job_id', m.fit_assessment_job_id,
      'fit_score', m.fit_score, 'historical_fit_score', m.historical_fit_score,
      'tailored_cv_id', m.tailored_cv_id, 'tailored_cv_bucket', m.tailored_cv_bucket,
      'tailored_tex_path', m.tailored_tex_path, 'tailored_pdf_path', m.tailored_pdf_path,
      'tailored_expires_at', m.tailored_expires_at,
      'tailored_artifacts_deleted_at', m.tailored_artifacts_deleted_at,
      'historical_fit_assessment_id', case when m.fit_assessment_id is null then m.latest_assessment_id end,
      'previous_profile_rating', m.previous_profile_rating,
      'existing_fit_assessment_status', m.fit_status,
      'stale_fit_assessment_id', case when m.fit_assessment_id is null then m.stale_fit_assessment_id end,
      'fit_strengths', '[]'::jsonb, 'fit_gaps', '[]'::jsonb,
      'duplicate_review_status', m.duplicate_review_status,
      'duplicate_review_decision', m.duplicate_review_decision,
      'duplicate_review_matched_job_id', m.duplicate_review_matched_job_id,
      'duplicate_match_job_id', m.matched_job_id,
      'duplicate_match_company', m.matched_company,
      'duplicate_match_title', m.matched_title,
      'duplicate_match_status', m.duplicate_match_status,
      'duplicate_match_updated_at', m.match_updated_at
    )) as card
  from matched m
  where (coalesce(p_search, '') = '' or position(lower(btrim(p_search)) in lower(coalesce(m.summary->>'company','') || ' ' || coalesce(m.summary->>'title',''))) > 0)
    and (coalesce(p_minimum_fit, 0) <= 0 or coalesce(m.displayed_fit_score, -1) >= p_minimum_fit)
    and (coalesce(p_work_model, 'All') = 'All'
      or (p_work_model = 'Unknown' and btrim(coalesce(m.summary->>'remote_scope','') || coalesce(m.summary->>'location','')) = '')
      or (p_work_model = 'Remote' and position('remote' in lower(coalesce(m.summary->>'remote_scope','') || ' ' || coalesce(m.summary->>'location',''))) > 0)
      or (p_work_model = 'Hybrid' and position('hybrid' in lower(coalesce(m.summary->>'remote_scope','') || ' ' || coalesce(m.summary->>'location',''))) > 0)
      or (p_work_model = 'On-site' and (
        position('onsite' in lower(coalesce(m.summary->>'remote_scope','') || ' ' || coalesce(m.summary->>'location',''))) > 0
        or position('on-site' in lower(coalesce(m.summary->>'remote_scope','') || ' ' || coalesce(m.summary->>'location',''))) > 0
        or position('on site' in lower(coalesce(m.summary->>'remote_scope','') || ' ' || coalesce(m.summary->>'location',''))) > 0)))
    and case coalesce(p_score_state, 'All')
      when 'Scored' then m.has_fit_history
      when 'Unscored' then not m.has_fit_history
      when 'JD required' then m.jd_required
      when 'Rating failed' then m.rating_failed_flag
      when 'Ready to rate' then m.ready_to_rate
      else true end
    and case coalesce(p_view, 'Pending / unresolved')
      when 'All' then m.review_status not in ('hired','rejected','withdrawn','no_response','ignored','archived','applied','interview','offer') and m.decision_state <> 'not_actionable'
      when 'Unaddressed' then m.duplicate_review_status = 'pending' or (m.actionable and m.live_for_user and m.review_status not in ('hired','rejected','withdrawn','no_response','ignored','archived','applied','interview','offer'))
      when 'Pending / unresolved' then m.decision_state = 'pending'
      when 'New' then m.review_status = 'new'
      when 'Rated' then m.review_status = 'rated'
      when 'Applications' then m.review_status in ('applied','interview','offer','hired','rejected','withdrawn','no_response')
      when 'Active applications' then m.review_status in ('applied','interview','offer')
      when 'Applied' then m.review_status = 'applied'
      when 'Interview' then m.review_status = 'interview'
      when 'Offer' then m.review_status = 'offer'
      when 'Closed' then m.review_status in ('rejected','withdrawn','hired','no_response')
      when 'Archive' then m.application_status is null and (
        m.review_status in ('ignored','archived') or m.decision_state = 'not_actionable'
        or m.duplicate_review_status = 'pending')
      when 'Rejected / Closed' then m.review_status in ('rejected','no_response','withdrawn','hired','closed')
      else m.review_status = p_view end
    and (coalesce(p_view,'') <> 'Archive' or coalesce(p_archive_category,'All') = 'All'
      or (p_archive_category = 'Archived' and m.review_status in ('ignored','archived'))
      or (p_archive_category = 'Preference mismatches' and m.decision_state = 'not_actionable'
        and m.summary->>'static_reason_code' in ('work_model_incompatible','location_incompatible','language_incompatible','employment_type_incompatible','seniority_incompatible'))
      or (p_archive_category = 'Not actionable' and (m.decision_state = 'not_actionable' or m.duplicate_review_status = 'pending')
        and m.summary->>'static_reason_code' not in ('work_model_incompatible','location_incompatible','language_incompatible','employment_type_incompatible','seniority_incompatible')))
    and not m.duplicate_hidden
), page_rows as (
  select * from filtered
  order by (summary->>'metadata_unresolved')::boolean desc nulls last,
    displayed_fit_score desc nulls last,
    nullif(summary->>'last_seen_at','')::timestamptz desc nulls last,
    job_id asc
  offset (greatest(coalesce(p_page,1),1)-1) * least(greatest(coalesce(p_page_size,50),1),50)
  limit least(greatest(coalesce(p_page_size,50),1),50)
)
select jsonb_build_object(
  'items', coalesce((select jsonb_agg(card order by (summary->>'metadata_unresolved')::boolean desc nulls last, displayed_fit_score desc nulls last, nullif(summary->>'last_seen_at','')::timestamptz desc nulls last, job_id asc) from page_rows), '[]'::jsonb),
  'total_count', (select count(*) from filtered),
  'page', greatest(coalesce(p_page,1),1),
  'page_size', least(greatest(coalesce(p_page_size,50),1),50),
  'pending_count', (select count(*) from stale),
  'pending_duplicate_count', (select count(*) from stale_handled),
  'pending_preview', coalesce((select jsonb_agg(jsonb_build_object('job_id', id, 'company', company, 'title', title) order by id) from (select id, company, title from stale order by id offset (greatest(coalesce(p_pending_page,1),1)-1)*10 limit 10) q), '[]'::jsonb),
  'pending_preview_page', greatest(coalesce(p_pending_page,1),1),
  'pending_preview_pages', greatest(1, ceil((select count(*) from stale)::numeric / 10)::integer),
  'complete', not exists(select 1 from stale),
  'cv_version_id', (select case when cv_count = 1 then cv_id end from user_context),
  'storage_bucket', (select case when cv_count = 1 then storage_bucket end from user_context),
  'active_profile_id', (select case when cv_count = 1 then active_profile_id end from user_context)
  ));
end;
$$;

create or replace function public.dashboard_job_detail(p_user_id uuid, p_job_id bigint, p_include_description boolean default false)
returns jsonb language sql stable security invoker set search_path = '' as $$
select jsonb_build_object(
  'job_id', j.id, 'job_updated_at', j.updated_at,
  'description', case when p_include_description then j.description end,
  'description_kind', j.description_kind,
  'fit_strengths', coalesce(current_fit.strengths, latest_fit.strengths, '[]'::jsonb),
  'fit_gaps', coalesce(current_fit.gaps, latest_fit.gaps, '[]'::jsonb),
  'fit_job_snapshot', coalesce(current_fit.job_snapshot, latest_fit.job_snapshot),
  'fit_assessment_id', current_fit.id,
  'fit_assessment_job_id', current_fit.job_id,
  'fit_score', current_fit.fit_score,
  'fit_candidate_profile_id', current_fit.candidate_profile_id,
  'summary_current', s.job_id is not null
    and s.job_updated_at = j.updated_at
    and s.profile_revision = us.profile_revision
    and s.job_revision = coalesce(js.job_revision,1)
    and s.summary_algorithm_version = 1
)
from public.jobs j
join public.dashboard_summary_user_state us on us.user_id = p_user_id
left join public.dashboard_summary_job_state js on js.user_id = p_user_id and js.job_id = j.id
left join public.dashboard_job_summaries s on s.user_id = p_user_id and s.job_id = j.id
left join lateral (
  select a.id, a.job_id, a.candidate_profile_id, a.fit_score, a.strengths, a.gaps, a.job_snapshot
  from public.job_match_assessments a
  where a.user_id = p_user_id and a.matcher_version = 'holistic_fit_v1'
    and a.evaluation_fingerprint = s.summary->>'fit_fingerprint'
  order by a.created_at desc, a.id desc limit 1
) current_fit on true
left join lateral (
  select a.strengths, a.gaps, a.job_snapshot
  from public.job_match_assessments a
  where a.user_id = p_user_id and a.job_id = j.id and a.matcher_version = 'holistic_fit_v1'
  order by a.created_at desc, a.id desc limit 1
) latest_fit on true
where j.id = p_job_id and (j.manual_owner_user_id is null or j.manual_owner_user_id = p_user_id);
$$;

revoke all on function public.dashboard_summary_next_batch(uuid,bigint,integer) from public, anon, authenticated;
revoke all on function public.dashboard_summary_store_batch(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.dashboard_job_page(uuid,text,text,integer,text,text,text,integer,integer,jsonb,integer) from public, anon, authenticated;
revoke all on function public.dashboard_job_detail(uuid,bigint,boolean) from public, anon, authenticated;
grant execute on function public.dashboard_summary_next_batch(uuid,bigint,integer) to service_role;
grant execute on function public.dashboard_summary_store_batch(uuid,jsonb) to service_role;
grant execute on function public.dashboard_job_page(uuid,text,text,integer,text,text,text,integer,integer,jsonb,integer) to service_role;
grant execute on function public.dashboard_job_detail(uuid,bigint,boolean) to service_role;
