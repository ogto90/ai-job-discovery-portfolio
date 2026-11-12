CREATE TABLE public.user_job_work_model_verifications (
    user_id uuid NOT NULL,
    job_id bigint NOT NULL,
    work_model text NOT NULL,
    verified_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_job_work_model_verifications_pkey PRIMARY KEY (user_id, job_id),
    CONSTRAINT user_job_work_model_verifications_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
    CONSTRAINT user_job_work_model_verifications_job_id_fkey
        FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT,
    CONSTRAINT user_job_work_model_verifications_work_model_check
        CHECK (work_model IN ('remote', 'hybrid', 'onsite', 'flexible'))
);

ALTER TABLE public.user_job_work_model_verifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_job_work_model_verifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.user_job_work_model_verifications TO service_role;
