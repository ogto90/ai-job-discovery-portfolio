do $$
begin
  if not exists (
    select 1
    from storage.buckets b
    join storage.objects o on o.bucket_id = b.id
    where b.id = 'cv-artifacts'
      and b.public = false
      and o.name = 'base/main_example.tex'
  ) then
    raise exception 'Private canonical base CV object is missing from Storage';
  end if;

  insert into public.cv_versions
    (label, storage_bucket, file_path, is_base, is_active, notes)
  select 'Canonical base CV', 'cv-artifacts', 'base/main_example.tex',
         true, true, 'Master LaTeX CV from cv/main_example.tex'
  where not exists (
    select 1 from public.cv_versions where is_base and is_active
  );

  if (select count(*) from public.cv_versions where is_base and is_active
      and storage_bucket = 'cv-artifacts'
      and file_path = 'base/main_example.tex') <> 1 then
    raise exception 'Expected exactly one active canonical base CV at the Storage path';
  end if;
end;
$$;
