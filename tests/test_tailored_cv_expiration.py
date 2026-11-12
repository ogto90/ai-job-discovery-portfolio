from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import pytest

from matching.candidate_profile_persistence import PersistenceError
from matching.tailored_cv_expiration import (
    artifacts_available,
    calculate_expiration,
    run_tailored_cv_cleanup,
)


NOW = datetime(2026, 10, 4, tzinfo=timezone.utc)


def test_expiration_policy_distinguishes_unapplied_active_and_terminal():
    created = NOW - timedelta(days=41)
    assert calculate_expiration(created_at=created) == created + timedelta(days=40)
    assert calculate_expiration(created_at=created, application_status="applied") is None
    terminal = NOW - timedelta(days=41)
    assert calculate_expiration(
        created_at=created,
        application_status="rejected",
        terminal_at=terminal,
    ) == terminal + timedelta(days=40)


def test_base_and_recent_tailored_rows_do_not_expire():
    recent = (NOW - timedelta(days=39)).isoformat()
    assert not artifacts_available({"is_base": True, "tex_file_path": "a", "pdf_file_path": "b"}, now=NOW)
    assert artifacts_available(
        {
            "is_base": False,
            "tex_file_path": "a",
            "pdf_file_path": "b",
            "created_at": recent,
            "expires_at": (NOW + timedelta(days=1)).isoformat(),
        },
        now=NOW,
    )


class FakeCleanupClient:
    base_url = "https://cleanup-offline.test"
    def __init__(self, *, fail_pdf=False):
        self.row = {
            "id": 11,
            "user_id": "user-1",
            "job_id": 8,
            "is_base": False,
            "storage_bucket": "cv-artifacts",
            "created_at": (NOW - timedelta(days=41)).isoformat(),
            "expires_at": None,
            "artifacts_deleted_at": None,
            "tex_file_path": "user-1/tailored/8/a.tex",
            "pdf_file_path": "user-1/tailored/8/a.pdf",
            "file_path": "user-1/tailored/8/a.pdf",
        }
        self.fail_pdf = fail_pdf
        self.deleted = []
        self.patches = []

    def get_json(self, path):
        if "/cv_versions?" in path:
            query = parse_qs(urlparse(path).query)
            bound = query.get("id", [""])[0]
            if bound.startswith("gt.") and int(bound[3:]) >= self.row["id"]:
                return []
            return [dict(self.row)]
        if "/applications?" in path:
            return []
        if "/job_reviews?" in path:
            query = parse_qs(urlparse(path).query)
            if self.row.get("review_status"):
                return [{
                    "user_id": self.row["user_id"],
                    "job_id": self.row["job_id"],
                    "status": self.row["review_status"],
                }]
            return []
        raise AssertionError(path)

    def delete_storage_object(self, bucket, path):
        if self.fail_pdf and path.endswith(".pdf"):
            raise PersistenceError("Supabase DELETE failed with HTTP 503")
        self.deleted.append((bucket, path))

    def json_request(self, method, path, payload, *, prefer=None):
        assert method == "PATCH"
        self.patches.append(payload)
        self.row.update(payload)
        return [self.row]


def test_cleanup_deletes_both_objects_then_marks_row_and_is_idempotent():
    client = FakeCleanupClient()
    result = run_tailored_cv_cleanup(client, now=NOW)
    assert result.deleted == 1
    assert len(client.deleted) == 2
    assert client.row["artifacts_deleted_at"] == NOW.isoformat()

    second = run_tailored_cv_cleanup(client, now=NOW)
    assert second.deleted == 0
    assert len(client.deleted) == 2


def test_failed_storage_delete_leaves_row_retryable():
    client = FakeCleanupClient(fail_pdf=True)
    result = run_tailored_cv_cleanup(client, now=NOW)
    assert result.deleted == 0
    assert result.failures
    assert client.row["artifacts_deleted_at"] is None
    assert client.deleted == [("cv-artifacts", "user-1/tailored/8/a.tex")]


def test_archived_unapplied_job_artifacts_are_removed_immediately():
    from matching.tailored_cv_expiration import run_archived_cv_cleanup_for_job

    client = FakeCleanupClient()
    client.row["created_at"] = NOW.isoformat()
    client.row["review_status"] = "archived"
    result = run_archived_cv_cleanup_for_job(client, user_id="user-1", job_id=8, now=NOW)

    assert result.deleted == 1
    assert len(client.deleted) == 2
    assert client.row["artifacts_deleted_at"] == NOW.isoformat()


def test_archived_job_with_active_application_keeps_cv_artifacts():
    from matching.tailored_cv_expiration import run_archived_cv_cleanup_for_job

    client = FakeCleanupClient()
    client.row["review_status"] = "archived"
    original_get_json = client.get_json

    def get_json(path):
        if "/applications?" in path:
            return [{"user_id": "user-1", "job_id": 8, "status": "applied"}]
        return original_get_json(path)

    client.get_json = get_json
    result = run_archived_cv_cleanup_for_job(client, user_id="user-1", job_id=8, now=NOW)

    assert result.deleted == 0
    assert not client.deleted
    assert client.row["artifacts_deleted_at"] is None


def test_archive_cleanup_storage_failure_remains_retryable():
    from matching.tailored_cv_expiration import run_archived_cv_cleanup_for_job

    client = FakeCleanupClient(fail_pdf=True)
    client.row["review_status"] = "archived"
    result = run_archived_cv_cleanup_for_job(client, user_id="user-1", job_id=8, now=NOW)

    assert result.deleted == 0
    assert result.failures
    assert client.row["artifacts_deleted_at"] is None
    assert client.deleted == [("cv-artifacts", "user-1/tailored/8/a.tex")]


def test_archived_only_sweep_does_not_run_general_expiry_sweep():
    from matching.tailored_cv_expiration import run_archived_tailored_cv_cleanup

    client = FakeCleanupClient()
    archived_queries = []
    original_get_json = client.get_json

    def get_json(path):
        if "/job_reviews?" in path:
            archived_queries.append(path)
            query = parse_qs(urlparse(path).query)
            if query.get("status") == ["eq.archived"]:
                return [{"user_id": "user-1", "job_id": 8}] if query.get("offset") == ["0"] else []
            return [{"user_id": "user-1", "job_id": 8, "status": "archived"}]
        return original_get_json(path)

    client.get_json = get_json
    result = run_archived_tailored_cv_cleanup(client, now=NOW)

    assert result.deleted == 1
    assert len(client.deleted) == 2
    sweep_offsets = [
        parse_qs(urlparse(path).query).get("offset", [None])[0]
        for path in archived_queries
        if parse_qs(urlparse(path).query).get("status") == ["eq.archived"]
    ]
    assert sweep_offsets == ["0", "1"]
