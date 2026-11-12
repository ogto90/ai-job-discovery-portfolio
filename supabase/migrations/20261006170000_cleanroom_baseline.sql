--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-1.pgdg24.04+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: is_suppressed_role(uuid, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_suppressed_role(p_user_id uuid, p_company text, p_title text, p_source text DEFAULT NULL::text, p_source_job_id text DEFAULT NULL::text, p_source_url text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.jobs h
    left join public.applications a on a.job_id = h.id and a.user_id = p_user_id
    left join public.job_reviews r on r.job_id = h.id and r.user_id = p_user_id
    where (
      (h.source_job_id is not null and p_source_job_id is not null
       and h.source = p_source and h.source_job_id = p_source_job_id)
      or (p_source_url is not null
          and (h.source_url = p_source_url or h.application_url = p_source_url))
      or (h.source_job_id is null and h.source_url is null
          and p_source_job_id is null and p_source_url is null
          and lower(regexp_replace(btrim(h.company), '\s+', ' ', 'g')) =
              lower(regexp_replace(btrim(p_company), '\s+', ' ', 'g'))
          and lower(regexp_replace(btrim(h.title), '\s+', ' ', 'g')) =
              lower(regexp_replace(btrim(p_title), '\s+', ' ', 'g')))
    )
    and (a.status in ('applied', 'interview', 'offer', 'hired', 'rejected',
                      'no_response', 'withdrawn') or r.status = 'ignored')
  );
$$;


--
-- Name: set_application_terminal_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_application_terminal_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.status in ('rejected', 'no_response', 'withdrawn') then
    new.terminal_at := coalesce(
      case when tg_op = 'UPDATE' then old.terminal_at end,
      new.terminal_at,
      now()
    );
  else
    new.terminal_at := null;
  end if;
  return new;
end;
$$;


--
-- Name: set_applications_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_applications_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  new.updated_at = current_timestamp;
  return new;
end;
$$;


--
-- Name: set_user_owned_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_user_owned_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  new.updated_at = current_timestamp;
  return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.applications (
    id bigint NOT NULL,
    job_id bigint NOT NULL,
    cv_version_id bigint,
    status text DEFAULT 'draft'::text NOT NULL,
    applied_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    terminal_at timestamp with time zone,
    CONSTRAINT applications_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'applied'::text, 'interview'::text, 'offer'::text, 'hired'::text, 'rejected'::text, 'no_response'::text, 'withdrawn'::text])))
);


--
-- Name: COLUMN applications.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.applications.status IS 'Application lifecycle: rejected means employer rejected candidate; withdrawn means candidate withdrew.';


--
-- Name: applications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.applications ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.applications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: candidate_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.candidate_profiles (
    id bigint NOT NULL,
    cv_version_id bigint NOT NULL,
    schema_version text NOT NULL,
    parser_version text NOT NULL,
    model text NOT NULL,
    input_sha256 text NOT NULL,
    profile_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    user_id uuid NOT NULL,
    CONSTRAINT candidate_profiles_input_sha256_check CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT candidate_profiles_model_check CHECK ((btrim(model) <> ''::text)),
    CONSTRAINT candidate_profiles_parser_version_check CHECK ((btrim(parser_version) <> ''::text)),
    CONSTRAINT candidate_profiles_profile_json_check CHECK ((jsonb_typeof(profile_json) = 'object'::text)),
    CONSTRAINT candidate_profiles_schema_version_check CHECK ((btrim(schema_version) <> ''::text))
);


--
-- Name: TABLE candidate_profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.candidate_profiles IS 'Immutable, versioned CandidateProfile snapshots generated from CV versions. Application code owns full Pydantic validation before insertion.';


--
-- Name: COLUMN candidate_profiles.schema_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.candidate_profiles.schema_version IS 'CandidateProfile data-contract version.';


--
-- Name: COLUMN candidate_profiles.parser_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.candidate_profiles.parser_version IS 'Complete extraction and normalization behavior version, including prompt/template configuration.';


--
-- Name: COLUMN candidate_profiles.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.candidate_profiles.is_active IS 'At most one profile generation may be active for a CV version; historical generations remain preserved.';


--
-- Name: candidate_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.candidate_profiles ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.candidate_profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cv_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cv_versions (
    id bigint NOT NULL,
    job_id bigint,
    label text NOT NULL,
    file_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text,
    storage_bucket text DEFAULT 'cv-artifacts'::text NOT NULL,
    is_base boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    user_id uuid NOT NULL,
    source_cv_version_id bigint,
    tailoring_fingerprint text,
    tex_file_path text,
    pdf_file_path text,
    expires_at timestamp with time zone,
    artifacts_deleted_at timestamp with time zone,
    CONSTRAINT cv_versions_active_must_be_base CHECK (((NOT is_active) OR is_base)),
    CONSTRAINT cv_versions_artifact_expiration_check CHECK (((is_base AND (expires_at IS NULL) AND (artifacts_deleted_at IS NULL)) OR (NOT is_base))),
    CONSTRAINT cv_versions_base_not_job_specific CHECK (((NOT is_base) OR (job_id IS NULL))),
    CONSTRAINT cv_versions_file_path_check CHECK ((btrim(file_path) <> ''::text)),
    CONSTRAINT cv_versions_label_check CHECK ((btrim(label) <> ''::text)),
    CONSTRAINT cv_versions_storage_bucket_check CHECK ((btrim(storage_bucket) <> ''::text)),
    CONSTRAINT cv_versions_tailored_paths_check CHECK ((((tex_file_path IS NULL) AND (pdf_file_path IS NULL)) OR ((tex_file_path IS NOT NULL) AND (pdf_file_path IS NOT NULL)))),
    CONSTRAINT cv_versions_tailoring_fingerprint_check CHECK (((tailoring_fingerprint IS NULL) OR (tailoring_fingerprint ~ '^[0-9a-f]{64}$'::text)))
);


--
-- Name: cv_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cv_versions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.cv_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: job_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_evaluations (
    id bigint NOT NULL,
    job_id bigint NOT NULL,
    evaluated_at timestamp with time zone DEFAULT now() NOT NULL,
    eligibility_status text NOT NULL,
    summary text,
    strengths text[] DEFAULT '{}'::text[] NOT NULL,
    gaps text[] DEFAULT '{}'::text[] NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    scoring_version text NOT NULL,
    model text NOT NULL,
    fit_score numeric(5,2) NOT NULL,
    opportunity_score numeric(5,2),
    requirement_coverage numeric(5,2) NOT NULL,
    evidence_quality text NOT NULL,
    hard_gap_count smallint NOT NULL,
    confidence numeric(5,4) NOT NULL,
    requirement_evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    candidate_profile_id bigint NOT NULL,
    user_id uuid NOT NULL,
    search_profile_id bigint NOT NULL,
    search_profile_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT job_evaluations_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT job_evaluations_eligibility_status_check CHECK ((eligibility_status = ANY (ARRAY['pass'::text, 'fail'::text, 'unknown'::text]))),
    CONSTRAINT job_evaluations_evidence_quality_check CHECK ((evidence_quality = ANY (ARRAY['Low'::text, 'Medium'::text, 'High'::text]))),
    CONSTRAINT job_evaluations_fit_score_check CHECK (((fit_score >= (0)::numeric) AND (fit_score <= (100)::numeric))),
    CONSTRAINT job_evaluations_hard_gap_count_check CHECK ((hard_gap_count >= 0)),
    CONSTRAINT job_evaluations_model_check CHECK ((btrim(model) <> ''::text)),
    CONSTRAINT job_evaluations_opportunity_score_check CHECK (((opportunity_score >= (0)::numeric) AND (opportunity_score <= (100)::numeric))),
    CONSTRAINT job_evaluations_requirement_coverage_check CHECK (((requirement_coverage >= (0)::numeric) AND (requirement_coverage <= (100)::numeric))),
    CONSTRAINT job_evaluations_requirement_evidence_check CHECK ((jsonb_typeof(requirement_evidence) = 'array'::text)),
    CONSTRAINT job_evaluations_scoring_version_check CHECK ((btrim(scoring_version) <> ''::text)),
    CONSTRAINT job_evaluations_snapshot_object_check CHECK (((search_profile_snapshot IS NULL) OR (jsonb_typeof(search_profile_snapshot) = 'object'::text)))
);


--
-- Name: job_evaluations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.job_evaluations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.job_evaluations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: job_match_assessments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_match_assessments (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    job_id bigint NOT NULL,
    candidate_profile_id bigint NOT NULL,
    evaluation_fingerprint text NOT NULL,
    jd_sha256 text NOT NULL,
    job_snapshot jsonb NOT NULL,
    fit_score smallint NOT NULL,
    matcher_version text NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    strengths jsonb DEFAULT '[]'::jsonb NOT NULL,
    gaps jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT job_match_assessments_fingerprint_check CHECK ((evaluation_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT job_match_assessments_fit_score_check CHECK (((fit_score >= 0) AND (fit_score <= 100))),
    CONSTRAINT job_match_assessments_gaps_check CHECK ((jsonb_typeof(gaps) = 'array'::text)),
    CONSTRAINT job_match_assessments_jd_sha256_check CHECK ((jd_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT job_match_assessments_job_snapshot_check CHECK ((jsonb_typeof(job_snapshot) = 'object'::text)),
    CONSTRAINT job_match_assessments_matcher_version_check CHECK ((btrim(matcher_version) <> ''::text)),
    CONSTRAINT job_match_assessments_model_check CHECK ((btrim(model) <> ''::text)),
    CONSTRAINT job_match_assessments_strengths_check CHECK ((jsonb_typeof(strengths) = 'array'::text))
);


--
-- Name: job_match_assessments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.job_match_assessments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.job_match_assessments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: job_metadata_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_metadata_overrides (
    user_id uuid NOT NULL,
    job_id bigint NOT NULL,
    company_override text,
    title_override text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_metadata_overrides_company_check CHECK (((company_override IS NULL) OR ((company_override = btrim(company_override)) AND ((char_length(company_override) >= 1) AND (char_length(company_override) <= 140)) AND (company_override !~ E'[\r\n]'::text)))),
    CONSTRAINT job_metadata_overrides_nonempty_check CHECK (((company_override IS NOT NULL) OR (title_override IS NOT NULL))),
    CONSTRAINT job_metadata_overrides_title_check CHECK (((title_override IS NULL) OR ((title_override = btrim(title_override)) AND ((char_length(title_override) >= 1) AND (char_length(title_override) <= 180)) AND (title_override !~ E'[\r\n]'::text))))
);


--
-- Name: job_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_reviews (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    job_id bigint NOT NULL,
    status text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_reviews_status_check CHECK ((status = ANY (ARRAY['interested'::text, 'ignored'::text])))
);


--
-- Name: job_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.job_reviews ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.job_reviews_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id bigint NOT NULL,
    source text NOT NULL,
    source_job_id text,
    source_url text,
    application_url text,
    company text NOT NULL,
    title text NOT NULL,
    location text,
    remote_scope text,
    description text,
    description_kind text DEFAULT 'missing'::text NOT NULL,
    posted_at timestamp with time zone,
    availability_status text DEFAULT 'unknown'::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    manual_owner_user_id uuid,
    manual_jd_sha256 text,
    employment_type text,
    CONSTRAINT jobs_application_url_check CHECK (((application_url IS NULL) OR (application_url ~* '^https?://'::text))),
    CONSTRAINT jobs_availability_status_check CHECK ((availability_status = ANY (ARRAY['active'::text, 'expired'::text, 'unknown'::text, 'validation_failed'::text]))),
    CONSTRAINT jobs_check CHECK ((last_seen_at >= first_seen_at)),
    CONSTRAINT jobs_company_check CHECK ((btrim(company) <> ''::text)),
    CONSTRAINT jobs_description_kind_check CHECK ((description_kind = ANY (ARRAY['full'::text, 'snippet'::text, 'missing'::text]))),
    CONSTRAINT jobs_employment_type_nonblank CHECK (((employment_type IS NULL) OR (length(btrim(employment_type)) > 0))),
    CONSTRAINT jobs_live_source_url_required CHECK (((source = ANY (ARRAY['manual_history'::text, 'manual'::text])) OR (source_url IS NOT NULL))),
    CONSTRAINT jobs_manual_jd_sha256_check CHECK (((manual_jd_sha256 IS NULL) OR (manual_jd_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT jobs_manual_ownership_check CHECK ((((source = 'manual'::text) AND (manual_owner_user_id IS NOT NULL) AND (manual_jd_sha256 IS NOT NULL)) OR ((source <> 'manual'::text) AND (manual_owner_user_id IS NULL) AND (manual_jd_sha256 IS NULL)))),
    CONSTRAINT jobs_source_check CHECK ((btrim(source) <> ''::text)),
    CONSTRAINT jobs_source_url_check CHECK ((source_url ~* '^https?://'::text)),
    CONSTRAINT jobs_title_check CHECK ((btrim(title) <> ''::text))
);


--
-- Name: jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.jobs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: search_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_profiles (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    definition jsonb NOT NULL,
    min_fit_score smallint DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_profiles_definition_check CHECK ((jsonb_typeof(definition) = 'object'::text)),
    CONSTRAINT search_profiles_min_fit_score_check CHECK (((min_fit_score >= 0) AND (min_fit_score <= 100))),
    CONSTRAINT search_profiles_name_check CHECK ((btrim(name) <> ''::text))
);


--
-- Name: search_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.search_profiles ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.search_profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: search_run_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_run_jobs (
    search_run_id bigint NOT NULL,
    job_id bigint NOT NULL,
    discovered_at timestamp with time zone DEFAULT now() NOT NULL,
    discovery_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT search_run_jobs_discovery_context_check CHECK ((jsonb_typeof(discovery_context) = 'object'::text))
);


--
-- Name: search_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_runs (
    id bigint NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text,
    discovery_mode text DEFAULT 'targeted'::text NOT NULL,
    user_id uuid NOT NULL,
    search_profile_id bigint NOT NULL,
    search_profile_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT search_runs_check CHECK (((finished_at IS NULL) OR (finished_at >= started_at))),
    CONSTRAINT search_runs_discovery_mode_check CHECK ((discovery_mode = ANY (ARRAY['targeted'::text, 'broad'::text]))),
    CONSTRAINT search_runs_snapshot_object_check CHECK (((search_profile_snapshot IS NULL) OR (jsonb_typeof(search_profile_snapshot) = 'object'::text))),
    CONSTRAINT search_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'partial'::text, 'failed'::text])))
);


--
-- Name: search_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.search_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.search_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_job_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_job_verifications (
    user_id uuid NOT NULL,
    job_id bigint NOT NULL,
    verification_status text NOT NULL,
    verification_reason text,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_job_verifications_reason_check CHECK (((verification_status = 'confirmed_live'::text) OR (COALESCE(btrim(verification_reason), ''::text) <> ''::text))),
    CONSTRAINT user_job_verifications_verification_status_check CHECK ((verification_status = ANY (ARRAY['confirmed_live'::text, 'confirmed_closed'::text, 'unable_to_verify'::text])))
);


--
-- Name: TABLE user_job_verifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_job_verifications IS 'Per-user manual listing checks; does not modify the globally shared jobs availability state.';


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id uuid NOT NULL,
    email_enabled boolean DEFAULT false NOT NULL,
    email_recipient text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_preferences_check CHECK (((NOT email_enabled) OR (COALESCE(btrim(email_recipient), ''::text) <> ''::text)))
);


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);


--
-- Name: applications applications_user_job_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_user_job_uq UNIQUE (user_id, job_id);


--
-- Name: candidate_profiles candidate_profiles_id_user_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidate_profiles
    ADD CONSTRAINT candidate_profiles_id_user_uq UNIQUE (id, user_id);


--
-- Name: candidate_profiles candidate_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidate_profiles
    ADD CONSTRAINT candidate_profiles_pkey PRIMARY KEY (id);


--
-- Name: cv_versions cv_versions_id_user_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cv_versions
    ADD CONSTRAINT cv_versions_id_user_uq UNIQUE (id, user_id);


--
-- Name: cv_versions cv_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cv_versions
    ADD CONSTRAINT cv_versions_pkey PRIMARY KEY (id);


--
-- Name: job_evaluations job_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_evaluations
    ADD CONSTRAINT job_evaluations_pkey PRIMARY KEY (id);


--
-- Name: job_match_assessments job_match_assessments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_match_assessments
    ADD CONSTRAINT job_match_assessments_pkey PRIMARY KEY (id);


--
-- Name: job_match_assessments job_match_assessments_user_fingerprint_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_match_assessments
    ADD CONSTRAINT job_match_assessments_user_fingerprint_uq UNIQUE (user_id, evaluation_fingerprint);


--
-- Name: job_metadata_overrides job_metadata_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_metadata_overrides
    ADD CONSTRAINT job_metadata_overrides_pkey PRIMARY KEY (user_id, job_id);


--
-- Name: job_reviews job_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_reviews
    ADD CONSTRAINT job_reviews_pkey PRIMARY KEY (id);


--
-- Name: job_reviews job_reviews_user_id_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_reviews
    ADD CONSTRAINT job_reviews_user_id_job_id_key UNIQUE (user_id, job_id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_source_source_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_source_source_url_key UNIQUE (source, source_url);


--
-- Name: search_profiles search_profiles_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_profiles
    ADD CONSTRAINT search_profiles_id_user_id_key UNIQUE (id, user_id);


--
-- Name: search_profiles search_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_profiles
    ADD CONSTRAINT search_profiles_pkey PRIMARY KEY (id);


--
-- Name: search_profiles search_profiles_user_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_profiles
    ADD CONSTRAINT search_profiles_user_id_name_key UNIQUE (user_id, name);


--
-- Name: search_run_jobs search_run_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_run_jobs
    ADD CONSTRAINT search_run_jobs_pkey PRIMARY KEY (search_run_id, job_id);


--
-- Name: search_runs search_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_runs
    ADD CONSTRAINT search_runs_pkey PRIMARY KEY (id);


--
-- Name: user_job_verifications user_job_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_job_verifications
    ADD CONSTRAINT user_job_verifications_pkey PRIMARY KEY (user_id, job_id);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: applications_status_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_status_updated_idx ON public.applications USING btree (status, updated_at DESC);


--
-- Name: applications_user_status_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_user_status_updated_idx ON public.applications USING btree (user_id, status, updated_at DESC);


--
-- Name: candidate_profiles_cv_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX candidate_profiles_cv_created_idx ON public.candidate_profiles USING btree (cv_version_id, created_at DESC);


--
-- Name: candidate_profiles_one_active_per_cv_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX candidate_profiles_one_active_per_cv_uq ON public.candidate_profiles USING btree (cv_version_id) WHERE is_active;


--
-- Name: candidate_profiles_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX candidate_profiles_user_created_idx ON public.candidate_profiles USING btree (user_id, created_at DESC);


--
-- Name: cv_versions_job_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cv_versions_job_created_idx ON public.cv_versions USING btree (job_id, created_at DESC) WHERE (job_id IS NOT NULL);


--
-- Name: cv_versions_one_active_base_per_user_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cv_versions_one_active_base_per_user_uq ON public.cv_versions USING btree (user_id) WHERE (is_base AND is_active);


--
-- Name: cv_versions_source_cv_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cv_versions_source_cv_created_idx ON public.cv_versions USING btree (source_cv_version_id, created_at DESC) WHERE (source_cv_version_id IS NOT NULL);


--
-- Name: cv_versions_tailored_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cv_versions_tailored_expiry_idx ON public.cv_versions USING btree (user_id, expires_at) WHERE ((NOT is_base) AND (artifacts_deleted_at IS NULL) AND (expires_at IS NOT NULL));


--
-- Name: cv_versions_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cv_versions_user_created_idx ON public.cv_versions USING btree (user_id, created_at DESC);


--
-- Name: cv_versions_user_tailoring_fingerprint_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cv_versions_user_tailoring_fingerprint_uq ON public.cv_versions USING btree (user_id, tailoring_fingerprint) WHERE (tailoring_fingerprint IS NOT NULL);


--
-- Name: job_evaluations_candidate_profile_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_evaluations_candidate_profile_time_idx ON public.job_evaluations USING btree (candidate_profile_id, evaluated_at DESC);


--
-- Name: job_evaluations_job_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_evaluations_job_time_idx ON public.job_evaluations USING btree (job_id, evaluated_at DESC);


--
-- Name: job_evaluations_profile_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_evaluations_profile_time_idx ON public.job_evaluations USING btree (user_id, search_profile_id, evaluated_at DESC);


--
-- Name: job_evaluations_user_job_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_evaluations_user_job_time_idx ON public.job_evaluations USING btree (user_id, job_id, evaluated_at DESC);


--
-- Name: job_match_assessments_user_candidate_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_match_assessments_user_candidate_created_idx ON public.job_match_assessments USING btree (user_id, candidate_profile_id, created_at DESC);


--
-- Name: job_match_assessments_user_job_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_match_assessments_user_job_created_idx ON public.job_match_assessments USING btree (user_id, job_id, created_at DESC);


--
-- Name: job_reviews_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_reviews_user_status_idx ON public.job_reviews USING btree (user_id, status, updated_at DESC);


--
-- Name: jobs_availability_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_availability_seen_idx ON public.jobs USING btree (availability_status, last_seen_at DESC);


--
-- Name: jobs_manual_history_exact_role_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX jobs_manual_history_exact_role_uq ON public.jobs USING btree (lower(btrim(company)), lower(btrim(title))) WHERE (source = 'manual_history'::text);


--
-- Name: jobs_manual_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_manual_owner_idx ON public.jobs USING btree (manual_owner_user_id, last_seen_at DESC) WHERE (source = 'manual'::text);


--
-- Name: jobs_manual_owner_jd_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX jobs_manual_owner_jd_uq ON public.jobs USING btree (manual_owner_user_id, manual_jd_sha256) WHERE (source = 'manual'::text);


--
-- Name: jobs_source_job_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX jobs_source_job_id_uq ON public.jobs USING btree (source, source_job_id) WHERE (source_job_id IS NOT NULL);


--
-- Name: search_profiles_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_profiles_user_active_idx ON public.search_profiles USING btree (user_id, is_active, updated_at DESC);


--
-- Name: search_run_jobs_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_run_jobs_job_idx ON public.search_run_jobs USING btree (job_id, discovered_at DESC);


--
-- Name: search_runs_profile_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_runs_profile_started_idx ON public.search_runs USING btree (search_profile_id, started_at DESC);


--
-- Name: search_runs_user_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_runs_user_started_idx ON public.search_runs USING btree (user_id, started_at DESC);


--
-- Name: applications applications_set_terminal_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER applications_set_terminal_at BEFORE INSERT OR UPDATE OF status ON public.applications FOR EACH ROW EXECUTE FUNCTION public.set_application_terminal_at();


--
-- Name: applications applications_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER applications_set_updated_at BEFORE UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION public.set_applications_updated_at();


--
-- Name: job_metadata_overrides job_metadata_overrides_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_metadata_overrides_set_updated_at BEFORE UPDATE ON public.job_metadata_overrides FOR EACH ROW EXECUTE FUNCTION public.set_user_owned_updated_at();


--
-- Name: job_reviews job_reviews_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_reviews_set_updated_at BEFORE UPDATE ON public.job_reviews FOR EACH ROW EXECUTE FUNCTION public.set_user_owned_updated_at();


--
-- Name: search_profiles search_profiles_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER search_profiles_set_updated_at BEFORE UPDATE ON public.search_profiles FOR EACH ROW EXECUTE FUNCTION public.set_user_owned_updated_at();


--
-- Name: user_preferences user_preferences_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_preferences_set_updated_at BEFORE UPDATE ON public.user_preferences FOR EACH ROW EXECUTE FUNCTION public.set_user_owned_updated_at();


--
-- Name: applications applications_cv_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_cv_user_fk FOREIGN KEY (cv_version_id, user_id) REFERENCES public.cv_versions(id, user_id) ON DELETE RESTRICT;


--
-- Name: applications applications_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: applications applications_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: candidate_profiles candidate_profiles_cv_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidate_profiles
    ADD CONSTRAINT candidate_profiles_cv_user_fk FOREIGN KEY (cv_version_id, user_id) REFERENCES public.cv_versions(id, user_id) ON DELETE RESTRICT;


--
-- Name: candidate_profiles candidate_profiles_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidate_profiles
    ADD CONSTRAINT candidate_profiles_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cv_versions cv_versions_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cv_versions
    ADD CONSTRAINT cv_versions_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: cv_versions cv_versions_source_cv_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cv_versions
    ADD CONSTRAINT cv_versions_source_cv_fk FOREIGN KEY (source_cv_version_id) REFERENCES public.cv_versions(id) ON DELETE RESTRICT;


--
-- Name: cv_versions cv_versions_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cv_versions
    ADD CONSTRAINT cv_versions_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: job_evaluations job_evaluations_candidate_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_evaluations
    ADD CONSTRAINT job_evaluations_candidate_profile_id_fkey FOREIGN KEY (candidate_profile_id) REFERENCES public.candidate_profiles(id) ON DELETE RESTRICT;


--
-- Name: job_evaluations job_evaluations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_evaluations
    ADD CONSTRAINT job_evaluations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT;


--
-- Name: job_evaluations job_evaluations_profile_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_evaluations
    ADD CONSTRAINT job_evaluations_profile_user_fk FOREIGN KEY (search_profile_id, user_id) REFERENCES public.search_profiles(id, user_id) ON DELETE RESTRICT;


--
-- Name: job_evaluations job_evaluations_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_evaluations
    ADD CONSTRAINT job_evaluations_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: job_match_assessments job_match_assessments_candidate_profile_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_match_assessments
    ADD CONSTRAINT job_match_assessments_candidate_profile_user_fk FOREIGN KEY (candidate_profile_id, user_id) REFERENCES public.candidate_profiles(id, user_id) ON DELETE RESTRICT;


--
-- Name: job_match_assessments job_match_assessments_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_match_assessments
    ADD CONSTRAINT job_match_assessments_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT;


--
-- Name: job_match_assessments job_match_assessments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_match_assessments
    ADD CONSTRAINT job_match_assessments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: job_metadata_overrides job_metadata_overrides_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_metadata_overrides
    ADD CONSTRAINT job_metadata_overrides_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT;


--
-- Name: job_metadata_overrides job_metadata_overrides_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_metadata_overrides
    ADD CONSTRAINT job_metadata_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: job_reviews job_reviews_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_reviews
    ADD CONSTRAINT job_reviews_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT;


--
-- Name: job_reviews job_reviews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_reviews
    ADD CONSTRAINT job_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_manual_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_manual_owner_fk FOREIGN KEY (manual_owner_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: search_profiles search_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_profiles
    ADD CONSTRAINT search_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: search_run_jobs search_run_jobs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_run_jobs
    ADD CONSTRAINT search_run_jobs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT;


--
-- Name: search_run_jobs search_run_jobs_search_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_run_jobs
    ADD CONSTRAINT search_run_jobs_search_run_id_fkey FOREIGN KEY (search_run_id) REFERENCES public.search_runs(id) ON DELETE CASCADE;


--
-- Name: search_runs search_runs_profile_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_runs
    ADD CONSTRAINT search_runs_profile_user_fk FOREIGN KEY (search_profile_id, user_id) REFERENCES public.search_profiles(id, user_id) ON DELETE RESTRICT;


--
-- Name: search_runs search_runs_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_runs
    ADD CONSTRAINT search_runs_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_job_verifications user_job_verifications_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_job_verifications
    ADD CONSTRAINT user_job_verifications_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT;


--
-- Name: user_job_verifications user_job_verifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_job_verifications
    ADD CONSTRAINT user_job_verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;

--
-- Name: candidate_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.candidate_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: cv_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cv_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: job_evaluations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_evaluations ENABLE ROW LEVEL SECURITY;

--
-- Name: job_match_assessments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_match_assessments ENABLE ROW LEVEL SECURITY;

--
-- Name: job_metadata_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_metadata_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: job_reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: search_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.search_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: search_run_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.search_run_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: search_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.search_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: user_job_verifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_job_verifications ENABLE ROW LEVEL SECURITY;

--
-- Name: user_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION is_suppressed_role(p_user_id uuid, p_company text, p_title text, p_source text, p_source_job_id text, p_source_url text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_suppressed_role(p_user_id uuid, p_company text, p_title text, p_source text, p_source_job_id text, p_source_url text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_suppressed_role(p_user_id uuid, p_company text, p_title text, p_source text, p_source_job_id text, p_source_url text) TO service_role;


--
-- Name: FUNCTION set_application_terminal_at(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_application_terminal_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_application_terminal_at() TO service_role;


--
-- Name: FUNCTION set_applications_updated_at(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_applications_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_applications_updated_at() TO service_role;


--
-- Name: FUNCTION set_user_owned_updated_at(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_user_owned_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_user_owned_updated_at() TO service_role;


--
-- Name: TABLE applications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.applications TO service_role;


--
-- Name: SEQUENCE applications_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.applications_id_seq TO service_role;


--
-- Name: TABLE candidate_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.candidate_profiles TO service_role;


--
-- Name: SEQUENCE candidate_profiles_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.candidate_profiles_id_seq TO service_role;


--
-- Name: TABLE cv_versions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cv_versions TO service_role;


--
-- Name: SEQUENCE cv_versions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.cv_versions_id_seq TO service_role;


--
-- Name: TABLE job_evaluations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_evaluations TO service_role;


--
-- Name: SEQUENCE job_evaluations_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.job_evaluations_id_seq TO service_role;


--
-- Name: TABLE job_match_assessments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_match_assessments TO service_role;


--
-- Name: SEQUENCE job_match_assessments_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.job_match_assessments_id_seq TO service_role;


--
-- Name: TABLE job_metadata_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_metadata_overrides TO service_role;


--
-- Name: TABLE job_reviews; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_reviews TO service_role;


--
-- Name: SEQUENCE job_reviews_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.job_reviews_id_seq TO service_role;


--
-- Name: TABLE jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.jobs TO service_role;


--
-- Name: SEQUENCE jobs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.jobs_id_seq TO service_role;


--
-- Name: TABLE search_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.search_profiles TO service_role;


--
-- Name: SEQUENCE search_profiles_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.search_profiles_id_seq TO service_role;


--
-- Name: TABLE search_run_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.search_run_jobs TO service_role;


--
-- Name: TABLE search_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.search_runs TO service_role;


--
-- Name: SEQUENCE search_runs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.search_runs_id_seq TO service_role;


--
-- Name: TABLE user_job_verifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_job_verifications TO service_role;


--
-- Name: TABLE user_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_preferences TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--


-- Supabase platform defaults can grant browser-role ACLs to objects created
-- by postgres. The application migration owner is postgres; keep this schema
-- server-only for current and future objects.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Storage is Supabase-managed infrastructure, not part of pg_dump's public
-- application-schema snapshot. Create only the empty private bucket required
-- by this application; never copy Storage objects or owner-specific metadata.
INSERT INTO storage.buckets
  (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('cv-artifacts', 'cv-artifacts', false, NULL, NULL)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
