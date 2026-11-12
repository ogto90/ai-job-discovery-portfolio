do $$
begin
  if not exists (
    select 1
    from storage.buckets b
    join storage.objects o on o.bucket_id = b.id
    where b.id = 'cv-artifacts'
      and b.public = false
      and o.name = 'base/main_example_f1eea521.tex'
      and (o.metadata->>'size')::bigint = 10952
  ) then
    raise exception 'New private base CV object is missing or has the wrong size';
  end if;

  if (select count(*) from public.cv_versions where is_base and is_active) <> 1
     or not exists (
       select 1 from public.cv_versions
       where is_base and is_active
         and storage_bucket = 'cv-artifacts'
         and file_path = 'base/main_example.tex'
     ) then
    raise exception 'Expected the previous canonical base CV to be active';
  end if;

  update public.cv_versions
  set is_active = false
  where is_base and is_active;

  insert into public.cv_versions
    (label, storage_bucket, file_path, is_base, is_active, notes)
  values
    ('Canonical base CV - October 2026', 'cv-artifacts',
     'base/main_example_f1eea521.tex', true, true,
     'Source: cv/main_example.tex; SHA-256: f1eea521f0555e3de872b99e8fea873ec33166d6e209cb87bfebcdb6bd59c436');
end;
$$;
