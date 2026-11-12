-- Build display-only CV fields and card JSON for the selected page only.
-- Eligibility, ordering, exact counts, freshness and invoker privileges are preserved.

CREATE OR REPLACE FUNCTION public.dashboard_job_attention_page(p_user_id uuid, p_view text DEFAULT 'Pending / unresolved'::text, p_score_state text DEFAULT 'All'::text, p_minimum_fit integer DEFAULT 0, p_search text DEFAULT ''::text, p_archive_category text DEFAULT 'All'::text, p_work_model text DEFAULT 'All'::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 50, p_failed_fingerprints jsonb DEFAULT '{}'::jsonb, p_pending_page integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  select m.*
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
      when 'Needs attention' then (
        m.review_status = 'new'
        and (
          m.duplicate_review_status = 'pending'
          or (m.live_for_user and not m.ready_to_rate
            and (m.actionable or m.decision_state = 'pending'))
        )
      )
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
), page_details as (
  select m.*,
    tailored.id as tailored_cv_id,
    tailored.storage_bucket as tailored_cv_bucket,
    tailored.tex_file_path as tailored_tex_path,
    tailored.pdf_file_path as tailored_pdf_path,
    tailored.expires_at as tailored_expires_at,
    tailored.artifacts_deleted_at as tailored_artifacts_deleted_at
  from page_rows m
  left join lateral (
    select cv.id, cv.storage_bucket, cv.tex_file_path, cv.pdf_file_path,
      cv.expires_at, cv.artifacts_deleted_at
    from public.cv_versions cv
    where cv.user_id = p_user_id and cv.job_id = m.job_id and not cv.is_base
      and cv.source_cv_version_id = (select uc.cv_id from user_context uc)
    order by cv.created_at desc, cv.id desc limit 1
  ) tailored on true
), page_cards as (
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
  from page_details m
)
select jsonb_build_object(
  'items', coalesce((select jsonb_agg(card order by (summary->>'metadata_unresolved')::boolean desc nulls last, displayed_fit_score desc nulls last, nullif(summary->>'last_seen_at','')::timestamptz desc nulls last, job_id asc) from page_cards), '[]'::jsonb),
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
$function$;

CREATE OR REPLACE FUNCTION public.dashboard_job_page(p_user_id uuid, p_view text DEFAULT 'Pending / unresolved'::text, p_score_state text DEFAULT 'All'::text, p_minimum_fit integer DEFAULT 0, p_search text DEFAULT ''::text, p_archive_category text DEFAULT 'All'::text, p_work_model text DEFAULT 'All'::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 50, p_failed_fingerprints jsonb DEFAULT '{}'::jsonb, p_pending_page integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  select m.*
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
), page_details as (
  select m.*,
    tailored.id as tailored_cv_id,
    tailored.storage_bucket as tailored_cv_bucket,
    tailored.tex_file_path as tailored_tex_path,
    tailored.pdf_file_path as tailored_pdf_path,
    tailored.expires_at as tailored_expires_at,
    tailored.artifacts_deleted_at as tailored_artifacts_deleted_at
  from page_rows m
  left join lateral (
    select cv.id, cv.storage_bucket, cv.tex_file_path, cv.pdf_file_path,
      cv.expires_at, cv.artifacts_deleted_at
    from public.cv_versions cv
    where cv.user_id = p_user_id and cv.job_id = m.job_id and not cv.is_base
      and cv.source_cv_version_id = (select uc.cv_id from user_context uc)
    order by cv.created_at desc, cv.id desc limit 1
  ) tailored on true
), page_cards as (
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
  from page_details m
)
select jsonb_build_object(
  'items', coalesce((select jsonb_agg(card order by (summary->>'metadata_unresolved')::boolean desc nulls last, displayed_fit_score desc nulls last, nullif(summary->>'last_seen_at','')::timestamptz desc nulls last, job_id asc) from page_cards), '[]'::jsonb),
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
$function$;
