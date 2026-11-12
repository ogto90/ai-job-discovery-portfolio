create temp table cases (
 view_name text default 'All', score_state text default 'All', minimum_fit integer default 0,
 search text default '', archive_category text default 'All', work_model text default 'All',
 page integer default 1, page_size integer default 50,
 failed jsonb default '{}', pending_page integer default 1
);
insert into cases(view_name) select unnest(array['All','Unaddressed','Needs attention',
 'Pending / unresolved','New','Rated','Applications','Active applications','Applied',
 'Interview','Offer','Closed','Archive','Rejected / Closed','unknown']);
insert into cases(view_name,score_state)
select v,s from unnest(array['All','Needs attention','Archive']) v
cross join unnest(array['Scored','Unscored','JD required','Rating failed','Ready to rate']) s;
insert into cases(view_name,page,page_size,pending_page)
select v,p,n,2 from unnest(array['All','Applications','Needs attention']) v
cross join unnest(array[0,1,2,4,999]) p cross join unnest(array[1,7,50,100]) n;
insert into cases(work_model) select unnest(array['Remote','Hybrid','On-site','Unknown']);
insert into cases(minimum_fit) values (40),(90);
insert into cases(search) values (' COMPANY 1 '),('no such company');
insert into cases(view_name,archive_category)
select 'Archive',unnest(array['Archived','Preference mismatches','Not actionable']);
insert into cases(score_state,failed)
select 'Rating failed',jsonb_object_agg(id::text,md5(id::text)||md5(id::text)) from public.jobs;
insert into cases(view_name,score_state,minimum_fit,search,archive_category,work_model,page,page_size,failed,pending_page)
values(null,null,null,null,null,null,null,null,null,null);

create temp table measurements(function_name text, before_ms numeric, after_ms numeric);
do $$
declare
 f text; c record; u uuid; old_result jsonb; new_result jsonb;
 started timestamptz; before_ms numeric; after_ms numeric; comparisons integer:=0;
begin
 for f in select unnest(array['dashboard_job_page','dashboard_job_attention_page']) loop
  if has_function_privilege('authenticated', 'public.'||f||'(uuid,text,text,integer,text,text,text,integer,integer,jsonb,integer)', 'EXECUTE')
    or has_function_privilege('anon', 'public.'||f||'(uuid,text,text,integer,text,text,text,integer,integer,jsonb,integer)', 'EXECUTE') then
   raise exception 'Browser role gained RPC access';
  end if;
  for u in select id from auth.users loop
   for c in select * from cases loop
    started:=clock_timestamp();
    execute format('select public.before_%I($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',f)
     into old_result using u,c.view_name,c.score_state,c.minimum_fit,c.search,c.archive_category,
       c.work_model,c.page,c.page_size,c.failed,c.pending_page;
    before_ms:=extract(epoch from clock_timestamp()-started)*1000;
    started:=clock_timestamp();
    execute format('select public.%I($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',f)
     into new_result using u,c.view_name,c.score_state,c.minimum_fit,c.search,c.archive_category,
       c.work_model,c.page,c.page_size,c.failed,c.pending_page;
    after_ms:=extract(epoch from clock_timestamp()-started)*1000;
    if old_result is distinct from new_result then
      raise exception 'Response mismatch for %, case %',f,row_to_json(c);
    end if;
    comparisons:=comparisons+1;
    insert into measurements values(f,before_ms,after_ms);
   end loop;
  end loop;
 end loop;
 raise notice 'Compared % complete JSON responses successfully',comparisons;
end $$;
select function_name,count(*) as comparisons,
 round(avg(before_ms),2) as before_mean_ms,round(avg(after_ms),2) as after_mean_ms
from measurements group by function_name;

-- Explicit checks prevent a fixture producing only empty pages from passing.
do $$ declare result jsonb; begin
 result:=public.dashboard_job_page('00000000-0000-0000-0000-000000000001','Applications');
 if jsonb_array_length(result->'items')=0 or (result->>'pending_count')::int<=10
   or not exists(select 1 from jsonb_array_elements(result->'items') x where x->>'tailored_cv_id' is not null) then
  raise exception 'Fixture must exercise cards, tailored artifacts and paginated pending counts';
 end if;
end $$;

-- Check fresh reads after mutations, missing context, and completely stale summaries.
do $$ declare f text; phase integer; u uuid:='00000000-0000-0000-0000-000000000001'; a jsonb; b jsonb;
begin
 for phase in 1..5 loop
  if phase=1 then update public.applications set status='withdrawn' where user_id=u;
  elsif phase=2 then update public.cv_versions set artifacts_deleted_at=now() where user_id=u and not is_base;
  elsif phase=3 then update public.user_job_duplicate_reviews set decision='different_listing' where user_id=u;
  elsif phase=4 then update public.cv_versions set is_active=false where user_id=u and is_base;
  else delete from public.dashboard_job_summaries where user_id=u;
  end if;
  for f in select unnest(array['dashboard_job_page','dashboard_job_attention_page']) loop
   execute format('select public.before_%I($1)',f) into a using u;
   execute format('select public.%I($1)',f) into b using u;
   if a is distinct from b then raise exception 'Mutation response mismatch: %, phase %',f,phase; end if;
  end loop;
 end loop;
end $$;
