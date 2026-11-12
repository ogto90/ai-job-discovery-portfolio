from pathlib import Path


MIGRATION = Path(__file__).parents[1] / "supabase/migrations/20261019141642_discovery_candidate_traces.sql"


def test_trace_table_is_internal_and_rls_enabled():
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    assert "alter table public.discovery_candidate_traces enable row level security" in sql
    assert "revoke all on table public.discovery_candidate_traces from public, anon, authenticated, service_role" in sql
    assert "grant select, insert, update, delete on table public.discovery_candidate_traces to service_role" in sql
    assert "create policy" not in sql


def test_trace_data_is_bounded_and_linked_to_run_and_physical_job():
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    assert "references public.search_runs(id) on delete cascade" in sql
    assert "references public.jobs(id) on delete set null" in sql
    assert "octet_length(metadata::text) <= 16384" in sql
    assert "length(original_title) <= 512" in sql
    assert "length(original_company) <= 512" in sql
    assert "unique (search_run_id, candidate_identity)" in sql


def test_indexes_match_supported_diagnostic_lookups_and_retention():
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    for index in (
        "(search_run_id, stage, decision)",
        "(search_run_id, source, reason_code)",
        "(search_run_id, final_outcome)",
        "(search_run_id, original_company)",
        "(search_run_id, source_job_id)",
        "(search_run_id, source_url)",
        "(search_run_id, source_query_reference)",
        "(search_run_id, canonical_url)",
        "(search_run_id, ats_board_id)",
        "(search_run_id, ats_provider)",
        "(observed_at)",
    ):
        assert index in sql


def test_migration_does_not_change_existing_job_or_run_tables():
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    assert "create table public.discovery_candidate_traces" in sql
    assert "alter table public.jobs" not in sql
    assert "alter table public.search_runs" not in sql
    assert "delete from public.jobs" not in sql
    assert "delete from public.search_runs" not in sql
