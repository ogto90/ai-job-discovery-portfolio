-- Application clients use the server-side service credential. Trigger helper
-- functions are not client APIs, and future public functions created by the
-- migration owner must not inherit browser-role EXECUTE grants.
REVOKE EXECUTE ON FUNCTION public.set_application_terminal_at()
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_applications_updated_at()
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_user_owned_updated_at()
  FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
