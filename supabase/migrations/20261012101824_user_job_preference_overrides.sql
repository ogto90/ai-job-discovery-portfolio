CREATE TABLE public.user_job_preference_overrides (
    user_id uuid NOT NULL,
    job_id bigint NOT NULL,
    overridden_preferences text[] NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    accepted_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_job_preference_overrides_pkey PRIMARY KEY (user_id, job_id),
    CONSTRAINT user_job_preference_overrides_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
    CONSTRAINT user_job_preference_overrides_job_id_fkey
        FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT,
    CONSTRAINT user_job_preference_overrides_preferences_check
        CHECK (
            cardinality(overridden_preferences) BETWEEN 1 AND 5
            AND overridden_preferences <@ ARRAY['location', 'work_model', 'language', 'employment_type', 'seniority']::text[]
        )
);

ALTER TABLE public.user_job_preference_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_job_preference_overrides FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.user_job_preference_overrides TO service_role;
