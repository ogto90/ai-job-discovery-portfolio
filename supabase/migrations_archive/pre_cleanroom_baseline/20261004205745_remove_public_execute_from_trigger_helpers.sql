-- Trigger helpers are invoked by table triggers, not by client RPC. Remove
-- PostgreSQL's default PUBLIC EXECUTE grant while preserving service_role.
REVOKE EXECUTE ON FUNCTION public.set_application_terminal_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_applications_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_user_owned_updated_at() FROM PUBLIC;
