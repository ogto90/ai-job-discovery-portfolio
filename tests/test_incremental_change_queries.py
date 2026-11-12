from types import SimpleNamespace
from concurrent.futures import Future

import pytest

import ui.dashboard as dashboard
from matching.candidate_profile_persistence import PersistenceError


def test_jobs_query_aliases_id_and_checks_other_tables(monkeypatch):
    queries = []
    def rows(client, table, params):
        queries.append((table, params))
        if table == "jobs":
            assert params["select"] == "job_id:id,updated_at"
            assert params["order"] == "updated_at.asc,id.asc"
            return [{"job_id": 8}]
        if table == "applications":
            assert params["user_id"] == "eq.user-1"
            return [{"job_id": 9}]
        return []
    monkeypatch.setattr(dashboard, "_get_rows", rows)
    ids, global_change = dashboard._changed_job_ids_since(object(), "user-1", "2026-10-08T00:00:00Z")
    assert ids == {8, 9} and not global_change
    assert any(table == "user_job_work_model_verifications" for table, _ in queries)


def test_change_notice_reports_failures_without_exposing_error_details(monkeypatch):
    warnings = []
    future = Future()
    future.set_exception(PersistenceError("private backend details"))
    state = {"dashboard_background_checks": {( "", "user-1"): {"future": future, "next_check": float("inf")}}}
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state, warning=warnings.append))
    dashboard._render_dashboard_change_notice.__wrapped__(object(), user_id="user-1")
    assert len(warnings) == 1
    assert "failed" in warnings[0] and "private" not in warnings[0]


def test_navigation_schedules_check_without_waiting_for_database(monkeypatch):
    submitted = []
    state = {"dashboard_change_cursor_by_user": {"user-1": "cursor"}}
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    monkeypatch.setattr(dashboard, "get_dashboard_context_snapshot", lambda _: ([], 7, "user-1", 2, "private"))
    def submit(*args):
        submitted.append(args)
        return Future()
    monkeypatch.setattr(dashboard, "_CHANGE_EXECUTOR", SimpleNamespace(submit=submit))
    dashboard._render_dashboard_change_notice.__wrapped__(object(), user_id="user-1")
    dashboard._render_dashboard_change_notice.__wrapped__(object(), user_id="user-1")
    assert len(submitted) == 1


def test_background_check_does_not_notify_for_identical_card(monkeypatch):
    job = SimpleNamespace(id=8, fit_score=78)
    future = Future()
    future.set_result(([job], False, {}))
    state = {"dashboard_background_checks": {("", "user-1"): {"future": future, "next_check": float("inf")}}}
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    monkeypatch.setattr(dashboard, "get_dashboard_jobs_snapshot", lambda _: [job])
    dashboard._render_dashboard_change_notice.__wrapped__(object(), user_id="user-1")
    assert not state.get("dashboard_pending_refresh_count")


def test_failed_change_read_does_not_advance_cursor(monkeypatch):
    state = {"dashboard_change_cursor_by_user": {"user-1": "old-cursor"}}
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    monkeypatch.setattr(dashboard, "get_dashboard_context_snapshot", lambda user: ([], 7, user, 2, "private"))
    def fail(*args):
        raise PersistenceError("request failed")
    monkeypatch.setattr(dashboard, "_changed_job_ids_since", fail)
    with pytest.raises(PersistenceError):
        dashboard.sync_dashboard_context(object(), "user-1")
    assert state["dashboard_change_cursor_by_user"]["user-1"] == "old-cursor"


def test_missing_jobs_timestamp_does_not_block_application_checks(monkeypatch):
    state = {}
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    def rows(client, table, params):
        if table == "jobs":
            raise PersistenceError('HTTP 400: {"code":"42703","message":"column jobs.updated_at does not exist"}')
        return [{"job_id": 9}] if table == "applications" else []
    monkeypatch.setattr(dashboard, "_get_rows", rows)
    ids, _ = dashboard._changed_job_ids_since(object(), "user-1", "2026-10-08T00:00:00Z")
    assert ids == {9}
    assert state["dashboard_jobs_timestamp_unavailable"] is True
