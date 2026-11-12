CREATE TABLE public.ats_board_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registry_company_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'personio')),
  board_identifier text NOT NULL CHECK (btrim(board_identifier) <> ''),
  normalized_board_identifier text GENERATED ALWAYS AS (lower(btrim(board_identifier))) STORED,
  region text NOT NULL DEFAULT 'default' CHECK (btrim(region) <> ''),
  company_name text NOT NULL CHECK (btrim(company_name) <> ''),
  canonical_board_url text NOT NULL,
  provider_api_url text NOT NULL,
  status text NOT NULL CHECK (status IN ('candidate', 'verified', 'invalid', 'retired')),
  evidence_source text,
  verification_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(verification_evidence) = 'array'),
  verified_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'verified' OR verified_at IS NOT NULL),
  CONSTRAINT ats_board_registry_identity UNIQUE (provider, normalized_board_identifier, region)
);

CREATE INDEX ats_board_registry_status_provider_idx
  ON public.ats_board_registry (status, provider);

ALTER TABLE public.ats_board_registry ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ats_board_registry FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ats_board_registry TO service_role;
