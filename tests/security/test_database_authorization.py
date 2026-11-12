"""Replay committed migrations in network-isolated PostgreSQL; never use a DSN.

Only this fixture's uniquely named container is created/destroyed. Minimal auth
and storage tables stand in for Supabase platform prerequisites: this is not a
hosted Auth, Storage API, JWT, or PostgREST integration test.
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import time
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "postgres:17.11@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
USER_A = "11111111-1111-4111-8111-111111111111"
USER_B = "22222222-2222-4222-8222-222222222222"
PREPARATION = "33333333-3333-4333-8333-333333333333"


class Database:
    def __init__(self, name):
        self.name = name

    def sql(self, statement, *, role=None, error=None):
        assert role in {None, "anon", "authenticated", "service_role"}
        prefix = f"SET ROLE {role};\n" if role else ""
        result = subprocess.run(
            ["docker", "exec", "-i", self.name, "psql", "-X", "-qAt", "-U", "postgres",
             "-d", "security_test", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
            input=prefix + statement, capture_output=True, text=True, timeout=120,
        )
        if error:
            assert result.returncode != 0, "Forbidden operation unexpectedly succeeded"
            assert f"ERROR:  {error}:" in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()


@pytest.fixture(scope="module")
def database():
    if os.environ.get("AI_JOB_SECURITY_DATABASE_TESTS") != "1":
        pytest.skip("Use the dedicated security regression runner for disposable DB tests")
    # Docker context must resolve locally. Do not allow a remote Docker host.
    context = subprocess.run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
                             capture_output=True, text=True, check=True, timeout=15).stdout.strip()
    if os.environ.get("DOCKER_HOST") or not context.startswith("unix://"):
        pytest.fail("Security database tests require a local Unix-socket Docker daemon")
    name = "ai-job-security-" + uuid.uuid4().hex
    db = Database(name)
    started = False
    try:
        subprocess.run([
            "docker", "create", "--name", name, "--network", "none",
            "--memory", "512m", "--cpus", "1", "--pids-limit", "256",
            "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,size=512m",
            "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=security_test", IMAGE,
        ], check=True, capture_output=True, text=True, timeout=180)
        started = True
        subprocess.run(["docker", "start", name], check=True, capture_output=True, timeout=30)
        for _ in range(60):
            probe = subprocess.run(["docker", "exec", name, "pg_isready", "-U", "postgres", "-d", "security_test"],
                                   capture_output=True, timeout=5)
            # During initdb the temporary server also responds. Wait for the
            # final server (PID 1) rather than racing its shutdown/restart.
            process = subprocess.run(["docker", "exec", name, "cat", "/proc/1/comm"], capture_output=True, timeout=5)
            if probe.returncode == 0 and process.stdout.strip() == b"postgres":
                break
            time.sleep(0.5)
        else:
            pytest.fail("Disposable PostgreSQL did not become ready")
        db.sql("""
            CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
            CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
            CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
            CREATE SCHEMA auth;
            CREATE TABLE auth.users(id uuid PRIMARY KEY);
            CREATE SCHEMA storage;
            CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean,
                file_size_limit bigint, allowed_mime_types text[]);
        """)
        migrations = sorted((ROOT / "supabase/migrations").glob("*.sql"))
        assert migrations, "No migration files found"
        for migration in migrations:
            db.sql(migration.read_text())
        print(f"Replayed {len(migrations)} committed migration files in isolated PostgreSQL.")
        db.sql(f"INSERT INTO auth.users VALUES ('{USER_A}'), ('{USER_B}');")
        # Data operations exercise the application's non-superuser service role.
        db.sql(f"""
            INSERT INTO public.jobs (id, source, company, title) OVERRIDING SYSTEM VALUE
              VALUES (10, 'manual_history', 'Synthetic Employer', 'Synthetic Role'),
                     (11, 'manual_history', 'Synthetic Employer', 'Other Role');
            INSERT INTO public.cv_versions (id,user_id,label,file_path,is_base) OVERRIDING SYSTEM VALUE
              VALUES (20,'{USER_A}','A','synthetic/a.tex',true),
                     (21,'{USER_B}','B','synthetic/b.tex',true);
            INSERT INTO public.applications (id,user_id,job_id,cv_version_id,status) OVERRIDING SYSTEM VALUE
              VALUES (30,'{USER_A}',10,20,'applied'), (31,'{USER_B}',10,21,'applied');
            INSERT INTO public.interview_preparations
              (id,user_id,application_id,job_id,idempotency_key,interview_type,submitted_cv_version_id,source_context)
              VALUES ('{PREPARATION}','{USER_A}',30,10,gen_random_uuid(),'technical',20,'{{"synthetic":true}}');
        """, role="service_role")
        yield db
    finally:
        if started:
            subprocess.run(["docker", "rm", "--force", "--volumes", name], check=True, capture_output=True, timeout=30)


def test_all_application_tables_enable_rls(database):
    assert database.sql("""SELECT relname FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') AND NOT relrowsecurity""") == ""
    assert int(database.sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'")) > 10


@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_browser_roles_have_no_table_sequence_or_function_access(database, role):
    assert database.sql(f"""SELECT c.relname FROM pg_class c
        WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m')
        AND has_table_privilege('{role}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')""") == ""
    assert database.sql(f"""SELECT c.relname FROM pg_class c
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'
        AND CASE WHEN c.relkind='S' THEN has_sequence_privilege('{role}',c.oid,'USAGE,SELECT,UPDATE') ELSE false END""") == ""
    assert database.sql(f"""SELECT p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
        AND has_function_privilege('{role}',p.oid,'EXECUTE')""") == ""
    database.sql("SELECT * FROM public.cv_versions", role=role, error="42501")
    database.sql("UPDATE public.applications SET notes='tampered' WHERE id=30", role=role, error="42501")
    database.sql(f"SELECT public.claim_interview_preparation_pack_generation('{USER_A}','{PREPARATION}',gen_random_uuid(),repeat('a',64))",
                 role=role, error="42501")


def test_rls_denies_browser_rows_even_with_accidental_select_grant(database):
    # Roll back the extra grant: this isolates RLS behavior from ACL denial.
    result = database.sql("""BEGIN;
        GRANT SELECT ON public.cv_versions TO authenticated;
        SET LOCAL ROLE authenticated;
        SELECT count(*) FROM public.cv_versions;
        ROLLBACK;""")
    assert result == "0"


def test_service_role_can_read_but_is_not_a_superuser(database):
    assert database.sql("SELECT rolsuper FROM pg_roles WHERE rolname=current_user", role="service_role") == "f"
    assert database.sql("SELECT count(*) FROM public.cv_versions", role="service_role") == "2"


def test_cross_user_cv_link_is_rejected(database):
    database.sql("UPDATE public.applications SET submitted_cv_version_id=21 WHERE id=30",
                 role="service_role", error="23503")
    assert database.sql("SELECT submitted_cv_version_id IS NULL FROM public.applications WHERE id=30",
                        role="service_role") == "t"


@pytest.mark.parametrize("user,job,cv", [(USER_B, 10, 21), (USER_A, 11, 20), (USER_A, 10, 21)])
def test_mismatched_preparation_references_are_rejected(database, user, job, cv):
    database.sql(f"""INSERT INTO public.interview_preparations
        (user_id,application_id,job_id,idempotency_key,interview_type,submitted_cv_version_id,source_context)
        VALUES ('{user}',30,{job},gen_random_uuid(),'technical',{cv},'{{}}')""",
        role="service_role", error="23503")


def test_frozen_interview_sources_cannot_be_rewritten(database):
    database.sql(f"UPDATE public.interview_preparations SET source_context='{{}}' WHERE id='{PREPARATION}'",
                 role="service_role", error="P0001")
    assert database.sql(f"SELECT source_context->>'synthetic' FROM public.interview_preparations WHERE id='{PREPARATION}'",
                        role="service_role") == "true"


def test_generation_rpc_checks_owner_and_retry_identity(database):
    database.sql(f"SELECT public.claim_interview_preparation_pack_generation('{USER_B}','{PREPARATION}',gen_random_uuid(),repeat('a',64))",
                 role="service_role", error="P0001")
    key = str(uuid.uuid4())
    query = f"SELECT public.claim_interview_preparation_pack_generation('{USER_A}','{PREPARATION}','{key}',repeat('a',64))->>'claimed'"
    assert database.sql(query, role="service_role") == "true"
    assert database.sql(query, role="service_role") == "false"


def test_cv_bucket_is_private(database):
    assert database.sql("SELECT public FROM storage.buckets WHERE id='cv-artifacts'") == "f"
