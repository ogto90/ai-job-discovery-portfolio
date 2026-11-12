from pathlib import Path
import os
import subprocess
from urllib.parse import parse_qs, unquote, urlsplit

import pytest


SQL = (Path(__file__).resolve().parents[1] / "supabase/migrations/20261027120937_interview_preparation_packs.sql").read_text()


def test_pack_migration_is_additive_private_and_round_scoped():
    lowered = SQL.casefold()
    assert "create table public.interview_preparation_packs" in lowered
    assert "references public.interview_preparations(preparation_id)" not in lowered
    assert "references public.interview_preparations(id) on delete cascade" in lowered
    assert "enable row level security" in lowered
    assert "revoke all on table public.interview_preparation_packs from public, anon, authenticated, service_role" in lowered
    assert "grant select, insert, update on table public.interview_preparation_packs to service_role" in lowered
    assert "to service_role" in lowered
    assert "grant execute" in lowered
    assert "to anon" not in lowered and "to authenticated" not in lowered
    assert "update public.jobs" not in lowered
    assert "update public.applications" not in lowered


def test_rpc_attempt_key_and_fingerprint_guard_atomic_completion():
    lowered = SQL.casefold()
    assert "attempt_key = p_attempt_key" in lowered
    assert "attempt_fingerprint = p_source_fingerprint" in lowered
    assert "generation_status = 'running'" in lowered
    assert "interval '15 minutes'" in lowered
    fail_function = lowered.split("create or replace function public.fail_interview_preparation_pack_generation", 1)[1]
    fail_update = fail_function.split("$$;", 1)[0]
    assert "pack_json =" not in fail_update
    assert "where preparation_id = p_preparation_id" in fail_update


def test_pack_migration_effective_permissions_on_disposable_postgres():
    database_url = os.getenv("INTERVIEW_PREP_PACK_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("disposable PostgreSQL URL not configured")

    parsed = urlsplit(database_url)
    test_project_ref = "uquwtcfdbawupvdmrtzb"
    api_url = urlsplit(os.getenv("INTERVIEW_PREP_PACK_TEST_SUPABASE_URL", ""))
    if (
        api_url.hostname != f"{test_project_ref}.supabase.co"
        or test_project_ref not in (parsed.username or "")
        or not (parsed.hostname or "").endswith(".pooler.supabase.com")
    ):
        pytest.fail("Refusing migration test: database URL is not the approved disposable Supabase project")

    privileges = "'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'"
    migration = SQL
    verification = f"""
BEGIN;
SELECT to_regclass('public.interview_preparation_packs') IS NOT NULL AS had_packs \\gset
CREATE TEMP TABLE _interview_pack_existing_acl ON COMMIT DROP AS
SELECT c.relname, r.rolname, c.relrowsecurity, p.privilege,
       has_table_privilege(r.rolname, c.oid, p.privilege) AS allowed
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('service_role'), ('anon'), ('authenticated')) AS r(rolname)
CROSS JOIN (VALUES ({privileges})) AS p(privilege)
WHERE n.nspname = 'public'
  AND c.relname IN ('applications', 'interview_preparations');
DO $$
BEGIN
  IF to_regclass('public.interview_preparation_packs') IS NOT NULL THEN
    IF to_regclass('public._interview_preparation_packs_pretest_original') IS NOT NULL THEN
      RAISE EXCEPTION 'temporary migration-test table name already exists';
    END IF;
    ALTER TABLE public.interview_preparation_packs
      RENAME TO _interview_preparation_packs_pretest_original;
  END IF;
END;
$$;
{migration}
DO $$
DECLARE
  target oid := 'public.interview_preparation_packs'::regclass;
  privilege text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = target) THEN
    RAISE EXCEPTION 'RLS is not enabled on interview_preparation_packs';
  END IF;

  FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
    IF NOT has_table_privilege('service_role', target, privilege) THEN
      RAISE EXCEPTION 'service_role lacks expected % permission', privilege;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role', target, 'DELETE') THEN
    RAISE EXCEPTION 'service_role retains effective DELETE permission';
  END IF;

  FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('anon', target, privilege) THEN
      RAISE EXCEPTION 'anon retains effective % permission', privilege;
    END IF;
    IF has_table_privilege('authenticated', target, privilege) THEN
      RAISE EXCEPTION 'authenticated retains effective % permission', privilege;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM _interview_pack_existing_acl before_acl
    FULL JOIN (
      SELECT c.relname, r.rolname, c.relrowsecurity, p.privilege,
             has_table_privilege(r.rolname, c.oid, p.privilege) AS allowed
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('service_role'), ('anon'), ('authenticated')) AS r(rolname)
      CROSS JOIN (VALUES ({privileges})) AS p(privilege)
      WHERE n.nspname = 'public'
        AND c.relname IN ('applications', 'interview_preparations')
    ) after_acl USING (relname, rolname, relrowsecurity, privilege, allowed)
    WHERE before_acl.relname IS NULL OR after_acl.relname IS NULL
  ) THEN
    RAISE EXCEPTION 'existing applications/interview_preparations ACL or RLS state changed';
  END IF;
END;
$$;
ROLLBACK;
SELECT CASE
  WHEN to_regclass('public._interview_preparation_packs_pretest_original') IS NULL
   AND (:'had_packs'::boolean = (to_regclass('public.interview_preparation_packs') IS NOT NULL))
  THEN 'ROLLBACK_VERIFIED'
  ELSE 'ROLLBACK_FAILED'
END;
"""
    env = {
        **os.environ,
        "PGPASSWORD": unquote(parsed.password or ""),
        "PGSSLMODE": parse_qs(parsed.query).get("sslmode", ["require"])[0],
    }
    command = [
        "psql", "-X", "-qAt", "-h", parsed.hostname or "",
        "-p", str(parsed.port or 5432), "-U", unquote(parsed.username or ""),
        "-d", unquote(parsed.path.lstrip("/")), "-v", "ON_ERROR_STOP=1",
    ]
    result = subprocess.run(
        command, input=verification, capture_output=True, text=True,
        env=env, timeout=90,
    )
    assert result.returncode == 0, (
        "Disposable migration/ACL regression failed. "
        f"psql exit={result.returncode}; stderr={result.stderr[-2000:]}"
    )
    assert result.stdout.strip().endswith("ROLLBACK_VERIFIED"), (
        "Disposable migration test did not restore the original schema."
    )
