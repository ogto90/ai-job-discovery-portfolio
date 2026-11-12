from datetime import datetime
from types import SimpleNamespace

import pytest

from matching.application_lifecycle import (
    ALLOWED_TRANSITIONS,
    can_generate_cv_state,
    can_apply_state,
    can_transition,
    can_rate_state,
    lifecycle_state,
    workflow_timestamp_column,
)
from ui.dashboard import transition_job_lifecycle
from ui.dashboard_data import DashboardJob, can_generate_cv, can_archive_job, can_rerate_job, group_application_jobs, group_dashboard_jobs
from matching.candidate_profile_persistence import PersistenceError


def _job(state="rated", *, score=78, description="Full JD"):
    return DashboardJob(
        id=1, source="test", company="Example", title="Role", location=None,
        remote_scope="Remote", source_url="https://example.test/job", application_url=None,
        availability_status="active", verification_status=None, review_status=state,
        posted_at=None, first_seen_at=None, last_seen_at=None, fit_score=score,
        fit_assessment_id=10 if score is not None else None, description=description,
        description_kind="full" if description else "missing", is_manual=True,
    )


class FakeClient:
    def __init__(self, application=None, review=None):
        self.application = application
        self.review = review
        self.writes = []

    def get_json(self, path):
        if path.startswith("/rest/v1/applications?"):
            return [self.application] if self.application else []
        if path.startswith("/rest/v1/job_reviews?"):
            return [self.review] if self.review else []
        raise AssertionError(path)

    def json_request(self, method, path, payload, *, prefer=None):
        self.writes.append((method, path, payload))
        if path == "/rest/v1/applications":
            self.application = {"id": 1, **payload}
        elif path == "/rest/v1/job_reviews":
            self.review = {"id": 1, **payload}
        elif path.startswith("/rest/v1/applications?id="):
            self.application.update(payload)
        elif path.startswith("/rest/v1/job_reviews?id="):
            self.review.update(payload)
        return [payload]


@pytest.mark.parametrize("status", ["applied", "interview", "offer", "hired", "rejected", "withdrawn"])
def test_application_state_overrides_fit_without_changing_fit(status):
    assert lifecycle_state({"status": status}, None, has_current_fit=True) == status


def test_application_status_takes_precedence_over_older_review_archive_state():
    assert lifecycle_state({"status": "applied"}, {"status": "ignored"}, has_current_fit=True) == "applied"
    assert lifecycle_state({"status": "applied"}, {"status": "archived"}, has_current_fit=True) == "applied"


def test_ignore_and_archive_apply_when_no_application_workflow_exists():
    assert lifecycle_state(None, {"status": "ignored"}, has_current_fit=True) == "ignored"
    assert lifecycle_state(None, {"status": "archived"}, has_current_fit=True) == "archived"


def test_fit_state_is_derived_without_an_application_row():
    assert lifecycle_state(None, None, has_current_fit=False) == "new"
    assert lifecycle_state(None, {"status": "interested"}, has_current_fit=True) == "rated"


def test_closing_states_gate_rate_and_cv_and_new_states_allow_both():
    for state in ("hired", "rejected", "withdrawn", "ignored", "archived"):
        assert not can_rate_state(state)
        assert not can_generate_cv_state(state)
        job = _job(state)
        assert not can_generate_cv(job)
        assert not can_rerate_job(job)
        assert not can_apply_state(state)
        assert not can_transition(state, "applied")
    assert can_rate_state("rated") and can_generate_cv_state("rated")
    assert can_archive_job(_job("new", score=None))
    assert can_archive_job(_job("applied"))


def test_transition_table_supports_normal_progression_and_reopen():
    assert ALLOWED_TRANSITIONS["new"] == {"applied", "archived"}
    assert "offer" in ALLOWED_TRANSITIONS["interview"]
    assert "hired" in ALLOWED_TRANSITIONS["offer"]
    for state in ("hired", "rejected", "withdrawn", "ignored", "archived"):
        assert "reopen" in ALLOWED_TRANSITIONS[state]
    assert workflow_timestamp_column("rejected") == "rejected_at"


@pytest.mark.parametrize(
    ("source", "target"),
    [
        ("new", "applied"), ("rated", "applied"),
        ("applied", "interview"), ("interview", "offer"), ("offer", "hired"),
        ("applied", "rejected"), ("interview", "rejected"), ("offer", "rejected"),
        ("applied", "withdrawn"), ("rated", "archived"),
        ("new", "archived"), ("ignored", "reopen"), ("rejected", "reopen"),
        ("archived", "reopen"),
    ],
)
def test_requested_lifecycle_transitions_are_supported(source, target):
    assert can_transition(source, target)


def test_new_to_rated_is_derived_from_current_fit_without_persisted_state():
    assert lifecycle_state(None, None, has_current_fit=False) == "new"
    assert lifecycle_state(None, None, has_current_fit=True) == "rated"


def test_mark_interview_updates_only_current_users_application_and_timestamp():
    client = FakeClient(application={"id": 4, "status": "applied"})
    transition_job_lifecycle(client, user_id="u1", job_id=12, target="interview", has_current_fit=True)
    method, path, payload = client.writes[0]
    assert method == "PATCH" and path.startswith("/rest/v1/applications?id=eq.4")
    assert payload["status"] == "interview"
    assert payload["status_changed_at"] == payload["interview_at"]
    assert client.application["status"] == "interview"
    assert "user_id=eq.u1" in client.writes[0][1]
    assert "job_id=eq.12" in client.writes[0][1]


def test_archived_review_does_not_block_rejecting_an_active_application():
    client = FakeClient(
        application={"id": 4, "status": "applied"},
        review={"id": 8, "status": "archived"},
    )
    transition_job_lifecycle(client, user_id="u1", job_id=12, target="rejected")
    assert client.application["status"] == "rejected"
    assert client.application["rejected_at"] == client.application["status_changed_at"]
    assert len(client.writes) == 1
    assert client.writes[0][1].startswith("/rest/v1/applications?id=eq.4")


def test_invalid_transition_is_rejected_without_a_write():
    client = FakeClient(application={"id": 4, "status": "rejected"})
    with pytest.raises(PersistenceError, match="Cannot move"):
        transition_job_lifecycle(client, user_id="u1", job_id=12, target="offer")
    assert client.writes == []


def test_applied_cannot_be_marked_applied_again():
    client = FakeClient(application={"id": 4, "status": "applied"})
    with pytest.raises(PersistenceError, match="already applied"):
        transition_job_lifecycle(client, user_id="u1", job_id=12, target="applied")
    assert client.writes == []


def test_reopen_preserves_application_row_and_returns_terminal_to_draft():
    client = FakeClient(application={"id": 4, "status": "rejected"})
    transition_job_lifecycle(client, user_id="u1", job_id=12, target="reopen", has_current_fit=True)
    assert client.application["status"] == "draft"
    assert client.application["status_changed_at"]
    assert client.writes[0][0] == "PATCH"


def test_closed_jobs_are_grouped_by_lifecycle_not_fit_band():
    applied = _job("applied")
    rejected = _job("rejected")
    rated = _job("rated")
    groups = dict(group_application_jobs([applied, rejected]))
    assert [job.id for job in groups["Applied"]] == [applied.id]
    assert [job.id for job in groups["Closed applications"]] == [rejected.id]
    assert any(rated in group for label, group in group_dashboard_jobs([rated]))


def test_lifecycle_migration_preserves_server_only_security_and_profile_lineage():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    migration = next((root / "supabase/migrations").glob("*_user_job_lifecycle_and_gap_generalization.sql"))
    sql = migration.read_text().lower()
    assert "alter table public.applications" in sql
    assert "alter table public.job_reviews" in sql
    assert "create table public.job_fit_gap_mappings" in sql
    assert "enable row level security" in sql
    assert "revoke all on table public.job_fit_gap_mappings from anon, authenticated" in sql
    assert "grant select, insert, update, delete on table public.job_fit_gap_mappings to service_role" in sql
    assert "foreign key (assessment_id, user_id, candidate_profile_id, job_id)" in sql
    assert "references public.job_match_assessments(id, user_id, candidate_profile_id, job_id)" in sql
    assert "alter table public.jobs" not in sql
    assert "create policy" not in sql
