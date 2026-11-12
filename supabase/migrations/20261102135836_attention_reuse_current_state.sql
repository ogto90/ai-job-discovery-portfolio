-- Reuse per-user application, review, assessment and duplicate-candidate state
-- within each Needs attention request. No cross-request cache or new indexes.
-- Rewrite only the measured lookup blocks so independent filter fixes survive.
do $migration$
declare
  target_oid oid := pg_catalog.to_regprocedure(
    'public.dashboard_job_attention_page(uuid,text,text,integer,text,text,text,integer,integer,jsonb,integer)'
  );
  definition text;
  patch record;
begin
  if target_oid is null then
    raise exception 'dashboard_job_attention_page RPC is missing';
  end if;
  definition := pg_catalog.pg_get_functiondef(target_oid);
  for patch in select * from (values
    ($old0$), stale as ($old0$, $new0$), current_applications as materialized (
  select distinct on (a.job_id) a.*
  from public.applications a
  where a.user_id = p_user_id
  order by a.job_id, a.updated_at desc, a.id desc
), current_reviews as materialized (
  select distinct on (r.job_id) r.job_id, r.status
  from public.job_reviews r
  where r.user_id = p_user_id
  order by r.job_id, r.updated_at desc, r.id desc
), current_assessments as materialized (
  select a.id, a.job_id, a.candidate_profile_id, a.fit_score,
    a.evaluation_fingerprint, a.created_at
  from public.job_match_assessments a
  where a.user_id = p_user_id and a.matcher_version = 'holistic_fit_v1'
), latest_fit_by_fingerprint as materialized (
  select distinct on (a.evaluation_fingerprint) a.*
  from current_assessments a
  order by a.evaluation_fingerprint, a.created_at desc, a.id desc
), latest_fit_by_job as materialized (
  select distinct on (a.job_id) a.*
  from current_assessments a
  order by a.job_id, a.created_at desc, a.id desc
), handled_duplicate_candidates as materialized (
  select h.id, ps.identity_company as company, ps.identity_title as title,
    coalesce(a.status_changed_at, a.applied_at) as match_updated_at,
    a.status
  from current_applications a
  join public.dashboard_job_summaries ps
    on ps.user_id = p_user_id and ps.job_id = a.job_id
  join public.jobs h on h.id = ps.job_id
  cross join state us
  left join public.dashboard_summary_job_state sj
    on sj.user_id = p_user_id and sj.job_id = h.id
  where a.status in ('applied','interview','offer','hired','rejected','no_response','withdrawn')
    and ps.job_updated_at = h.updated_at and ps.profile_revision = us.profile_revision
    and ps.job_revision = coalesce(sj.job_revision, 1)
    and ps.summary_algorithm_version = 2
), stale as ($new0$),
    ($old1$  join lateral (
    select a.status
    from public.applications a
    where a.user_id = p_user_id and a.job_id = st.id
    order by a.updated_at desc, a.id desc limit 1
  ) app on true$old1$, $new1$  join current_applications app on app.job_id = st.id$new1$),
    ($old2$  left join lateral (
    select a.* from public.applications a where a.user_id = p_user_id and a.job_id = s.job_id
    order by a.updated_at desc, a.id desc limit 1
  ) app on true$old2$, $new2$  left join current_applications app on app.job_id = s.job_id$new2$),
    ($old3$  left join lateral (
    select r.* from public.job_reviews r where r.user_id = p_user_id and r.job_id = s.job_id
    order by r.updated_at desc, r.id desc limit 1
  ) rv on true$old3$, $new3$  left join current_reviews rv on rv.job_id = s.job_id$new3$),
    ($old4$  left join lateral (
    select a.id, a.job_id, a.candidate_profile_id, a.fit_score
    from public.job_match_assessments a
    where a.user_id = p_user_id and a.matcher_version = 'holistic_fit_v1'
      and a.evaluation_fingerprint = s.summary->>'fit_fingerprint'
    order by a.created_at desc, a.id desc limit 1
  ) latest_fit on true$old4$, $new4$  left join latest_fit_by_fingerprint latest_fit
    on latest_fit.evaluation_fingerprint = s.summary->>'fit_fingerprint'$new4$),
    ($old5$  left join lateral (
    select a.id, a.candidate_profile_id, a.fit_score
    from public.job_match_assessments a
    where a.user_id = p_user_id and a.job_id = s.job_id
      and a.matcher_version = 'holistic_fit_v1'
    order by a.created_at desc, a.id desc limit 1
  ) latest_any on true$old5$, $new5$  left join latest_fit_by_job latest_any on latest_any.job_id = s.job_id$new5$),
    ($old6$  left join lateral (
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
      and ps.summary_algorithm_version = 2
      and coalesce(a.status, '') in ('applied','interview','offer','hired','rejected','no_response','withdrawn')
    order by coalesce(a.status_changed_at, a.applied_at) desc nulls last, h.id asc
    limit 1
  ) dup on true$old6$, $new6$  left join lateral (
    select dc.id, dc.company, dc.title, dc.match_updated_at, dc.status
    from handled_duplicate_candidates dc
    where dc.id <> s.job_id
      and coalesce(app.status, '') not in ('applied','interview','offer','hired','rejected','no_response','withdrawn')
      and dc.company = s.identity_company and dc.title = s.identity_title
    order by dc.match_updated_at desc nulls last, dc.id asc
    limit 1
  ) dup on true$new6$)
  ) as patches(old_sql, new_sql)
  loop
    if (length(definition) - length(replace(definition, patch.old_sql, '')))
        / length(patch.old_sql) <> 1 then
      raise exception 'Unexpected attention RPC lookup block; review before migrating';
    end if;
    definition := replace(definition, patch.old_sql, patch.new_sql);
  end loop;
  execute definition;
end;
$migration$;
