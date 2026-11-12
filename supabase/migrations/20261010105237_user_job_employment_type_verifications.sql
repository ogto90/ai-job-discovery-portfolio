CREATE TABLE public.user_job_employment_type_verifications (
    user_id uuid NOT NULL,
    job_id bigint NOT NULL,
    employment_type text NOT NULL,
    decision text NOT NULL,
    jd_sha256 text NOT NULL,
    verified_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_job_employment_type_verifications_pkey PRIMARY KEY (user_id, job_id),
    CONSTRAINT user_job_employment_type_verifications_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
    CONSTRAINT user_job_employment_type_verifications_job_id_fkey
        FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT,
    CONSTRAINT user_job_employment_type_verifications_type_check
        CHECK (employment_type IN ('contract', 'permanent', 'full_time', 'part_time', 'temporary', 'internship')),
    CONSTRAINT user_job_employment_type_verifications_decision_check
        CHECK (decision IN ('accepted', 'rejected')),
    CONSTRAINT user_job_employment_type_verifications_hash_check
        CHECK (jd_sha256 ~ '^[a-f0-9]{64}$')
);

ALTER TABLE public.user_job_employment_type_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_job_employment_type_verifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.user_job_employment_type_verifications TO service_role;
