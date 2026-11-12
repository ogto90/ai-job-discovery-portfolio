CREATE TABLE public.discovery_candidate_traces (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  search_run_id bigint NOT NULL REFERENCES public.search_runs(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (btrim(source) <> '' AND length(source) <= 120),
  source_query_reference text CHECK (source_query_reference IS NULL OR length(source_query_reference) <= 128),
  source_job_id text CHECK (source_job_id IS NULL OR length(source_job_id) <= 512),
  ats_provider text CHECK (ats_provider IS NULL OR length(ats_provider) <= 40),
  ats_board_id text CHECK (ats_board_id IS NULL OR length(ats_board_id) <= 200),
  ats_requisition_id text CHECK (ats_requisition_id IS NULL OR length(ats_requisition_id) <= 512),
  source_url text CHECK (source_url IS NULL OR length(source_url) <= 2048),
  canonical_url text CHECK (canonical_url IS NULL OR length(canonical_url) <= 2048),
  candidate_identity text NOT NULL CHECK (candidate_identity ~ '^[a-f0-9]{64}$'),
  original_title text CHECK (original_title IS NULL OR length(original_title) <= 512),
  original_company text CHECK (original_company IS NULL OR length(original_company) <= 512),
  stage text NOT NULL CHECK (stage IN (
    'acquisition', 'parsing', 'role_screen', 'preference_screen',
    'verification', 'jd_hydration', 'identity', 'final_eligibility', 'persistence'
  )),
  decision text NOT NULL CHECK (decision IN (
    'passed', 'rejected', 'unknown', 'failed', 'not_attempted',
    'merged', 'persisted', 'suppressed', 'skipped'
  )),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  reason_codes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(reason_codes) <= 64),
  evidence_status text NOT NULL DEFAULT 'partial' CHECK (evidence_status IN (
    'present', 'partial', 'missing', 'conflicting', 'not_checked'
  )),
  physical_job_id bigint REFERENCES public.jobs(id) ON DELETE SET NULL,
  final_outcome text NOT NULL CHECK (length(final_outcome) <= 80),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384
  ),
  CONSTRAINT discovery_candidate_traces_run_identity_key UNIQUE (search_run_id, candidate_identity)
);

COMMENT ON TABLE public.discovery_candidate_traces IS
  'Internal, bounded discovery diagnostics; service_role DELETE is only for configured retention cleanup.';

CREATE INDEX discovery_candidate_traces_run_stage_idx
  ON public.discovery_candidate_traces (search_run_id, stage, decision);
CREATE INDEX discovery_candidate_traces_run_source_reason_idx
  ON public.discovery_candidate_traces (search_run_id, source, reason_code);
CREATE INDEX discovery_candidate_traces_run_outcome_idx
  ON public.discovery_candidate_traces (search_run_id, final_outcome);
CREATE INDEX discovery_candidate_traces_reason_codes_idx
  ON public.discovery_candidate_traces USING gin (reason_codes);
CREATE INDEX discovery_candidate_traces_run_company_idx
  ON public.discovery_candidate_traces (search_run_id, original_company);
CREATE INDEX discovery_candidate_traces_run_job_id_idx
  ON public.discovery_candidate_traces (search_run_id, source_job_id)
  WHERE source_job_id IS NOT NULL;
CREATE INDEX discovery_candidate_traces_run_source_url_idx
  ON public.discovery_candidate_traces (search_run_id, source_url)
  WHERE source_url IS NOT NULL;
CREATE INDEX discovery_candidate_traces_run_query_reference_idx
  ON public.discovery_candidate_traces (search_run_id, source_query_reference)
  WHERE source_query_reference IS NOT NULL;
CREATE INDEX discovery_candidate_traces_run_canonical_url_idx
  ON public.discovery_candidate_traces (search_run_id, canonical_url)
  WHERE canonical_url IS NOT NULL;
CREATE INDEX discovery_candidate_traces_run_ats_board_idx
  ON public.discovery_candidate_traces (search_run_id, ats_board_id)
  WHERE ats_board_id IS NOT NULL;
CREATE INDEX discovery_candidate_traces_run_ats_provider_idx
  ON public.discovery_candidate_traces (search_run_id, ats_provider)
  WHERE ats_provider IS NOT NULL;
CREATE INDEX discovery_candidate_traces_physical_job_idx
  ON public.discovery_candidate_traces (physical_job_id)
  WHERE physical_job_id IS NOT NULL;
CREATE INDEX discovery_candidate_traces_observed_at_idx
  ON public.discovery_candidate_traces (observed_at);

ALTER TABLE public.discovery_candidate_traces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discovery_candidate_traces FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.discovery_candidate_traces TO service_role;
REVOKE ALL ON SEQUENCE public.discovery_candidate_traces_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.discovery_candidate_traces_id_seq TO service_role;
