from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from urllib.parse import parse_qs, urlparse

import pytest

from matching.artifact_lifecycle_lock import artifact_lifecycle_lock
from matching.candidate_profile_persistence import SupabaseRestClient
from matching.tailored_cv_expiration import run_tailored_cv_cleanup
from tests.test_tailored_cv_expiration import FakeCleanupClient, NOW


@pytest.fixture(autouse=True)
def isolated_locks(tmp_path, monkeypatch):
    monkeypatch.setattr("matching.artifact_lifecycle_lock._lock_directory", lambda: tmp_path)


def test_application_committing_during_enumeration_prevents_cleanup():
    client = FakeCleanupClient()
    entered, release = Event(), Event()
    applications = []
    original = client.get_json
    client.get_json = lambda path: list(applications) if "/applications?" in path else original(path)
    writer = SupabaseRestClient(client.base_url, "dummy")

    def write(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        applications.append({"user_id": "user-1", "job_id": 8, "status": "applied"})
        return 200, b"[]"

    writer._request_unlocked = write
    with ThreadPoolExecutor(max_workers=2) as pool:
        applying = pool.submit(writer.request, "POST", "/rest/v1/applications")
        assert entered.wait(3)
        cleaning = pool.submit(run_tailored_cv_cleanup, client, now=NOW)
        try:
            assert client.deleted == []
        finally:
            release.set()
        applying.result(timeout=3)
        result = cleaning.result(timeout=3)
    assert result.deleted == 0 and result.retained == 1
    assert client.deleted == []


def test_application_cannot_overlap_storage_deletion():
    client = FakeCleanupClient()
    deleting, release, writing = Event(), Event(), Event()
    original = client.delete_storage_object

    def delete(bucket, path):
        deleting.set()
        assert release.wait(3)
        original(bucket, path)

    client.delete_storage_object = delete
    writer = SupabaseRestClient(client.base_url, "dummy")
    writer._request_unlocked = lambda *args, **kwargs: (writing.set() or (200, b"[]"))
    with ThreadPoolExecutor(max_workers=2) as pool:
        cleaning = pool.submit(run_tailored_cv_cleanup, client, now=NOW)
        assert deleting.wait(3)
        applying = pool.submit(writer.request, "POST", "/rest/v1/applications")
        try:
            assert not writing.wait(0.1)
        finally:
            release.set()
        assert cleaning.result(timeout=3).deleted == 1
        applying.result(timeout=3)
    assert writing.is_set()


def test_uncertain_application_write_pauses_cleanup():
    client = FakeCleanupClient()
    with pytest.raises(RuntimeError):
        with artifact_lifecycle_lock(client.base_url, application_write=True):
            raise RuntimeError("lost response")
    result = run_tailored_cv_cleanup(client, now=NOW)
    assert result.deleted == 0 and result.failures
    assert "unconfirmed outcome" in result.failures[0]
    assert not client.deleted
    # A later successful unrelated application must not erase the safety marker.
    with artifact_lifecycle_lock(client.base_url, application_write=True):
        pass
    assert run_tailored_cv_cleanup(client, now=NOW).failures


def test_cleanup_paginates_even_when_server_returns_short_pages():
    client = FakeCleanupClient()
    original = client.get_json
    seen = []

    def read(path):
        query = parse_qs(urlparse(path).query)
        if query.get("id", [""])[0].startswith("gt."):
            last = int(query["id"][0][3:])
            seen.append(last)
            return [{"id": last + 1, "user_id": "user-1"}] if last < 3 else []
        if "/cv_versions?" in path:
            return [{**client.row, "id": int(query["id"][0][3:]), "is_base": True}]
        return original(path)

    client.get_json = read
    result = run_tailored_cv_cleanup(client, now=NOW)
    assert result.inspected == 3 and result.retained == 3
    assert seen == [0, 1, 2, 3]
    assert not client.deleted


def test_application_lookup_is_scoped_not_truncated_global_list():
    client = FakeCleanupClient()
    original = client.get_json

    def read(path):
        if "/applications?" in path:
            query = parse_qs(urlparse(path).query)
            assert query["user_id"] == ["eq.user-1"] and query["job_id"] == ["eq.8"]
            return [{"user_id": "user-1", "job_id": 8, "status": "interview"}]
        return original(path)

    client.get_json = read
    assert run_tailored_cv_cleanup(client, now=NOW).retained == 1
    assert not client.deleted


@pytest.mark.parametrize("change", [{"is_base": True}, {"tex_file_path": "user-1/base/main.tex"}, {"created_at": "bad"}])
def test_cleanup_rechecks_base_and_paths(change):
    client = FakeCleanupClient()
    client.row.update(change)
    result = run_tailored_cv_cleanup(client, now=NOW)
    assert result.deleted == 0 and not client.deleted


def test_recent_terminal_application_gets_full_retention_window():
    client = FakeCleanupClient()
    original = client.get_json
    terminal = NOW - timedelta(days=1)
    client.get_json = lambda path: [{"user_id": "user-1", "job_id": 8, "status": "rejected", "terminal_at": terminal.isoformat()}] if "/applications?" in path else original(path)
    assert run_tailored_cv_cleanup(client, now=NOW).retained == 1
    assert client.row["expires_at"] == (terminal + timedelta(days=40)).isoformat()
