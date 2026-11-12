-- Manual listings are private user-owned jobs. Discovered jobs keep a NULL
-- owner and remain globally shared.
alter table public.jobs
  add column manual_owner_user_id uuid,
  add column manual_jd_sha256 text;

alter table public.jobs
  drop constraint jobs_live_source_url_required;

alter table public.jobs
  add constraint jobs_live_source_url_required
    check (source in ('manual_history', 'manual') or source_url is not null),
  add constraint jobs_manual_owner_fk
    foreign key (manual_owner_user_id) references auth.users(id) on delete cascade,
  add constraint jobs_manual_jd_sha256_check
    check (manual_jd_sha256 is null or manual_jd_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint jobs_manual_ownership_check
    check (
      (source = 'manual' and manual_owner_user_id is not null and manual_jd_sha256 is not null)
      or (source <> 'manual' and manual_owner_user_id is null and manual_jd_sha256 is null)
    );

create unique index jobs_manual_owner_jd_uq
  on public.jobs (manual_owner_user_id, manual_jd_sha256)
  where source = 'manual';

create index jobs_manual_owner_idx
  on public.jobs (manual_owner_user_id, last_seen_at desc)
  where source = 'manual';
