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
MIGRATION = "20261102152154_dashboard_summary_content_revision.sql"


def test_observation_updates_preserve_summaries_and_content_updates_invalidate():
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
        sql((ROOT / "tests/fixtures/attention_current_state.sql").read_text())
        sql((ROOT / "supabase/migrations" / MIGRATION).read_text())
        print(sql((ROOT / "tests/fixtures/egress_summary_checks.sql").read_text()))
    finally:
        sql(f"DROP DATABASE {database} WITH (FORCE)", "postgres")
