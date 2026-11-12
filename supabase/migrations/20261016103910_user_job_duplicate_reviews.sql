CREATE TABLE public.user_job_duplicate_reviews (
    user_id uuid NOT NULL,
    job_id bigint NOT NULL,
    matched_job_id bigint NOT NULL,
    decision text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_job_duplicate_reviews_pkey PRIMARY KEY (user_id, job_id),
    CONSTRAINT user_job_duplicate_reviews_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
    CONSTRAINT user_job_duplicate_reviews_job_id_fkey
        FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE,
    CONSTRAINT user_job_duplicate_reviews_matched_job_id_fkey
        FOREIGN KEY (matched_job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT,
    CONSTRAINT user_job_duplicate_reviews_not_self_check CHECK (job_id <> matched_job_id),
    CONSTRAINT user_job_duplicate_reviews_decision_check
        CHECK (decision IN ('same_listing', 'different_listing'))
);

ALTER TABLE public.user_job_duplicate_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_job_duplicate_reviews FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.user_job_duplicate_reviews TO service_role;
