-- Provide a reliable change cursor for incremental dashboard refreshes.
ALTER TABLE public.jobs
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX jobs_updated_at_idx
    ON public.jobs (updated_at DESC);

CREATE FUNCTION public.set_jobs_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
BEGIN
    NEW.updated_at = current_timestamp;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_jobs_updated_at() FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.set_jobs_updated_at() TO service_role;

CREATE TRIGGER jobs_set_updated_at
BEFORE UPDATE ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.set_jobs_updated_at();
