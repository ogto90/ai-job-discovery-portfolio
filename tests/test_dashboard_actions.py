import pytest
from contextlib import nullcontext
from dataclasses import replace
from types import SimpleNamespace

import ui.dashboard as dashboard
from ui.dashboard import _dashboard_job_overrides, _get_all_job_rows, _initialize_dashboard_status, _mark_applied_and_open_applications, _poll_bulk_archive_task, _render_bulk_rating_status, _retry_rating, archive_job, archive_jobs, mark_applied, pending_retry_cohorts, rate_jobs, run_pending_evidence_retry, save_listing_url, save_manual_language_status, save_manual_location_status, save_manual_verification, save_manual_work_model, start_bulk_archive, start_bulk_rating, sync_dashboard_context, validate_listing_url
from ui.dashboard_data import DashboardJob, can_retry_pending_evidence
from matching.candidate_profile_persistence import PersistenceError


class FakeClient:
    def __init__(self):
        self.applications = []
        self.reviews = []
        self.writes = []

    def get_json(self, path):
        if path.startswith("/rest/v1/applications?"):
            return self.applications
        if path.startswith("/rest/v1/job_reviews?"):
            return [
                row for row in self.reviews
                if f"user_id=eq.{row['user_id']}" in path and f"job_id=eq.{row['job_id']}" in path
            ]
        raise AssertionError(path)

    def json_request(self, method, path, payload, *, prefer=None):
        self.writes.append((method, path, payload))
        if path == "/rest/v1/applications":
            row = {"id": 1, **payload}
            self.applications.append(row)
            return [row]
        if path == "/rest/v1/job_reviews":
            row = {"id": len(self.reviews) + 1, **payload}
            self.reviews.append(row)
            return [row]
        if path.startswith("/rest/v1/user_job_verifications?"):
            return None
        if path.startswith("/rest/v1/user_job_work_model_verifications?"):
            return None
        if path.startswith("/rest/v1/user_job_language_verifications?"):
            return None
        if path.startswith("/rest/v1/user_job_location_verifications?"):
            return None
        raise AssertionError(path)


def _dashboard_job(job_id: int, title: str) -> DashboardJob:
    return DashboardJob(
        id=job_id, source="test", company="Example", title=title, location=None,
        remote_scope=None, source_url=None, application_url=None, availability_status="active",
        verification_status=None, review_status="new", posted_at=None, first_seen_at=None,
        last_seen_at=None, fit_score=None, fit_assessment_id=None,
    )


def test_incremental_dashboard_sync_replaces_only_changed_cards(monkeypatch):
    original = _dashboard_job(1, "Unchanged")
    changed_before = _dashboard_job(2, "Old title")
    changed_after = _dashboard_job(2, "Updated title")
    context = ([original, changed_before], 10, "user-1", 20, "cv-artifacts")
    state = {
        "dashboard_context_snapshot_by_user": {"user-1": context},
        "dashboard_jobs_snapshot_by_user": {"user-1": context[0]},
        "dashboard_change_cursor_by_user": {"user-1": "2026-10-01T00:00:00+00:00"},
    }
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))

    def changed_rows(_client, table, _params):
        if table == "jobs":
            return [{"job_id": 2}]
        return []

    monkeypatch.setattr(dashboard, "_get_rows", changed_rows)
    monkeypatch.setattr(dashboard, "_load_dashboard_context_rows", lambda *_args, **_kwargs: ([changed_after], 10, "user-1", 20, "cv-artifacts"))
    client = SimpleNamespace(
        resolve_active_base_cv=lambda _user_id: SimpleNamespace(id=20),
        list_profiles=lambda _user_id, _cv_id: [{"id": 10, "is_active": True}],
    )

    assert sync_dashboard_context(client, "user-1") == 1
    refreshed = state["dashboard_context_snapshot_by_user"]["user-1"][0]
    by_id = {job.id: job for job in refreshed}
    assert by_id[1] is original
    assert by_id[2].title == "Updated title"


def test_incremental_dashboard_sync_keeps_snapshot_when_nothing_changed(monkeypatch):
    original = _dashboard_job(1, "Unchanged")
    context = ([original], 10, "user-1", 20, "cv-artifacts")
    state = {
        "dashboard_context_snapshot_by_user": {"user-1": context},
        "dashboard_jobs_snapshot_by_user": {"user-1": context[0]},
        "dashboard_change_cursor_by_user": {"user-1": "2026-10-01T00:00:00+00:00"},
    }
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    monkeypatch.setattr(dashboard, "_get_rows", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(dashboard, "_load_dashboard_context_rows", lambda *_args, **_kwargs: pytest.fail("No delta expected"))
    client = SimpleNamespace(
        resolve_active_base_cv=lambda _user_id: SimpleNamespace(id=20),
        list_profiles=lambda _user_id, _cv_id: [{"id": 10, "is_active": True}],
    )

    assert sync_dashboard_context(client, "user-1") == 0
    assert state["dashboard_context_snapshot_by_user"]["user-1"][0] == [original]

def test_dashboard_context_cache_reuses_same_user_and_separates_users(monkeypatch):
    calls = []

    def load(_client, user_id):
        calls.append(user_id)
        return ([user_id], None, user_id, 1, "bucket")

    monkeypatch.setattr(dashboard, "_load_dashboard_context_uncached", load)
    dashboard._load_dashboard_context_cached.clear()
    client = SimpleNamespace(base_url="https://project.supabase.co")

    first = dashboard._load_dashboard_context_cached(client, "user-a", client.base_url, 100)
    cached = dashboard._load_dashboard_context_cached(client, "user-a", client.base_url, 100)
    other_user = dashboard._load_dashboard_context_cached(client, "user-b", client.base_url, 100)
    refreshed = dashboard._load_dashboard_context_cached(client, "user-a", client.base_url, 101)

    assert first == cached
    assert other_user[2] == "user-b"
    assert refreshed[2] == "user-a"
    assert calls == ["user-a", "user-b", "user-a"]
    dashboard._load_dashboard_context_cached.clear()


def test_dashboard_context_cache_round_trips_jobs_as_plain_data(monkeypatch):
    job = _dashboard_job(42, "Security Engineer")
    monkeypatch.setattr(dashboard, "_load_dashboard_context_uncached", lambda *_args: ([job], 8, "user-1", 9, "bucket"))
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state={}))
    monkeypatch.setattr(dashboard, "supabase_data_revision", lambda: 0)
    monkeypatch.setattr(dashboard, "supabase_card_revision", lambda: 0)
    dashboard._load_dashboard_context_cached.clear()
    client = SimpleNamespace(base_url="https://project.supabase.co")

    cached = dashboard._load_dashboard_context_cached(client, "user-1", client.base_url, (0, 0))
    assert isinstance(cached[0][0], dict)
    assert cached[0][0]["id"] == 42

    restored = dashboard.load_dashboard_context(client, "user-1")
    assert restored[0] == [job]
    dashboard._load_dashboard_context_cached.clear()


def test_archive_updates_local_card_overlay_without_invalidating_listing_cache(monkeypatch):
    state = {}
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    client = FakeClient()
    dashboard.archive_job(client, user_id="user-1", job_id=42)
    assert state["dashboard_lifecycle_overrides"]["user-1"][42] == {"review_status": "archived"}
    assert len(client.writes) == 1


def test_dashboard_context_applies_lifecycle_overlay_to_cached_rows(monkeypatch):
    state = {"dashboard_lifecycle_overrides": {"user-1": {42: {"review_status": "archived"}}}}
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    cached_job = DashboardJob(
        id=42, source="test", company="Example", title="Security Engineer", location=None,
        remote_scope=None, source_url=None, application_url=None, availability_status="active",
        verification_status=None, review_status="new", posted_at=None, first_seen_at=None,
        last_seen_at=None, fit_score=None, fit_assessment_id=None,
    )
    monkeypatch.setattr(
        dashboard, "_load_dashboard_context_cached",
        lambda *_args: ([cached_job], 8, "user-1", 9, "cv-artifacts"),
    )
    rows, *_ = dashboard.load_dashboard_context(SimpleNamespace(base_url="https://example.test"), "user-1")
    assert rows[0].review_status == "archived"


@pytest.mark.parametrize(
    ("initial", "expected"),
    [
        ({}, "Needs attention"),
        ({"dashboard_status": "Unaddressed"}, "Needs attention"),
        ({"dashboard_status": "Applied"}, "Needs attention"),
        ({"dashboard_status": "Unaddressed", "dashboard_status_initialized": True}, "Needs attention"),
        ({"dashboard_status_initialized": True}, "Needs attention"),
    ],
)
def test_dashboard_initial_filter_resets_former_filter_to_needs_attention(monkeypatch, initial, expected):
    state = dict(initial)
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(session_state=state))

    _initialize_dashboard_status()

    assert state["dashboard_status"] == expected
    assert state["dashboard_status_initialized"] is True


def test_mark_applied_twice_is_rejected_without_duplicate_application():
    client = FakeClient()
    mark_applied(client, user_id="user-1", job_id=8, cv_version_id=2)
    with pytest.raises(PersistenceError, match="already applied"):
        mark_applied(client, user_id="user-1", job_id=8, cv_version_id=2)
    assert len([write for write in client.writes if write[0] == "POST"]) == 1
    assert client.applications[0]["status"] == "applied"


def test_mark_applied_navigates_to_active_applications(monkeypatch):
    client = FakeClient()
    state = {}
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(session_state=state))
    _mark_applied_and_open_applications(client, user_id="user-1", job_id=8, cv_version_id=2)
    assert state["app_page"] == "Applications"
    assert state["application_stage_filter"] == "Active"
    assert client.applications[0]["status"] == "applied"


def test_mark_applied_updates_card_snapshot_to_retained_without_expiry(monkeypatch):
    job = replace(
        _dashboard_job(8, "Security Engineer"),
        tailored_tex_path="user-1/tailored/8/cv.tex",
        tailored_pdf_path="user-1/tailored/8/cv.pdf",
        tailored_expires_at="2026-11-01T00:00:00+00:00",
    )
    state = {
        "dashboard_jobs_snapshot_by_user": {"user-1": [job]},
        "dashboard_context_snapshot_by_user": {
            "user-1": ([job], 10, "user-1", 20, "cv-artifacts"),
        },
    }
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(session_state=state))

    mark_applied(FakeClient(), user_id="user-1", job_id=8, cv_version_id=2)

    updated = state["dashboard_jobs_snapshot_by_user"]["user-1"][0]
    assert updated.review_status == "applied"
    assert updated.application_status == "applied"
    assert updated.tailored_expires_at is None
    assert updated.tailored_artifact_available is True


def test_failed_mark_applied_does_not_change_dashboard_section(monkeypatch):
    client = FakeClient()
    client.applications.append({"id": 1, "job_id": 8, "user_id": "user-1", "status": "applied"})
    state = {"dashboard_section": "Jobs"}
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(session_state=state))
    _mark_applied_and_open_applications(client, user_id="user-1", job_id=8, cv_version_id=2)
    assert state["dashboard_section"] == "Jobs"
    assert "application_action_error" in state


def test_archive_is_user_scoped_and_idempotent():
    client = FakeClient()
    archive_job(client, user_id="user-1", job_id=8)
    archive_job(client, user_id="user-1", job_id=8)
    assert len(client.writes) == 1
    assert client.writes[0][2] == {"user_id": "user-1", "job_id": 8, "status": "archived"}
    assert all("jobs" not in path for _, path, _ in client.writes)


def test_bulk_archive_deduplicates_ids_and_uses_the_existing_user_scoped_action():
    client = FakeClient()
    archived, failed = archive_jobs(client, user_id="user-1", job_ids=[8, 9, 8])
    assert archived == [8, 9]
    assert failed == []
    assert [write[2]["job_id"] for write in client.writes] == [8, 9]
    assert all(write[2]["user_id"] == "user-1" and write[2]["status"] == "archived" for write in client.writes)


def test_bulk_archive_hides_cards_optimistically_and_starts_background_work(monkeypatch):
    state = {"archive-select-8": True, "archive-select-9": True}
    queued = []
    future = object()

    def submit(function, *args, **kwargs):
        queued.append((function, args, kwargs))
        return future

    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(session_state=state))
    monkeypatch.setattr("ui.dashboard._ARCHIVE_EXECUTOR", SimpleNamespace(submit=submit))
    jobs = [_job_for_retry(8, "target_match"), _job_for_retry(9, "target_match")]

    assert start_bulk_archive(object(), user_id="user-1", jobs=jobs) == 2
    assert state["bulk_archive_task"] == {
        "future": future, "job_ids": [8, 9], "previous_statuses": {8: "new", 9: "new"},
    }
    assert _dashboard_job_overrides("user-1", 8) == {"review_status": "archived"}
    assert _dashboard_job_overrides("user-1", 9) == {"review_status": "archived"}
    assert "archive-select-8" not in state and "archive-select-9" not in state
    assert queued[0][0] is archive_jobs
    assert queued[0][2] == {"user_id": "user-1", "job_ids": [8, 9], "update_session_state": False}


def test_archive_poll_reconciles_result_without_full_app_rerun(monkeypatch):
    from concurrent.futures import Future

    future = Future()
    future.set_result(([8], [(9, "write failed")]))
    state = {"bulk_archive_task": {
        "future": future, "job_ids": [8, 9], "previous_statuses": {8: "new", 9: "rated"},
    }}
    reruns = []
    refreshed = []
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(
        session_state=state,
        info=lambda *_: None,
        caption=lambda *_: None,
        expander=lambda *_: nullcontext(),
        button=lambda *_args, **_kwargs: False,
        rerun=lambda **kwargs: reruns.append(kwargs),
        toast=lambda *_args: None,
    ))
    monkeypatch.setattr("ui.dashboard.refresh_dashboard_data", lambda user_id: refreshed.append(user_id))

    getattr(_poll_bulk_archive_task, "__wrapped__", _poll_bulk_archive_task)("user-1")

    assert "bulk_archive_task" not in state
    assert state["bulk_archive_result"] == {
        "archived": 1, "failed": [(9, "write failed")], "job_ids": [8, 9],
    }
    assert _dashboard_job_overrides("user-1", 9) == {"review_status": "rated"}
    assert refreshed == []
    assert reruns == []


def test_bulk_rating_starts_in_background_and_deselects_jobs(monkeypatch):
    state = {"archive-select-18": True}
    queued = []
    future = object()

    def submit(function, *args, **kwargs):
        queued.append((function, args, kwargs))
        return future

    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(session_state=state))
    monkeypatch.setattr("ui.dashboard._ARCHIVE_EXECUTOR", SimpleNamespace(submit=submit))
    job = DashboardJob(
        id=18, source="manual", company="Example", title="Security Engineer",
        location=None, remote_scope=None, source_url=None, application_url=None,
        availability_status="active", verification_status="verified", review_status="new",
        posted_at=None, first_seen_at=None, last_seen_at=None, fit_score=None,
        fit_assessment_id=None, description="Full job description", description_kind="full",
        is_manual=True,
    )

    assert start_bulk_rating(
        [job], object(), user_id="user-1", cv_version_id=2,
        candidate_profile_id=7, failed_fingerprints={},
    ) == 1
    assert state["bulk_rating_task"] == {"future": future, "job_ids": [18]}
    assert "archive-select-18" not in state
    assert queued[0][0].__name__ == "_run_bulk_rating_task"


def test_only_jobs_in_active_bulk_operation_are_locked(monkeypatch):
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(session_state={
        "bulk_rating_task": {"job_ids": [18, 19]},
        "bulk_archive_result": {"job_ids": [20]},
    }))

    assert dashboard._job_operation_busy(18)
    assert dashboard._job_operation_busy(19)
    assert dashboard._job_operation_busy(20)
    assert not dashboard._job_operation_busy(21)


def test_bulk_rating_result_is_applied_by_the_shared_update_action(monkeypatch):
    result = {
        "completed_ids": [18],
        "fit_results": {18: {"fit_score": 82, "fit_fingerprint": "a" * 64, "fit_strengths": ("Supported",), "fit_gaps": ()}},
        "failed": [], "cache_hits": 0,
        "failed_fingerprints": {19: "f" * 64},
        "job_ids": [18, 19],
    }
    state = {
        "bulk_rating_result": result,
        "archive-select-18": True,
    }
    refreshed = []
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(
        session_state=state,
    ))
    monkeypatch.setattr("ui.dashboard.refresh_dashboard_data", lambda user_id: refreshed.append(user_id))

    assert dashboard._apply_bulk_rating_result("user-1")

    assert state["fit_failed_fingerprints"] == {"19": "f" * 64}
    assert state["bulk_rate_flash"] == {"rated": 1, "cache_hits": 0, "failed": []}
    assert "bulk_rating_result" not in state
    assert "archive-select-18" not in state
    assert refreshed == []
    assert _dashboard_job_overrides("user-1", 18) == {
        "fit_score": 82, "fit_strengths": ("Supported",), "fit_gaps": (), "fit_attempt_failed": False,
        "fit_fingerprint": "a" * 64,
    }


def test_bulk_rating_poller_publishes_completed_result_without_refreshing_data(monkeypatch):
    from concurrent.futures import Future
    from ui.dashboard import _poll_bulk_rating_task

    result = {
        "completed_ids": [18], "fit_results": {}, "failed": [], "cache_hits": 0,
        "failed_fingerprints": {},
    }
    future = Future()
    future.set_result(result)
    state = {"bulk_rating_task": {"future": future, "job_ids": [18]}}
    reruns = []
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(
        session_state=state, rerun=lambda **kwargs: reruns.append(kwargs), toast=lambda *_args: None,
    ))

    getattr(_poll_bulk_rating_task, "__wrapped__", _poll_bulk_rating_task)()

    assert state["bulk_rating_result"] == {**result, "job_ids": [18]}
    assert "bulk_rating_task" not in state
    assert reruns == []


def test_manual_verification_upserts_user_scoped_outcome_and_reason():
    client = FakeClient()
    save_manual_verification(
        client,
        user_id="user-1",
        job_id=16,
        verification_status="unable_to_verify",
        reason="The page is blocked or inaccessible",
    )
    method, path, payload = client.writes[-1]
    assert method == "POST"
    assert path == "/rest/v1/user_job_verifications?on_conflict=user_id,job_id"
    assert payload == {
        "user_id": "user-1",
        "job_id": 16,
        "verification_status": "unable_to_verify",
        "verification_reason": "The page is blocked or inaccessible",
        "checked_at": payload["checked_at"],
    }


def test_unsuccessful_manual_verification_requires_reason():
    client = FakeClient()
    with pytest.raises(ValueError, match="reason"):
        save_manual_verification(
            client,
            user_id="user-1",
            job_id=16,
            verification_status="confirmed_closed",
        )
    assert client.writes == []


def test_manual_work_model_confirmation_upserts_user_scoped_fact():
    client = FakeClient()
    save_manual_work_model(client, user_id="user-1", job_id=92, work_model="remote")
    method, path, payload = client.writes[-1]
    assert method == "POST"
    assert path == "/rest/v1/user_job_work_model_verifications?on_conflict=user_id,job_id"
    assert payload["user_id"] == "user-1"
    assert payload["job_id"] == 92
    assert payload["work_model"] == "remote"
    assert payload["verified_at"]


def test_manual_work_model_confirmation_rejects_unknown_values_without_writing():
    client = FakeClient()
    with pytest.raises(ValueError, match="work arrangement"):
        save_manual_work_model(client, user_id="user-1", job_id=92, work_model="maybe_remote")
    assert client.writes == []


def test_manual_language_decision_upserts_user_scoped_status():
    client = FakeClient()
    save_manual_language_status(client, user_id="user-1", job_id=92, language_status="accepted")
    method, path, payload = client.writes[-1]
    assert method == "POST"
    assert path == "/rest/v1/user_job_language_verifications?on_conflict=user_id,job_id"
    assert payload["user_id"] == "user-1"
    assert payload["job_id"] == 92
    assert payload["language_status"] == "accepted"
    assert payload["verified_at"]


def test_manual_language_decision_rejects_invalid_status_without_writing():
    client = FakeClient()
    with pytest.raises(ValueError, match="language"):
        save_manual_language_status(client, user_id="user-1", job_id=92, language_status="maybe")
    assert client.writes == []


def test_manual_language_action_rebuilds_only_its_dashboard_summary(monkeypatch):
    class StopFragmentRerun(Exception):
        pass

    from contextlib import nullcontext

    calls = []
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(
        session_state={}, form=lambda *_args, **_kwargs: nullcontext(),
        radio=lambda *_args, **_kwargs: "Yes, approve this language",
        form_submit_button=lambda *_args, **_kwargs: True,
        rerun=lambda **_kwargs: (_ for _ in ()).throw(StopFragmentRerun()),
        error=lambda *_args, **_kwargs: None, warning=lambda *_args, **_kwargs: None,
    ))
    monkeypatch.setattr(
        dashboard, "_rebuild_listing_dashboard_summary",
        lambda _client, *, user_id, job_id: calls.append((user_id, job_id)),
    )
    job = replace(_dashboard_job(92, "Security Engineer"), language_eligibility="unclear")

    with pytest.raises(StopFragmentRerun):
        dashboard._render_manual_language_control(job, FakeClient(), user_id="user-1", disabled=False)

    assert calls == [("user-1", 92)]


def test_targeted_summary_rebuild_passes_one_job_and_rejects_stale_publish(monkeypatch):
    from ui import dashboard_summary

    calls = []
    monkeypatch.setattr(
        dashboard_summary, "build_dashboard_summaries",
        lambda client, **kwargs: calls.append((client, kwargs)) or {"stale": 0},
    )
    client = FakeClient()
    dashboard._rebuild_listing_dashboard_summary(client, user_id="user-1", job_id=92)
    assert calls == [(client, {"user_id": "user-1", "max_batches": 1, "target_job_id": 92})]

    monkeypatch.setattr(
        dashboard_summary, "build_dashboard_summaries",
        lambda *_args, **_kwargs: {"stale": 1},
    )
    with pytest.raises(PersistenceError, match="changed while its summary was rebuilding"):
        dashboard._rebuild_listing_dashboard_summary(client, user_id="user-1", job_id=92)


def test_manual_location_decision_upserts_user_scoped_fact():
    client = FakeClient()
    save_manual_location_status(client, user_id="user-1", job_id=92, location_status="accepted")
    method, path, payload = client.writes[-1]
    assert method == "POST"
    assert path == "/rest/v1/user_job_location_verifications?on_conflict=user_id,job_id"
    assert payload["user_id"] == "user-1"
    assert payload["job_id"] == 92
    assert payload["location_status"] == "accepted"
    assert payload["verified_at"]


def test_manual_location_decision_rejects_invalid_status_without_writing():
    client = FakeClient()
    with pytest.raises(ValueError, match="location"):
        save_manual_location_status(client, user_id="user-1", job_id=92, location_status="maybe")
    assert client.writes == []


@pytest.mark.parametrize(("status", "expected"), [("accepted", "eligible"), ("rejected", "ineligible")])
def test_manual_location_save_updates_the_card_overlay_immediately(monkeypatch, status, expected):
    from types import SimpleNamespace
    from dataclasses import replace

    from ui.dashboard import save_location_and_update_card

    job = replace(
        _dashboard_job(92, "Senior Software Security Engineer"),
        location="Austria", location_eligibility="unclear", location_reason="Could not determine location fit.",
    )
    state = {
        "dashboard_jobs_snapshot_by_user": {"user-1": [job]},
        "dashboard_context_snapshot_by_user": {"user-1": ([job], 7, "user-1", 3, "cv-artifacts")},
    }
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    monkeypatch.setattr(dashboard, "_get_rows", lambda *_args, **_kwargs: [{"id": 4, "definition": {}}])
    monkeypatch.setattr(
        dashboard,
        "assess_discovered_job",
        lambda **kwargs: SimpleNamespace(
            reason="Location compatibility manually confirmed.",
            role="target_match", role_reason="Role matches.",
            location="eligible" if kwargs["verified_location_status"] == "accepted" else "ineligible",
            location_reason="Location compatibility manually confirmed.",
            work_model="eligible", work_model_reason="",
            language="eligible", language_reason="",
            employment_type="eligible", employment_type_reason="",
            seniority="eligible", seniority_reason="",
        ),
    )
    client = FakeClient()

    updated = save_location_and_update_card(client, user_id="user-1", job=job, location_status=status)

    assert updated.location_eligibility == expected
    assert state["dashboard_lifecycle_overrides"]["user-1"][92]["verified_location_status"] == status
    assert state["dashboard_jobs_snapshot_by_user"]["user-1"][0].location_eligibility == expected
    assert any("user_job_location_verifications" in path for _method, path, _payload in client.writes)
    if status == "rejected":
        from ui.dashboard_data import group_archive_jobs
        assert group_archive_jobs([updated])[0][0] == "Preference mismatches"


def test_manual_location_rejection_reports_where_the_listing_went(monkeypatch):
    from contextlib import nullcontext

    class StopFragmentRerun(Exception):
        pass

    messages = []
    state = {}
    ui = SimpleNamespace(
        session_state=state,
        form=lambda *_args, **_kwargs: nullcontext(),
        caption=lambda message: messages.append(("caption", message)),
        radio=lambda *_args, **_kwargs: "No, this location does not fit",
        form_submit_button=lambda *_args, **_kwargs: True,
        spinner=lambda *_args, **_kwargs: nullcontext(),
        warning=lambda message: messages.append(("warning", message)),
        success=lambda message: messages.append(("success", message)),
        error=lambda message: messages.append(("error", message)),
        rerun=lambda **_kwargs: (_ for _ in ()).throw(StopFragmentRerun()),
    )
    monkeypatch.setattr(dashboard, "st", ui)
    monkeypatch.setattr(dashboard, "save_location_and_update_card", lambda *_args, **_kwargs: None)
    rebuilt = []
    monkeypatch.setattr(
        dashboard, "_rebuild_listing_dashboard_summary",
        lambda _client, *, user_id, job_id: rebuilt.append((user_id, job_id)),
    )

    with pytest.raises(StopFragmentRerun):
        dashboard._render_manual_location_control(
            _dashboard_job(92, "Senior Software Security Engineer"),
            FakeClient(), user_id="user-1", disabled=False,
        )

    status, message = state["manual_location_flash"]
    assert status == "rejected"
    assert "Archive → Preference mismatches" in message
    assert rebuilt == [("user-1", 92)]


@pytest.mark.parametrize("archive_view,expected_controls", [(True, []), (False, [])])
def test_archive_cards_hide_manual_preference_verification_controls(monkeypatch, archive_view, expected_controls):
    from dataclasses import replace

    calls = []
    context = nullcontext()
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(
        columns=lambda count: [context for _ in range(count if isinstance(count, int) else len(count))],
        container=lambda **_kwargs: context,
        button=lambda *_args, **_kwargs: False,
    ))
    monkeypatch.setattr(dashboard, "_render_manual_language_control", lambda *_args, **_kwargs: calls.append("language"))
    monkeypatch.setattr(dashboard, "_render_manual_location_control", lambda *_args, **_kwargs: calls.append("location"))
    job = replace(
        _dashboard_job(94, "Security Engineer"),
        language_eligibility="unclear", language_reason="Language not established.",
        location_eligibility="ineligible", location_reason="Location mismatch.",
    )

    dashboard._render_lifecycle_actions(
        job, FakeClient(), user_id="user-1", cv_version_id=3,
        active_profile_id=7, failed_fingerprints={}, disabled=False,
        archive_view=archive_view,
    )

    assert calls == expected_controls


@pytest.mark.parametrize("model,expected", [("remote", "eligible"), ("onsite", "eligible")])
def test_work_model_save_updates_only_affected_snapshot_without_dashboard_reads(monkeypatch, model, expected):
    from dataclasses import replace

    target = replace(_dashboard_job(92, "Security Engineer"),
                     location="Europe", work_model_eligibility="unclear",
                     description="Full description", description_kind="full")
    untouched = _dashboard_job(93, "Another job")
    state = {
        "dashboard_jobs_snapshot_by_user": {"user-1": [target, untouched]},
        "dashboard_context_snapshot_by_user": {"user-1": ([target, untouched], 7, "user-1", 3, "cv-artifacts")},
        "dashboard_change_cursor_by_user": {"user-1": "old-cursor"},
    }
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    client = FakeClient()
    reads = []

    def get_json(path):
        assert path.startswith("/rest/v1/search_profiles?")
        assert "user_id=eq.user-1" in path
        reads.append(path)
        return [{"definition": {"target_titles": ["Security Engineer"], "work_models": ["remote"]}}]

    client.get_json = get_json
    updated = dashboard.save_work_model_and_update_card(client, user_id="user-1", job=target, work_model=model)
    assert len(reads) == 1
    assert len(client.writes) == 1
    assert updated.work_model_eligibility == expected
    assert updated.ready_to_rate
    assert state["dashboard_jobs_snapshot_by_user"]["user-1"] == [updated, untouched]
    assert state["dashboard_jobs_snapshot_by_user"]["user-1"][1] is untouched
    assert state["dashboard_context_snapshot_by_user"]["user-1"][0][0] is updated
    assert state["dashboard_change_cursor_by_user"]["user-1"] == "old-cursor"


def test_failed_work_model_save_keeps_cached_card_unchanged(monkeypatch):
    target = _dashboard_job(92, "Security Engineer")
    state = {"dashboard_jobs_snapshot_by_user": {"user-1": [target]}}
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state))
    client = FakeClient()
    client.get_json = lambda _path: []

    def fail(*_args, **_kwargs):
        raise PersistenceError("Save failed")

    monkeypatch.setattr(dashboard, "save_manual_work_model", fail)
    with pytest.raises(PersistenceError, match="Save failed"):
        dashboard.save_work_model_and_update_card(client, user_id="user-1", job=target, work_model="remote")
    assert state["dashboard_jobs_snapshot_by_user"]["user-1"][0] is target


def test_pending_retry_runner_passes_only_explicit_ids_and_current_user(monkeypatch):
    import json
    from types import SimpleNamespace

    captured = []
    monkeypatch.setattr(
        "ui.dashboard.subprocess.run",
        lambda command, **kwargs: captured.append((command, kwargs)) or SimpleNamespace(returncode=0, stdout=json.dumps({"jobs": []}), stderr=""),
    )
    result = run_pending_evidence_retry([4, 8], user_id="user-1")
    assert result == {"jobs": []}
    command, kwargs = captured[0]
    assert command[-4:] == ["--ids", "4,8", "--user-id", "user-1"]
    assert kwargs["env"]["AI_JOB_SEARCH_USER_ID"] == "user-1"
    assert kwargs["timeout"] == 600


def test_pending_retry_runner_rejects_unbounded_batches():
    with pytest.raises(ValueError):
        run_pending_evidence_retry(list(range(1, 27)), user_id="user-1")


def test_dashboard_job_loader_pages_past_the_rest_api_default_limit():
    from urllib.parse import parse_qs, urlparse

    class PagedClient:
        def __init__(self):
            self.cursors = []

        def get_json(self, path):
            params = parse_qs(urlparse(path).query)
            cursor = int(params["id"][0].removeprefix("gt."))
            self.cursors.append(cursor)
            return [{"id": value} for value in range(cursor + 1, min(cursor + 500, 1002) + 1)]

    client = PagedClient()
    rows = _get_all_job_rows(client, {"select": "id"})
    assert len(rows) == 1002
    assert rows[-1]["id"] == 1002
    assert client.cursors == [0, 500, 1000]


def test_pending_retry_runner_reports_missing_ids_without_exposing_stderr(monkeypatch):
    monkeypatch.setattr(
        "ui.dashboard.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=1,
            stdout="",
            stderr="Error: Selected job IDs were not found: 1246, 1079\nprivate secret here",
        ),
    )
    with pytest.raises(RuntimeError, match="Selected jobs were not found: 1246, 1079") as exc:
        run_pending_evidence_retry([1246, 1079], user_id="user-1")
    assert "private secret" not in str(exc.value)


def test_failed_bulk_retry_does_not_mark_jobs_attempted(monkeypatch):
    import ui.dashboard as dashboard

    job = _job_for_retry(1246, "target_match")
    state = {}
    errors = []
    monkeypatch.setattr(dashboard.st, "session_state", state)
    monkeypatch.setattr(dashboard.st, "spinner", lambda *_: nullcontext())
    monkeypatch.setattr(dashboard.st, "error", errors.append)
    monkeypatch.setattr(dashboard, "run_pending_evidence_retry", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("Selected jobs were not found: 1246.")))
    dashboard._retry_pending_jobs([job], user_id="user-1", bulk=True)
    assert "pending_bulk_attempted_ids" not in state
    assert "1246" in errors[0]


def test_evidence_retry_requires_a_plausible_profile_relative_role():
    assert can_retry_pending_evidence(_job_for_retry(1, "target_match"))
    assert not can_retry_pending_evidence(_job_for_retry(2, "unrelated"))
    assert not can_retry_pending_evidence(_job_for_retry(3, "excluded"))


def test_bulk_retry_cohorts_are_limited_to_the_visible_filtered_eligible_jobs():
    jobs = [
        _job_for_retry(1, "target_match"),
        replace_job(_job_for_retry(2, "target_adjacent"), availability_status="active", location_eligibility="unclear"),
        replace_job(_job_for_retry(3, "target_match"), availability_status="expired"),
        replace_job(_job_for_retry(4, "unrelated"), availability_status="active"),
    ]
    verification, evidence = pending_retry_cohorts(jobs, {1})
    assert verification == []
    assert [job.id for job in evidence] == [2]


def _job_for_retry(job_id, role):
    return DashboardJob(
        id=job_id, source="test", company="Example", title="Role", location=None,
        remote_scope=None, source_url="https://example.test/job", application_url=None,
        availability_status="validation_failed", verification_status="validation_failed",
        review_status="new", posted_at=None, first_seen_at=None, last_seen_at=None,
        fit_score=None, fit_assessment_id=None, role_eligibility=role,
    )


def replace_job(job, **updates):
    from dataclasses import replace

    return replace(job, **updates)


def test_listing_url_validation_requires_http_url():
    assert validate_listing_url(" https://example.test/jobs/8 ") == "https://example.test/jobs/8"
    with pytest.raises(ValueError):
        validate_listing_url("example.test/jobs/8")


def test_listing_url_save_changes_only_the_application_link():
    class Client:
        def __init__(self):
            self.writes = []

        def json_request(self, method, path, payload, *, prefer=None):
            self.writes.append((method, path, payload))

    client = Client()
    save_listing_url(client, job_id=8, url="https://example.test/jobs/8")
    method, path, payload = client.writes[-1]
    assert method == "PATCH"
    assert path == "/rest/v1/jobs?id=eq.8"
    assert payload == {"application_url": "https://example.test/jobs/8"}


def test_global_acceptance_lists_reviewable_fields_and_blocks_missing_full_jd():
    job = replace(
        _dashboard_job(88, "Security Engineer"),
        role_eligibility="target_adjacent", role_reason="Role relevance needs review.",
        location_eligibility="ineligible", location_reason="The location is outside the configured region.",
        description_kind="missing", description_available=False,
    )
    assert dashboard._listing_acceptance_fields(job) == ("role", "location")
    blockers = dashboard._listing_acceptance_blockers(job, active_profile_id=7)
    assert any("verified full job description" in item for item in blockers)
    ready = replace(job, description_kind="full", description_available=True)
    assert dashboard._listing_acceptance_blockers(ready, active_profile_id=7) == ()
    assert "Verify that this exact listing is still open first." in dashboard._listing_acceptance_blockers(
        replace(ready, availability_status="unknown"), active_profile_id=7
    )


def test_archive_action_requests_a_full_rerun_when_membership_changes(monkeypatch):
    from contextlib import nullcontext

    context = nullcontext()
    rerun_calls = []
    monkeypatch.setattr(dashboard, "archive_job", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(dashboard, "st", SimpleNamespace(
        columns=lambda spec: [context for _ in range(spec if isinstance(spec, int) else len(spec))],
        container=lambda **_kwargs: context,
        button=lambda label, *, key, **_kwargs: key == "archive-89",
        rerun=lambda **kwargs: rerun_calls.append(kwargs) or (_ for _ in ()).throw(RuntimeError("rerun")),
    ))
    with pytest.raises(RuntimeError, match="rerun"):
        dashboard._render_lifecycle_actions(
            _dashboard_job(89, "Security Engineer"), FakeClient(), user_id="user-1",
            cv_version_id=3, active_profile_id=7, failed_fingerprints={}, disabled=False,
        )
    assert rerun_calls == [{}]


def test_rate_and_retry_actions_use_the_existing_manual_jd_fit_workflow(monkeypatch):
    calls = []
    reruns = []
    monkeypatch.setattr(
        "ui.dashboard.rate_job_with_manual_jd",
        lambda *args, **kwargs: calls.append((args, kwargs)) or {
            "fit_score": 82, "strengths": ["Owned security program"], "gaps": ["Limited cloud depth"]
        },
    )
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(
        session_state={},
        spinner=lambda *_: nullcontext(),
        rerun=lambda **kwargs: reruns.append(kwargs),
        error=lambda *_: pytest.fail("unexpected dashboard error"),
    ))
    row = DashboardJob(
        id=10, source="manual", company="Acme", title="Security Lead", location=None,
        remote_scope=None, source_url=None, application_url=None, availability_status="active",
        verification_status="verified", review_status="new", posted_at=None, first_seen_at=None,
        last_seen_at=None, fit_score=None, fit_assessment_id=None, fit_fingerprint="f" * 64,
        description="A complete job description", description_kind="full", is_manual=True,
    )

    _retry_rating(row, object(), "user-1", 3, 7, {})

    assert len(calls) == 1
    assert calls[0][1] == {
        "user_id": "user-1", "cv_version_id": 3, "candidate_profile_id": 7,
        "job_id": 10, "jd_text": "A complete job description",
    }
    assert reruns == [{"scope": "fragment"}]
    assert _dashboard_job_overrides("user-1", 10) == {
        "fit_score": 82,
        "fit_strengths": ("Owned security program",),
        "fit_gaps": ("Limited cloud depth",),
        "fit_attempt_failed": False,
        "fit_assessment_id": None,
        "fit_fingerprint": "f" * 64,
        "review_status": "rated",
    }
    from dataclasses import replace
    from ui.dashboard_data import group_dashboard_jobs

    refreshed_job = replace(row, **_dashboard_job_overrides("user-1", 10))
    assert group_dashboard_jobs([refreshed_job])[0][0] == "80–89"


def test_tailored_pdf_bytes_are_cached_and_user_path_scoped(monkeypatch):
    from ui.dashboard import _download_tailored_pdf_cached

    calls = []
    client = SimpleNamespace(download_storage_object=lambda bucket, path: calls.append((bucket, path)) or b"pdf")
    _download_tailored_pdf_cached.clear()

    assert _download_tailored_pdf_cached(client, "cv-artifacts", "user-a/tailored/7/a.pdf", "user-a") == b"pdf"
    assert _download_tailored_pdf_cached(client, "cv-artifacts", "user-a/tailored/7/a.pdf", "user-a") == b"pdf"
    assert calls == [("cv-artifacts", "user-a/tailored/7/a.pdf")]
    with pytest.raises(PersistenceError, match="outside the current user's storage scope"):
        _download_tailored_pdf_cached(client, "cv-artifacts", "user-b/tailored/7/b.pdf", "user-a")


def test_bulk_rating_uses_existing_fit_path_only_for_ready_jobs(monkeypatch):
    from dataclasses import replace

    calls = []
    monkeypatch.setattr(
        "ui.dashboard.rate_job_with_manual_jd",
        lambda client, **kwargs: calls.append(kwargs) or {"cache_hit": kwargs["job_id"] == 10},
    )
    ready = DashboardJob(
        id=10, source="manual", company="Acme", title="Security Lead", location=None,
        remote_scope=None, source_url=None, application_url=None, availability_status="active",
        verification_status="verified", review_status="new", posted_at=None, first_seen_at=None,
        last_seen_at=None, fit_score=None, fit_assessment_id=None, is_manual=True,
        description="Full JD", description_kind="full",
    )
    pending = replace(ready, id=11, source="test", is_manual=False, availability_status="unknown")
    completed, cache_hits, failed = rate_jobs(
        [ready, pending], object(), user_id="user-1", cv_version_id=3,
        candidate_profile_id=7, failed_fingerprints={},
    )
    assert [job.id for job in completed] == [10]
    assert cache_hits == 1
    assert failed == []
    assert calls == [{
        "user_id": "user-1", "cv_version_id": 3, "candidate_profile_id": 7,
        "job_id": 10, "jd_text": "Full JD",
    }]


def test_bulk_rating_reports_progress_in_small_batches(monkeypatch):
    from dataclasses import replace

    monkeypatch.setattr("ui.dashboard.rate_job_with_manual_jd", lambda *_args, **_kwargs: {"cache_hit": False})
    template = DashboardJob(
        id=20, source="manual", company="Acme", title="Security Lead", location=None,
        remote_scope=None, source_url=None, application_url=None, availability_status="active",
        verification_status="verified", review_status="new", posted_at=None, first_seen_at=None,
        last_seen_at=None, fit_score=None, fit_assessment_id=None, is_manual=True,
        description="Full JD", description_kind="full",
    )
    progress = []
    completed, cache_hits, failed = rate_jobs(
        [replace(template, id=20 + index) for index in range(6)], object(), user_id="user-1",
        cv_version_id=3, candidate_profile_id=7, failed_fingerprints={},
        progress_callback=lambda done, total: progress.append((done, total)),
    )
    assert len(completed) == 6
    assert cache_hits == 0
    assert failed == []
    assert progress == [(5, 6), (6, 6)]


def test_select_all_section_callback_sets_only_section_items(monkeypatch):
    state = {"section": True}
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(session_state=state))
    from ui.dashboard import _select_section_jobs

    _select_section_jobs([2, 4], "section")
    assert state == {"section": True, "archive-select-2": True, "archive-select-4": True}


def test_individual_section_selection_keeps_select_all_state_in_sync(monkeypatch):
    state = {"archive-select-2": True, "archive-select-4": True}
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(session_state=state))
    from ui.dashboard import _sync_section_selection

    _sync_section_selection([2, 4], "section")
    assert state["section"] is True
    state["archive-select-4"] = False
    _sync_section_selection([2, 4], "section")
    assert state["section"] is False


def test_rendering_ready_to_rate_job_does_not_invoke_fit(monkeypatch):
    buttons = []
    context = nullcontext()
    monkeypatch.setattr("ui.dashboard.rate_job_with_manual_jd", lambda *args, **kwargs: pytest.fail("render must not rate"))
    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(
        session_state={},
                container=lambda **_: context,
                empty=lambda: SimpleNamespace(container=lambda: context),
                checkbox=lambda *_args, **_kwargs: False,
            columns=lambda sizes: [context for _ in range(sizes)] if isinstance(sizes, int) else [context for _ in sizes],
        markdown=lambda *_args, **_kwargs: None,
        subheader=lambda *_args, **_kwargs: None,
        link_button=lambda *_args, **_kwargs: None,
        button=lambda label, **_: buttons.append(label) or False,
        caption=lambda *_: None,
    ))
    row = DashboardJob(
        id=11, source="manual", company="Acme", title="Security Lead", location=None,
        remote_scope=None, source_url="https://example.test/job/11", application_url=None,
        availability_status="active", verification_status="verified", review_status="new",
        posted_at=None, first_seen_at=None, last_seen_at=None, fit_score=None, fit_assessment_id=None,
        fit_fingerprint="f" * 64, description="Complete JD", description_kind="full", is_manual=True,
    )
    from ui.dashboard import _render_job
    getattr(_render_job, "__wrapped__", _render_job)(row, object(), user_id="user-1", cv_version_id=3, active_profile_id=7, storage_bucket="private")

    assert "Rate job" in buttons


def test_mark_applied_navigates_to_applications_without_mutating_status_widget(monkeypatch):
    status = {"dashboard_status": "Unaddressed"}
    context = nullcontext()
    monkeypatch.setattr("ui.dashboard.mark_applied", lambda *args, **kwargs: None)

    def click_button(label, **kwargs):
        if label == "Mark applied":
            kwargs["on_click"](*kwargs.get("args", ()), **kwargs.get("kwargs", {}))
            return True
        return False

    monkeypatch.setattr("ui.dashboard.st", SimpleNamespace(
        session_state=status,
                container=lambda **_: context,
                empty=lambda: SimpleNamespace(container=lambda: context),
                checkbox=lambda *_args, **_kwargs: False,
            columns=lambda sizes: [context for _ in range(sizes)] if isinstance(sizes, int) else [context for _ in sizes],
        markdown=lambda *_args, **_kwargs: None,
        subheader=lambda *_args, **_kwargs: None,
        link_button=lambda *_args, **_kwargs: None,
        button=click_button,
        caption=lambda *_: None,
        error=lambda *_: pytest.fail("unexpected dashboard error"),
    ))
    row = DashboardJob(
        id=12, source="manual", company="Acme", title="Security Lead", location=None,
        remote_scope=None, source_url="https://example.test/job/12", application_url=None,
        availability_status="active", verification_status="verified", review_status="new",
        posted_at=None, first_seen_at=None, last_seen_at=None, fit_score=80, fit_assessment_id=9,
        description="Complete JD", description_kind="full", is_manual=True,
    )
    from ui.dashboard import _render_job
    getattr(_render_job, "__wrapped__", _render_job)(row, object(), user_id="user-1", cv_version_id=3, active_profile_id=7, storage_bucket="private")

    assert status["dashboard_status"] == "Unaddressed"
    assert status["app_page"] == "Applications"
    assert status["application_stage_filter"] == "Active"
