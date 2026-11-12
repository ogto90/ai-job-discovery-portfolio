"""Real PostgreSQL equivalence tests in a disposable local Docker database.

Run with DASHBOARD_TEST_CONTAINER=dashboard-pagination-test pytest -s <this file>.
The container must have anon/authenticated/service_role cluster roles.
Only a new random database is populated and removed.
"""
import os
from pathlib import Path
import subprocess
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = "20261102135836_attention_reuse_current_state.sql"


def test_paginated_cards_preserve_complete_rpc_responses():
    container = os.environ.get("DASHBOARD_TEST_CONTAINER")
    if not container:
        pytest.skip("Set DASHBOARD_TEST_CONTAINER to a disposable local Postgres container")
    assert container.startswith("dashboard-pagination-test")
    database = "dashboard_test_" + uuid.uuid4().hex

    def sql(query, db=database):
        result = subprocess.run(
            ["docker", "exec", "-i", container, "psql", "-U", "postgres",
             "-d", db, "-X", "-q", "-v", "ON_ERROR_STOP=1"],
            input=query, capture_output=True, text=True, timeout=180,
        )
        assert result.returncode == 0, result.stderr
        return result.stdout + result.stderr

    sql(f"CREATE DATABASE {database}", "postgres")
    try:
        sql("""
            CREATE SCHEMA auth;
            CREATE TABLE auth.users(id uuid PRIMARY KEY);
            CREATE SCHEMA storage;
            CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean,
                file_size_limit bigint, allowed_mime_types text[]);
        """)
        for path in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            if path.name >= MIGRATION:
                break
            sql(path.read_text())
        sql("""
            DO $$ DECLARE f record; BEGIN
              FOR f IN SELECT proname, pg_get_functiondef(oid) AS definition
                FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                AND proname IN ('dashboard_job_page','dashboard_job_attention_page')
              LOOP
                EXECUTE replace(f.definition, 'FUNCTION public.' || f.proname || '(',
                    'FUNCTION public.before_' || f.proname || '(');
              END LOOP;
            END $$;
        """)
        sql((ROOT / "supabase/migrations" / MIGRATION).read_text())
        sql((ROOT / "tests/fixtures/attention_current_state.sql").read_text())
        print(sql((ROOT / "tests/fixtures/attention_current_state_checks.sql").read_text()))
    finally:
        sql(f"DROP DATABASE {database} WITH (FORCE)", "postgres")
