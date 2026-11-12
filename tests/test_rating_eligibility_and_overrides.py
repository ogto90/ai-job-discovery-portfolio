from dataclasses import replace
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest

import ui.dashboard as dashboard
from matching.candidate_profile_persistence import PersistenceError
from tests.test_dashboard_actions import _dashboard_job
from tests.test_manual_jd import FakeAI, FakeManualClient, VALID_JD
from ui.manual_jd import ManualJDOperationError, rate_job_with_manual_jd


@pytest.mark.parametrize("work_model", [("remote"), ("onsite"), (None)])
def test_rating_no_longer_requires_work_model_confirmation(work_model):
    client = FakeManualClient()
    client.job["remote_scope"] = None
    original = client.get_json
    legacy_reads = []

    def get_json(path):
        if path.startswith("/rest/v1/user_job_work_model_verifications?"):
            legacy_reads.append(path)
            return [{"user_id": "user-1", "job_id": 8, "work_model": work_model}] if work_model else []
        return original(path)

    client.get_json = get_json
    ai = FakeAI()
    args = dict(user_id="user-1", cv_version_id=2, candidate_profile_id=7, job_id=8, jd_text=VALID_JD, ai_client=ai)
    assert rate_job_with_manual_jd(client, **args)["fit_score"] == 67
    assert ai.calls == 1
    assert legacy_reads == []


@pytest.mark.parametrize("legacy_table", ["user_job_work_model_verifications", "user_job_language_verifications"])
def test_rating_does_not_read_legacy_language_or_work_model_tables(legacy_table):
    client = FakeManualClient()
    original = client.get_json

    def get_json(path):
        if path.startswith(f"/rest/v1/{legacy_table}?"):
            raise AssertionError("retired eligibility table must not be queried")
        return original(path)

    client.get_json = get_json
    ai = FakeAI()
    result = rate_job_with_manual_jd(client, user_id="user-1", cv_version_id=2, candidate_profile_id=7, job_id=8, jd_text=VALID_JD, ai_client=ai)
    assert result["fit_score"] == 67
    assert ai.calls == 1


@pytest.fixture
def state(monkeypatch):
    state = {}
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    return state


@pytest.mark.parametrize("fingerprint", ["changed-profile", "changed-jd", None])
def test_stale_fit_never_overlays_new_context(state, monkeypatch, fingerprint):
    fresh = replace(_dashboard_job(8, "Engineer"), fit_fingerprint=fingerprint)
    state["dashboard_lifecycle_overrides"] = {"user-1": {8: {
        "fit_score": 78, "fit_fingerprint": "old", "fit_strengths": ("old",),
        "fit_gaps": ("old",), "review_status": "rated", "description": "old JD",
    }}}
    monkeypatch.setattr(dashboard, "_load_dashboard_context_cached", lambda *args: ([fresh], 9, "user-1", 3, "private"))
    result = dashboard.load_dashboard_context(SimpleNamespace(base_url="offline"), "user-1")[0][0]
    assert result == fresh


def test_same_fingerprint_temporary_fit_is_shown(state):
    job = replace(_dashboard_job(8, "Engineer"), fit_fingerprint="current")
    state["dashboard_jobs_snapshot_by_user"] = {"user-1": [job]}
    dashboard._record_dashboard_lifecycle_override("user-1", 8, fit_score=78, fit_fingerprint="current")
    assert dashboard._dashboard_job_overrides("user-1", 8, job=job)["fit_score"] == 78


def test_late_batch_cannot_replace_new_profile_score(state):
    current = replace(_dashboard_job(8, "Engineer"), fit_fingerprint="new", fit_score=55)
    state["dashboard_jobs_snapshot_by_user"] = {"user-1": [current]}
    dashboard._record_dashboard_lifecycle_override("user-1", 8, fit_score=78, fit_fingerprint="old", _expected_fit_fingerprint="old")
    assert state["dashboard_jobs_snapshot_by_user"]["user-1"][0] == current


def test_late_manual_jd_result_cannot_cross_profile_change(state):
    current = _dashboard_job(8, "Engineer")
    state["dashboard_jobs_snapshot_by_user"] = {"user-1": [current]}
    state["dashboard_context_snapshot_by_user"] = {"user-1": ([current], 9, "user-1", 3, "private")}
    dashboard._record_dashboard_lifecycle_override("user-1", 8, fit_score=78, fit_fingerprint="old", _expected_fit_fingerprint=None, _expected_profile_id=7)
    assert state["dashboard_jobs_snapshot_by_user"]["user-1"][0] == current


def test_manual_jd_result_can_update_its_original_snapshot(state):
    current = replace(_dashboard_job(8, "Engineer"), fit_fingerprint="old-jd")
    state["dashboard_jobs_snapshot_by_user"] = {"user-1": [current]}
    dashboard._record_dashboard_lifecycle_override(
        "user-1", 8, fit_score=78, fit_fingerprint="new-jd",
        description="New full JD", description_kind="full", _expected_fit_fingerprint="old-jd",
    )
    updated = state["dashboard_jobs_snapshot_by_user"]["user-1"][0]
    assert updated.fit_score == 78 and updated.fit_fingerprint == "new-jd"
    assert updated.description == "New full JD"


def test_stale_failure_does_not_replace_current_score(state):
    current = replace(_dashboard_job(8, "Engineer"), fit_fingerprint="new", fit_score=55)
    state["dashboard_jobs_snapshot_by_user"] = {"user-1": [current]}
    dashboard._record_dashboard_lifecycle_override("user-1", 8, fit_attempt_failed=True, fit_fingerprint="old")
    assert state["dashboard_jobs_snapshot_by_user"]["user-1"][0] == current


def test_authoritative_reconciliation_discards_overrides_only_for_read_cards(state):
    state["dashboard_lifecycle_overrides"] = {"user-1": {
        8: {"fit_score": 78, "fit_fingerprint": "current", "review_status": "rated"},
        9: {"review_status": "seen"},
        10: {"review_status": "archived", "fit_score": 60},
    }}
    state["bulk_archive_task"] = {"job_ids": [10]}
    dashboard._reconcile_dashboard_overrides("user-1", {8, 10})
    assert state["dashboard_lifecycle_overrides"]["user-1"] == {
        9: {"review_status": "seen"}, 10: {"review_status": "archived"},
    }
