from dataclasses import replace

from ui.dashboard_data import DashboardJob
from ui.settings import _attention_items, _discovery_count, _discovery_issue_counts, _navigate_to_dashboard


def test_discovery_summary_count_rejects_invalid_values():
    assert _discovery_count({"new_jobs": 58}, "new_jobs") == 58
    assert _discovery_count({"new_jobs": True}, "new_jobs") == 0
    assert _discovery_count({"new_jobs": -1}, "new_jobs") == 0
    assert _discovery_count({}, "new_jobs") == 0


def _job(job_id: int) -> DashboardJob:
    return DashboardJob(
        id=job_id,
        source="test",
        company=f"Company {job_id}",
        title="Security Engineer",
        location="Europe",
        remote_scope="Remote Europe",
        source_url=f"https://example.test/{job_id}",
        application_url=None,
        availability_status="active",
        verification_status="verified",
        review_status="new",
        posted_at=None,
        first_seen_at=None,
        last_seen_at=None,
        fit_score=None,
        fit_assessment_id=None,
        role_eligibility="target_match",
        location_eligibility="eligible",
        language_eligibility="eligible",
        description="Complete job description",
        description_kind="full",
    )


def test_attention_items_count_and_route_each_actionable_category():
    jobs = [
        replace(_job(1), availability_status="unknown"),
        replace(_job(2), description=None, description_kind="missing"),
        replace(_job(3), description=None, description_kind="missing"),
        replace(_job(4), fit_attempt_failed=True),
        replace(_job(5), location_eligibility="unclear"),
        replace(_job(6), fit_score=82, fit_assessment_id=6),
        _job(7),
    ]

    assert _attention_items(jobs) == [
        ("Verification needed", 1, "Pending / unresolved", "All", "Verification needed"),
        ("JD required", 2, "Unaddressed", "JD required", "All unresolved"),
        ("Ready to rate", 1, "Unaddressed", "Ready to rate", "All unresolved"),
        ("Rating failed", 1, "Unaddressed", "Rating failed", "All unresolved"),
        ("Location unclear", 1, "Pending / unresolved", "All", "Location unclear"),
    ]


def test_attention_items_are_empty_when_nothing_needs_action():
    assert _attention_items([replace(_job(1), fit_score=80, fit_assessment_id=1)]) == []


def test_dashboard_context_snapshot_is_per_user_and_refresh_clears_it(monkeypatch):
    import streamlit as st
    from ui.dashboard import (
        get_dashboard_context_snapshot,
        get_dashboard_jobs_snapshot,
        refresh_dashboard_data,
        save_dashboard_context_snapshot,
    )

    state = {}
    monkeypatch.setattr(st, "session_state", state)
    jobs = [_job(1)]
    context = (jobs, 7, "user-a", 3, "cv-artifacts")
    save_dashboard_context_snapshot("user-a", context)

    assert get_dashboard_jobs_snapshot("user-a") is jobs
    assert get_dashboard_jobs_snapshot("user-b") is None
    assert get_dashboard_context_snapshot("user-a") == context
    assert get_dashboard_context_snapshot("user-b") is None

    refresh_dashboard_data("user-a")
    assert get_dashboard_jobs_snapshot("user-a") is None
    assert get_dashboard_context_snapshot("user-a") is None


def test_lifecycle_card_update_updates_applications_snapshot(monkeypatch):
    import streamlit as st
    from ui.dashboard import get_dashboard_context_snapshot, _record_dashboard_lifecycle_override, save_dashboard_context_snapshot

    monkeypatch.setattr(st, "session_state", {})
    save_dashboard_context_snapshot("user-a", ([_job(1)], 7, "user-a", 3, "cv-artifacts"))
    _record_dashboard_lifecycle_override("user-a", 1, review_status="applied", application_status="applied")

    context = get_dashboard_context_snapshot("user-a")
    assert context[0][0].review_status == "applied"
    assert context[0][0].application_status == "applied"


def test_settings_attention_summary_distinguishes_unloaded_from_empty(monkeypatch):
    import streamlit as st
    from ui.settings import _render_attention_summary

    captions = []
    monkeypatch.setattr(st, "subheader", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(st, "caption", lambda value, **_kwargs: captions.append(value))
    _render_attention_summary(None)
    assert captions == ["Review counts appear after the Jobs page has loaded during this session."]


def test_attention_navigation_sets_jobs_page_and_matching_filters(monkeypatch):
    import streamlit as st

    state = {}
    monkeypatch.setattr(st, "session_state", state)
    _navigate_to_dashboard("Pending / unresolved", "All", "Verification needed")
    assert state == {
        "app_page": "Jobs",
        "dashboard_section": "Jobs",
        "dashboard_status": "Pending / unresolved",
        "dashboard_status_initialized": True,
        "dashboard_fit_state": "All",
        "pending_reason_filter": "Verification needed",
    }


def test_discovery_notice_separates_identity_conflicts_from_rate_limits():
    result = {"runs": [{"stats": {"errors": [
        {"source": "linkedin-search", "message": "Physical identity conflict or source URL collision; listing skipped for reconciliation."},
        {"source": "jobicy-search", "message": "429 Too Many Requests"},
        {"source": "other", "message": "Unexpected source failure"},
    ]}}]}
    assert _discovery_issue_counts(result) == (1, 1, 1)
