create table public.search_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'completed', 'partial', 'failed')),
  stats jsonb not null default '{}'::jsonb,
  error_message text,
  check (finished_at is null or finished_at >= started_at)
);

create table public.jobs (
  id bigint generated always as identity primary key,
  search_run_id bigint references public.search_runs(id) on delete set null,
  source text not null check (btrim(source) <> ''),
  source_job_id text,
  source_url text not null check (source_url ~* '^https?://'),
  application_url text check (application_url is null or application_url ~* '^https?://'),
  company text not null check (btrim(company) <> ''),
  title text not null check (btrim(title) <> ''),
  location text,
  remote_scope text,
  description text,
  description_kind text not null default 'missing'
    check (description_kind in ('full', 'snippet', 'missing')),
  posted_at timestamptz,
  availability_status text not null default 'unknown'
    check (availability_status in ('active', 'expired', 'unknown', 'validation_failed')),
  review_status text not null default 'new'
    check (review_status in ('new', 'interested', 'ignored')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (source, source_url),
  check (last_seen_at >= first_seen_at)
);

create unique index jobs_source_job_id_uq on public.jobs (source, source_job_id)
  where source_job_id is not null;
create index jobs_review_seen_idx on public.jobs (review_status, first_seen_at desc);
create index jobs_availability_seen_idx on public.jobs (availability_status, last_seen_at desc);
create index jobs_search_run_idx on public.jobs (search_run_id)
  where search_run_id is not null;

create table public.job_evaluations (
  id bigint generated always as identity primary key,
  job_id bigint not null references public.jobs(id) on delete cascade,
  evaluated_at timestamptz not null default now(),
  match_score smallint not null check (match_score between 0 and 100),
  eligibility_status text not null
    check (eligibility_status in ('pass', 'fail', 'unknown')),
  summary text,
  strengths text[] not null default '{}',
  gaps text[] not null default '{}',
  details jsonb not null default '{}'::jsonb
);

create index job_evaluations_job_time_idx
  on public.job_evaluations (job_id, evaluated_at desc);

create table public.cv_versions (
  id bigint generated always as identity primary key,
  job_id bigint references public.jobs(id) on delete set null,
  label text not null check (btrim(label) <> ''),
  file_path text not null check (btrim(file_path) <> ''),
  created_at timestamptz not null default now(),
  notes text
);

create index cv_versions_job_created_idx
  on public.cv_versions (job_id, created_at desc)
  where job_id is not null;

create table public.applications (
  id bigint generated always as identity primary key,
  job_id bigint not null unique references public.jobs(id),
  cv_version_id bigint references public.cv_versions(id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'applied', 'interview', 'offer',
                      'hired', 'rejected', 'no_response', 'withdrawn')),
  applied_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index applications_status_updated_idx
  on public.applications (status, updated_at desc);

create table public.settings (
  id smallint primary key default 1 check (id = 1),
  min_match_score smallint not null default 70
    check (min_match_score between 0 and 100),
  target_roles text[] not null default '{}',
  remote_only boolean not null default true,
  english_only boolean not null default true,
  email_enabled boolean not null default false,
  email_recipient text,
  updated_at timestamptz not null default now(),
  check (not email_enabled or coalesce(btrim(email_recipient), '') <> '')
);

insert into public.settings (target_roles) values
  (array['Security Lead', 'Security Tech Lead', 'Security Engineering Manager',
         'Application Security Lead', 'Security Manager']);

alter table public.search_runs enable row level security;
alter table public.jobs enable row level security;
alter table public.job_evaluations enable row level security;
alter table public.cv_versions enable row level security;
alter table public.applications enable row level security;
alter table public.settings enable row level security;

-- Streamlit uses a server-side service key. No browser/client role is granted access.
revoke all on public.search_runs, public.jobs, public.job_evaluations,
  public.cv_versions, public.applications, public.settings from anon, authenticated;
grant select, insert, update, delete on public.search_runs, public.jobs,
  public.job_evaluations, public.cv_versions, public.applications, public.settings
  to service_role;
