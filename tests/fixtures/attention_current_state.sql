-- Synthetic records only, including another tenant and tied ordering keys.
insert into auth.users values ('00000000-0000-0000-0000-000000000001'),
 ('00000000-0000-0000-0000-000000000002');
insert into public.cv_versions(user_id,label,file_path,is_base,is_active)
select id,'base','fixture/base.pdf',true,true from auth.users;
insert into public.candidate_profiles(user_id,cv_version_id,schema_version,parser_version,
 model,input_sha256,profile_json,is_active)
select cv.user_id,cv.id,'test','test','test',repeat('a',64),'{}',active
from public.cv_versions cv cross join unnest(array[true,false]) active;
insert into public.jobs(source,source_url,company,title,description_kind,availability_status,manual_owner_user_id,manual_jd_sha256)
select case when n%19=0 then 'manual' else 'test' end,
 'https://example.test/jobs/'||n,'Company '||(n/4),'Security Engineer '||(n/4),
 case when n%3=0 then 'snippet' else 'full' end,
 case when n%17=0 then 'expired' else 'active' end,
 case when n%19=0 then '00000000-0000-0000-0000-000000000002'::uuid end,
 case when n%19=0 then md5(n::text)||md5(n::text) end
from generate_series(1,240) n;
insert into public.applications(user_id,job_id,status,applied_at,status_changed_at)
select u.id,j.id,(array['applied','interview','offer','hired','rejected','withdrawn','no_response'])[1+j.id%7],
 '2026-10-01'::timestamptz,'2026-10-02'::timestamptz
from auth.users u cross join public.jobs j where j.id%4=0;
insert into public.job_reviews(user_id,job_id,status)
select u.id,j.id,case when j.id%2=0 then 'ignored' else 'archived' end
from auth.users u cross join public.jobs j where j.id%11=0;
insert into public.job_match_assessments(user_id,job_id,candidate_profile_id,
 evaluation_fingerprint,jd_sha256,job_snapshot,fit_score,matcher_version,model)
select cp.user_id,j.id,cp.id,
 case when cp.is_active then md5(j.id::text)||md5(j.id::text) else md5('old'||j.id)||md5('old'||j.id) end,
 repeat('d',64),'{}',(j.id%5)*20,'holistic_fit_v1','fixture'
from public.jobs j cross join public.candidate_profiles cp
where (j.id%3=0 and cp.is_active) or (j.id%3=1 and not cp.is_active);
-- Multiple assessments per job, tied timestamps, and a non-current matcher.
insert into public.job_match_assessments(user_id,job_id,candidate_profile_id,
 evaluation_fingerprint,jd_sha256,job_snapshot,fit_score,matcher_version,model,created_at)
select a.user_id,a.job_id,a.candidate_profile_id,
 md5('new'||a.job_id)||md5('new'||a.job_id),a.jd_sha256,'{}',35,
 'holistic_fit_v1','fixture',a.created_at
from public.job_match_assessments a where a.job_id%9=0;
insert into public.job_match_assessments(user_id,job_id,candidate_profile_id,
 evaluation_fingerprint,jd_sha256,job_snapshot,fit_score,matcher_version,model)
select a.user_id,a.job_id,a.candidate_profile_id,
 md5('other'||a.job_id)||md5('other'||a.job_id),a.jd_sha256,'{}',99,
 'other_matcher','fixture'
from public.job_match_assessments a where a.job_id%9=0 and a.fit_score=35;
insert into public.cv_versions(user_id,job_id,label,file_path,source_cv_version_id,
 tex_file_path,pdf_file_path,created_at,expires_at,artifacts_deleted_at)
select cv.user_id,j.id,'tailored','fixture/file.pdf',cv.id,
 'fixture/'||n||'.tex','fixture/'||n||'.pdf','2026-10-01'::timestamptz,
 '2026-10-31'::timestamptz,case when j.id%7=0 then '2026-10-30'::timestamptz end
from public.jobs j cross join public.cv_versions cv cross join generate_series(1,2) n
where cv.is_base;
insert into public.dashboard_job_summaries(user_id,job_id,job_updated_at,profile_revision,
 job_revision,summary_algorithm_version,input_fingerprint,identity_company,identity_title,summary)
select u.user_id,j.id,j.updated_at,u.profile_revision,1,2,repeat('e',64),j.company,j.title,
 jsonb_build_object('id',j.id,'company',j.company,'title',j.title,
 'active_profile_id',cp.id,'fit_fingerprint',md5(j.id::text)||md5(j.id::text),
 'description_kind',j.description_kind,'description_available',true,
 'availability_status',j.availability_status,'static_actionable',j.id%5<>0,
 'static_decision_state',case when j.id%5=0 then 'not_actionable' when j.id%7=0 then 'pending' else 'ready' end,
 'static_reason_code',case when j.id%5=0 then 'location_incompatible' else 'ready' end,
 'metadata_unresolved',j.id%7=0,'last_seen_at',case when j.id%13=0 then null else '2026-10-01T00:00:00Z' end,
 'remote_scope',(array['Remote','Hybrid','On-site',''])[1+j.id%4], 'location','')
from public.jobs j cross join public.dashboard_summary_user_state u
join public.candidate_profiles cp on cp.user_id=u.user_id and cp.is_active
where j.id%23<>0;
-- A current fingerprint may reuse another job's assessment.
update public.dashboard_job_summaries
set summary=jsonb_set(summary,'{fit_fingerprint}',to_jsonb(md5('27')||md5('27')))
where job_id=26;
insert into public.user_job_duplicate_reviews(user_id,job_id,matched_job_id,decision)
select u.id,j.id,(j.id/4)*4,case when j.id%2=0 then 'same_listing' else 'different_listing' end
from auth.users u cross join public.jobs j
where j.id>4 and j.id%4<>0 and j.id%3=0;
update public.dashboard_job_summaries set profile_revision=0 where job_id%29=0;
update public.dashboard_job_summaries set job_revision=0 where job_id%31=0;
update public.dashboard_job_summaries set summary_algorithm_version=0 where job_id%37=0;
update public.jobs set title=title||' changed' where id%41=0;
analyze;
