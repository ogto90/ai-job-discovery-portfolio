-- The current Streamlit application accesses public data only through the
-- trusted server credential. Remove the last legacy authenticated policy;
-- RLS and the existing service_role/database-owner grants remain unchanged.
DROP POLICY IF EXISTS user_preferences_owner ON public.user_preferences;
