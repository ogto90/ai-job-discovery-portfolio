-- Add the minimum lineage and cache metadata for user-triggered tailored CVs.
-- Existing base and historical CV rows remain valid with NULL tailored fields.

alter table public.cv_versions
  add column source_cv_version_id bigint,
  add column tailoring_fingerprint text,
  add column tex_file_path text,
  add column pdf_file_path text;

alter table public.cv_versions
  add constraint cv_versions_source_cv_fk
    foreign key (source_cv_version_id) references public.cv_versions(id) on delete restrict,
  add constraint cv_versions_tailoring_fingerprint_check
    check (tailoring_fingerprint is null or tailoring_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint cv_versions_tailored_paths_check
    check ((tex_file_path is null and pdf_file_path is null) or (tex_file_path is not null and pdf_file_path is not null));

create unique index cv_versions_user_tailoring_fingerprint_uq
  on public.cv_versions (user_id, tailoring_fingerprint)
  where tailoring_fingerprint is not null;

create index cv_versions_source_cv_created_idx
  on public.cv_versions (source_cv_version_id, created_at desc)
  where source_cv_version_id is not null;
