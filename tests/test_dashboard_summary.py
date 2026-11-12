from dataclasses import fields, replace
import json

import pytest
from matching.candidate_profile_persistence import PersistenceError

from ui.dashboard_data import (
    DashboardJob,
    filter_dashboard_jobs,
    merge_dashboard_rows,
    resolve_duplicate_review_matches,
)
from ui.dashboard_summary import (
    DETAIL_FIELDS,
    PAGE_SIZE,
    bounded_dashboard_enabled,
    build_dashboard_summaries,
    compact_job_summary,
    fetch_dashboard_page,
    normalize_dashboard_identity,
    summary_input_fingerprint,
    validate_supabase_target,
)


def _job(job_id: int, *, score: int | None = None, status: str = "new", **updates) -> DashboardJob:
    base = DashboardJob(
        id=job_id, source="test", company=f"Company {job_id}",
        title=f"Security Engineer {job_id}", location="Europe", remote_scope="Remote",
        source_url=f"https://example.test/{job_id}", application_url=None,
        availability_status="active", verification_status="verified", review_status=status,
        posted_at=None, first_seen_at="2026-10-01T00:00:00Z", last_seen_at="2026-10-10T00:00:00Z",
        fit_score=score, fit_assessment_id=job_id if score is not None else None,
        role_eligibility="target_match", location_eligibility="eligible",
        work_model_eligibility="eligible", language_eligibility="eligible",
        employment_type_eligibility="eligible", seniority_eligibility="eligible",
        description="A full security role description." if score is None else None,
        description_kind="full" if score is None else "full",
        description_available=True,
    )
    return replace(base, **updates)


def _json_value(value):
    if isinstance(value, tuple):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return value


def _summary_card(job: DashboardJob) -> dict:
    card = {
        **compact_job_summary(job, active_profile_id=13),
        "review_status": job.review_status,
        "fit_score": job.fit_score,
        "fit_assessment_id": job.fit_assessment_id,
        "description": None,
        "fit_strengths": [],
        "fit_gaps": [],
        "fit_job_snapshot": None,
        "active_profile_id": 13,
    }
    for name in (
        "tailored_cv_id", "tailored_cv_bucket", "tailored_tex_path", "tailored_pdf_path",
        "tailored_expires_at", "tailored_artifacts_deleted_at",
    ):
        card[name] = getattr(job, name)
    return card


def test_summary_is_compact_and_preserves_python_eligibility_decision():
    job = _job(1, fit_strengths=("Owned incident response",), fit_gaps=("No cloud evidence",))
    summary = compact_job_summary(job, active_profile_id=22)

    assert not DETAIL_FIELDS.intersection(summary)
    assert summary["description_available"] is True
    assert summary["static_actionable"] is job.actionable
    assert summary["static_decision_state"] == job.decision.state
    fields_allowed = {field.name for field in fields(DashboardJob)}
    restored = DashboardJob(**{
        "review_status": "new", "fit_score": None, "fit_assessment_id": None,
        **{key: value for key, value in summary.items() if key in fields_allowed},
    })
    assert restored.ready_to_rate == job.ready_to_rate
    assert restored.jd_required == job.jd_required
    assert restored.actionable == job.actionable


def test_summary_dependency_fingerprint_changes_for_every_revision_and_content():
    job = _job(1)
    base = summary_input_fingerprint(
        job, job_updated_at="2026-10-31T12:00:00Z", profile_revision=3, job_revision=5,
    )
    assert summary_input_fingerprint(
        job, job_updated_at="2026-10-31T12:00:01Z", profile_revision=3, job_revision=5,
    ) != base
    assert summary_input_fingerprint(
        job, job_updated_at="2026-10-31T12:00:00Z", profile_revision=4, job_revision=5,
    ) != base
    assert summary_input_fingerprint(
        job, job_updated_at="2026-10-31T12:00:00Z", profile_revision=3, job_revision=6,
    ) != base


def test_app_and_worker_must_use_the_same_explicit_supabase_endpoint():
    assert validate_supabase_target("http://127.0.0.1:54321/", "http://127.0.0.1:54321") == "http://127.0.0.1:54321"
    with pytest.raises(PersistenceError, match="does not match the expected test target"):
        validate_supabase_target("https://one.supabase.co", "https://two.supabase.co")


@pytest.mark.parametrize("value", ["1", "true", "YES", "on"])
def test_summary_activation_flag_is_explicit(value):
    assert bounded_dashboard_enabled(value)


@pytest.mark.parametrize("value", ["false", "0", "off"])
def test_summary_activation_can_be_explicitly_disabled(value):
    assert not bounded_dashboard_enabled(value)


def test_legacy_profile_and_stale_assessment_semantics_remain_the_reference():
    listing = {
        "id": 7, "source": "manual", "company": "Example", "title": "Security Engineer",
        "description": "Full description", "description_kind": "full", "availability_status": "active",
    }
    previous = merge_dashboard_rows(
        [listing], [], [{
            "id": 10, "job_id": 7, "candidate_profile_id": 2, "fit_score": 77,
            "matcher_version": "holistic_fit_v1", "evaluation_fingerprint": "a" * 64,
            "created_at": "2026-10-01T00:00:00Z",
        }],
        current_fit_fingerprints={7: "b" * 64}, active_profile_id=3,
        classified_description_kinds={7: "full"},
    )[0]
    assert previous.previous_profile_rating
    assert previous.historical_fit_score == 77
    assert previous.review_status == "rated"
    assert not previous.ready_to_rate
    assert previous.has_fit_history

    stale_same_profile = merge_dashboard_rows(
        [listing], [], [{
            "id": 11, "job_id": 7, "candidate_profile_id": 3, "fit_score": 77,
            "matcher_version": "holistic_fit_v1", "evaluation_fingerprint": "a" * 64,
            "created_at": "2026-10-01T00:00:00Z",
        }],
        current_fit_fingerprints={7: "b" * 64}, active_profile_id=3,
        classified_description_kinds={7: "full"},
    )[0]
    assert stale_same_profile.historical_fit_score == 77
    assert not stale_same_profile.previous_profile_rating
    assert stale_same_profile.ready_to_rate


def test_duplicate_identity_is_resolved_across_page_boundaries_by_global_set():
    historical = _job(1, company="Xtel", title="Cybersecurity Engineer", application_status="rejected", status="rejected")
    fresh = _job(80, company="XTEL", title="Cybersecurity Engineer")
    global_rows = resolve_duplicate_review_matches([historical, *(_job(i) for i in range(2, 80)), fresh])
    candidate = next(row for row in global_rows if row.id == 80)
    assert candidate.duplicate_review_status == "pending"
    assert candidate.duplicate_match_job_id == 1
    assert candidate not in filter_dashboard_jobs(global_rows, review_status="Unaddressed", score_state="Ready to rate")
    assert normalize_dashboard_identity("Xtel") == normalize_dashboard_identity("XTEL")


def test_page_rpc_is_bounded_and_stable_for_a_large_mock_dataset():
    class MockClient:
        base_url = "https://test.example"

        def __init__(self, rows):
            self.rows = rows
            self.calls = []

        def json_request(self, method, path, payload):
            self.calls.append((method, path, payload))
            assert method == "POST"
            expected_rpc = (
                "dashboard_job_attention_page"
                if payload["p_view"] == "Needs attention"
                else "dashboard_job_page"
            )
            assert path == f"/rest/v1/rpc/{expected_rpc}"
            assert payload["p_page_size"] == PAGE_SIZE
            start = (payload["p_page"] - 1) * payload["p_page_size"]
            selected = self.rows[start:start + payload["p_page_size"]]
            return {
                "items": [_json_value(_summary_card(row)) for row in selected],
                "total_count": len(self.rows), "page": payload["p_page"],
                "page_size": PAGE_SIZE, "pending_count": 2, "pending_duplicate_count": 1,
                "pending_preview": [{"job_id": 900, "company": "A", "title": "B"}],
                "pending_preview_page": 1, "pending_preview_pages": 1,
                "complete": False, "cv_version_id": 12,
                "storage_bucket": "cv-artifacts", "active_profile_id": 13,
            }

    rows = [_job(index) for index in range(1, 124)]
    rows[0] = replace(rows[0], tailored_cv_id=456, tailored_cv_bucket="cv-artifacts",
                      tailored_pdf_path="user/tailored/job.pdf")
    client = MockClient(rows)
    pages = [
        fetch_dashboard_page(client, user_id="user-1", filters={
            "page": number, "search": "sec", "view": "Needs attention",
        })
        for number in (1, 2, 3)
    ]
    ids = [job.id for page in pages for job in page.jobs]
    assert [len(page.jobs) for page in pages] == [50, 50, 23]
    assert ids == list(range(1, 124))
    assert len(ids) == len(set(ids))
    assert all(not job.description and not job.fit_strengths and not job.fit_gaps for page in pages for job in page.jobs)
    assert all(page.pending_count == 2 and not page.complete for page in pages)
    assert all(page.pending_duplicate_count == 1 for page in pages)
    assert pages[0].jobs[0].tailored_cv_id == 456
    assert all(call[2]["p_search"] == "sec" for call in client.calls)


def test_rpc_preserves_single_row_table_result_shape():
    from ui.dashboard_summary import _rpc

    class MockClient:
        def json_request(self, method, path, payload):
            assert method == "POST"
            assert path == "/rest/v1/rpc/dashboard_summary_next_batch"
            return [{"job_id": 7}]

    assert _rpc(MockClient(), "dashboard_summary_next_batch", {}) == [{"job_id": 7}]


@pytest.mark.parametrize("dataset_size", [50, 123, 1000])
def test_page_response_rows_remain_bounded_as_history_grows(dataset_size):
    class MockClient:
        base_url = "https://test.example"

        def __init__(self):
            self.returned_rows = 0
            self.response_bytes = 0

        def json_request(self, _method, _path, payload):
            start = (payload["p_page"] - 1) * payload["p_page_size"]
            rows = [_summary_card(_job(index + 1)) for index in range(start, min(start + PAGE_SIZE, dataset_size))]
            self.returned_rows = len(rows)
            self.response_bytes = len(json.dumps({"items": rows}).encode("utf-8"))
            return {"items": rows, "total_count": dataset_size, "page": payload["p_page"],
                    "page_size": PAGE_SIZE, "pending_count": 0, "pending_preview": [],
                    "pending_preview_page": 1, "pending_preview_pages": 1,
                    "complete": True, "cv_version_id": 1, "storage_bucket": "cv",
                    "active_profile_id": 2}

    client = MockClient()
    page = fetch_dashboard_page(client, user_id="user-1", filters={"page": 1})
    assert len(page.jobs) == min(PAGE_SIZE, dataset_size)
    assert client.returned_rows <= PAGE_SIZE
    assert client.response_bytes < PAGE_SIZE * 4_000


def test_summary_builder_retries_stale_writes_and_publishes_only_validated_batch(monkeypatch):
    import ui.dashboard as dashboard
    import ui.dashboard_summary as summary

    job = _job(7)
    stamps = {
        "job_updated_at": "2026-10-31T12:00:00Z",
        "profile_revision": 4,
        "job_revision": 2,
    }
    next_calls = 0
    store_payloads = []

    def fake_rpc(_client, name, payload):
        nonlocal next_calls
        if name == "dashboard_summary_next_batch":
            next_calls += 1
            return [{"job_id": 7, "observed_job_updated_at": stamps["job_updated_at"],
                     "observed_profile_revision": stamps["profile_revision"],
                     "observed_job_revision": stamps["job_revision"]}] if next_calls == 1 else []
        if name == "dashboard_summary_store_batch":
            store_payloads.extend(payload["p_rows"])
            assert len(payload["p_rows"]) <= 50
            assert not DETAIL_FIELDS.intersection(payload["p_rows"][0]["summary"])
            return {"saved": 1, "stale": 0}
        raise AssertionError(name)

    monkeypatch.setattr(summary, "_rpc", fake_rpc)
    monkeypatch.setattr(dashboard, "_load_dashboard_context_rows",
                        lambda *_args, **_kwargs: ([job], 13, "user-1", 12, "cv-artifacts"))
    result = build_dashboard_summaries(object(), user_id="user-1", max_batches=2)
    assert result == {"batches": 1, "saved": 1, "stale": 0, "remaining": False}
    assert next_calls == 3
    assert store_payloads[0]["profile_revision"] == 4
    assert store_payloads[0]["input_fingerprint"] == summary_input_fingerprint(
        job, job_updated_at=stamps["job_updated_at"], profile_revision=4, job_revision=2,
    )


def test_summary_builder_can_resume_after_inputs_change_mid_build(monkeypatch):
    import ui.dashboard as dashboard
    import ui.dashboard_summary as summary

    job = _job(9)
    stamps = {
        "job_updated_at": "2026-10-31T12:00:00Z",
        "profile_revision": 4,
        "job_revision": 2,
    }
    state = {"next_calls": 0, "store_calls": 0}

    def fake_rpc(_client, name, payload):
        if name == "dashboard_summary_next_batch":
            state["next_calls"] += 1
            return ([{"job_id": 9, "observed_job_updated_at": stamps["job_updated_at"],
                      "observed_profile_revision": stamps["profile_revision"],
                      "observed_job_revision": stamps["job_revision"]}]
                    if state["next_calls"] in {1, 2, 3} else [])
        if name == "dashboard_summary_store_batch":
            state["store_calls"] += 1
            # First worker detects a changed source revision and safely refuses
            # to publish; the next invocation observes/builds the new revision.
            return {"saved": 0, "stale": 1} if state["store_calls"] == 1 else {"saved": 1, "stale": 0}
        raise AssertionError(name)

    monkeypatch.setattr(summary, "_rpc", fake_rpc)
    monkeypatch.setattr(dashboard, "_load_dashboard_context_rows",
                        lambda *_args, **_kwargs: ([job], 13, "user-1", 12, "cv-artifacts"))

    first = summary.build_dashboard_summaries(object(), user_id="user-1", max_batches=1)
    second = summary.build_dashboard_summaries(object(), user_id="user-1", max_batches=2)
    assert first == {"batches": 1, "saved": 0, "stale": 1, "remaining": True}
    assert second == {"batches": 1, "saved": 1, "stale": 0, "remaining": False}
    assert state["store_calls"] == 2


def test_summary_builder_can_rebuild_exactly_one_requested_job(monkeypatch):
    import ui.dashboard as dashboard
    import ui.dashboard_summary as summary

    job = _job(23)
    calls = []
    next_calls = 0

    def fake_rpc(_client, name, payload):
        nonlocal next_calls
        calls.append((name, payload))
        if name == "dashboard_summary_selected_batch":
            next_calls += 1
            assert payload["p_job_ids"] == [23]
            assert payload["p_limit"] in {1, PAGE_SIZE}
            return ([{"job_id": 23, "observed_job_updated_at": "2026-10-31T12:00:00Z",
                      "observed_profile_revision": 4, "observed_job_revision": 3}]
                    if next_calls == 1 else [])
        if name == "dashboard_summary_store_batch":
            assert [row["job_id"] for row in payload["p_rows"]] == [23]
            return {"saved": 1, "stale": 0}
        raise AssertionError(name)

    monkeypatch.setattr(summary, "_rpc", fake_rpc)
    monkeypatch.setattr(
        dashboard, "_load_dashboard_context_rows",
        lambda *_args, **_kwargs: ([job], 13, "user-1", 12, "cv-artifacts"),
    )
    assert build_dashboard_summaries(object(), user_id="user-1", target_job_id=23) == {
        "batches": 1, "saved": 1, "stale": 0, "remaining": False,
    }
    assert [name for name, _ in calls] == [
        "dashboard_summary_selected_batch", "dashboard_summary_store_batch",
        "dashboard_summary_selected_batch",
    ]


def test_summary_builder_prioritizes_discovery_ids_in_bounded_batches(monkeypatch):
    import ui.dashboard as dashboard
    import ui.dashboard_summary as summary

    jobs = [_job(8), _job(12)]
    calls = []
    selected_calls = 0

    def fake_rpc(_client, name, payload):
        nonlocal selected_calls
        calls.append((name, payload))
        if name == "dashboard_summary_selected_batch":
            selected_calls += 1
            assert payload["p_job_ids"] == [8, 12]
            if selected_calls == 1:
                return [
                    {"job_id": job_id, "observed_job_updated_at": "2026-10-31T12:00:00Z",
                     "observed_profile_revision": 4, "observed_job_revision": 2}
                    for job_id in (8, 12)
                ]
            return []
        if name == "dashboard_summary_store_batch":
            assert [row["job_id"] for row in payload["p_rows"]] == [8, 12]
            return {"saved": 2, "stale": 0}
        raise AssertionError(name)

    monkeypatch.setattr(summary, "_rpc", fake_rpc)
    monkeypatch.setattr(
        dashboard, "_load_dashboard_context_rows",
        lambda *_args, **_kwargs: (jobs, 13, "user-1", 12, "cv-artifacts"),
    )

    result = build_dashboard_summaries(
        object(), user_id="user-1", max_batches=20, priority_job_ids=[12, 8, 12]
    )

    assert result == {"batches": 1, "saved": 2, "stale": 0, "remaining": False}
    assert [name for name, _ in calls] == [
        "dashboard_summary_selected_batch", "dashboard_summary_store_batch",
        "dashboard_summary_selected_batch",
    ]


def test_selected_summary_rpc_is_bounded_and_service_role_only():
    from pathlib import Path

    sql = Path("supabase/migrations/20261101210829_dashboard_summary_selected_batch.sql").read_text()
    assert "security invoker" in sql.lower()
    assert "set search_path = ''" in sql
    assert "least(greatest(coalesce(p_limit, 50), 1), 50)" in sql
    assert "cardinality(p_job_ids)" in sql
    assert "from public, anon, authenticated" in sql
    assert "to service_role" in sql


def test_discovery_status_extracts_unique_positive_processed_job_ids(tmp_path):
    from scripts.build_dashboard_summaries import discovery_job_ids
    from scripts.run_dashboard_discovery import result_from_output

    status = tmp_path / "discovery-status.json"
    discovery_output = json.dumps({
        "mode": "broad", "processedJobIds": [12, "8", 0, "invalid"],
    })
    parsed_run = result_from_output(discovery_output, "broad")
    assert parsed_run is not None
    status.write_text(json.dumps({"result": {"runs": [parsed_run, {
        "processedJobIds": [8, 23],
    }]}}))

    assert discovery_job_ids(status) == [8, 12, 23]


def test_discovery_workflow_builds_run_summaries_before_completion():
    from pathlib import Path

    workflow = Path(".github/workflows/job-discovery.yml").read_text()
    discovery_step = workflow.index("- name: Run broad discovery")
    summary_step = workflow.index("- name: Build summaries for this discovery run")
    reporting_step = workflow.index("- name: Summarize run")
    assert discovery_step < summary_step < reporting_step
    assert "if: steps.discovery.outcome == 'success'" in workflow[summary_step:reporting_step]
    assert "continue-on-error: true" in workflow[summary_step:reporting_step]
    assert "--discovery-status-file" in workflow[summary_step:reporting_step]
    assert "--require-complete" in workflow[summary_step:reporting_step]


def test_summary_recovery_workflow_is_manual_and_independent():
    from pathlib import Path

    discovery = Path(".github/workflows/job-discovery.yml").read_text()
    recovery = Path(".github/workflows/dashboard-summary-builder.yml").read_text()
    assert "group: job-discovery" in discovery
    assert "group: dashboard-summary-builder" in recovery
    assert recovery.count("cancel-in-progress: false") == 1
    assert "  workflow_dispatch:" in recovery
    assert "  schedule:" not in recovery
    assert "  workflow_run:" not in recovery
    assert "--max-batches 20" in recovery


def test_needs_attention_sql_filter_is_server_side_and_keeps_rpc_security():
    from pathlib import Path

    migration = Path("supabase/migrations/20261031144518_dashboard_needs_attention_queue.sql").read_text()
    assert "when 'Needs attention' then (" in migration
    assert "m.decision_state = 'pending'" in migration
    assert "m.duplicate_review_status = 'pending'" in migration
    assert "'location_incompatible'" in migration
    assert "'work_model_incompatible'" in migration
    assert "returns jsonb language plpgsql volatile security invoker set search_path = ''" in migration


def test_migration_declares_security_revision_guards_live_joins_and_bounded_page():
    migration = (
        __import__("pathlib").Path(__file__).resolve().parents[1]
        / "supabase/migrations/20261031120000_bounded_dashboard_summaries.sql"
    ).read_text().lower()
    assert migration.count("$$") % 2 == 0
    assert migration.count("if tg_op = 'delete' then") >= 2
    assert "update public.dashboard_summary_user_state" in migration
    assert "update public.dashboard_summary_job_state" in migration
    assert "enable row level security" in migration
    assert "from public, anon, authenticated" in migration
    assert "from service_role;" in migration
    assert "grant select, insert, update on public.dashboard_summary_user_state" in migration
    assert "grant select, insert, update, delete" not in migration
    attention_migration = (
        __import__("pathlib").Path(__file__).resolve().parents[1]
        / "supabase/migrations/20261031144518_dashboard_needs_attention_queue.sql"
    ).read_text().lower()
    assert "create or replace function public.dashboard_job_attention_page" in attention_migration
    assert "security invoker set search_path = ''" in attention_migration
    assert "when 'needs attention' then (" in attention_migration
    assert "revoke all on function public.dashboard_job_attention_page" in attention_migration
    assert "from public, anon, authenticated" in attention_migration
    assert "to service_role" in attention_migration
    assert "limit least(greatest(coalesce(p_limit, 50), 1), 50)" in migration
    assert "limit least(greatest(coalesce(p_page_size,50),1),50)" in migration
    assert "for share" in migration
    assert "identity_company = s.identity_company" in migration
    assert "evaluation_fingerprint = s.summary->>'fit_fingerprint'" in migration
    assert "app.status as application_status" in migration
    assert "'description', case when p_include_description then j.description end" in migration
    assert "nullif(s.summary->>'active_profile_id', '') is not null" in migration
    assert "order by aa.updated_at desc, aa.id desc limit 1" in migration
    assert "position('on-site'" in migration and "position('on site'" in migration
    assert "cv_versions_dashboard_tailored_idx" in migration
    assert "cv.source_cv_version_id = (select uc.cv_id from user_context uc)" in migration
    assert "pending_duplicate_count" in migration
    assert "security invoker set search_path = ''" in migration
    assert "security definer" not in migration


def test_known_preference_mismatches_are_not_requeued_for_needs_attention():
    from pathlib import Path

    migration = Path(
        "supabase/migrations/20261102135010_needs_attention_exclude_known_mismatch.sql"
    ).read_text().lower()
    assert "create or replace function public.dashboard_job_attention_page" not in migration
    replacement = migration.split("new_clause text :=", 1)[1].split(";", 1)[0]
    assert "location_incompatible" not in replacement
    assert "employment_type_incompatible" not in replacement
    assert "seniority_incompatible" not in replacement
    assert "m.actionable or m.decision_state = 'pending'" in replacement
    assert "raise exception" in migration


def test_stale_handled_rows_only_block_apply_and_duplicate_decisions(monkeypatch):
    import ui.dashboard as dashboard
    from types import SimpleNamespace

    class Column:
        def __enter__(self): return self
        def __exit__(self, *_args): return False

    buttons = {}
    fake_st = SimpleNamespace(
        session_state={},
        button=lambda _label, **kwargs: buttons.update({kwargs["key"]: kwargs.get("disabled", False)}) or False,
        columns=lambda _spec: [Column(), Column()],
        container=lambda **_kwargs: Column(),
    )
    monkeypatch.setattr(dashboard, "st", fake_st)
    dashboard._render_lifecycle_actions(
        _job(42), object(), user_id="user-1", cv_version_id=3, active_profile_id=7,
        failed_fingerprints={}, disabled=False, application_action_blocked=True,
    )
    assert buttons["applied-42"] is True
    assert buttons["archive-42"] is False
    assert buttons["rate-42"] is False


def test_bounded_dashboard_activation_defaults_to_compact_pages():
    from ui.dashboard_summary import bounded_dashboard_enabled

    assert bounded_dashboard_enabled(None)
    assert bounded_dashboard_enabled("")
    assert not bounded_dashboard_enabled("false")
    assert bounded_dashboard_enabled("true")
    assert bounded_dashboard_enabled("1")
