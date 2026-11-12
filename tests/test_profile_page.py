import copy
from types import SimpleNamespace

import pytest

from matching.candidate_profile import representative_profile
from matching.candidate_profile_persistence import PersistenceError
from ui.profile_data import (
    save_and_parse_base_cv,
    save_job_preferences,
    validate_latex_upload,
)
import ui.profile as profile_ui


VALID_TEX = b"""\\documentclass{article}
\\begin{document}
This is a complete candidate CV document with enough text to be meaningful.
\\end{document}
"""


class FakeProfileClient:
    def __init__(self):
        self.cvs = [{
            "id": 1, "user_id": "user-a", "label": "old.tex", "file_path": "user-a/base/old.tex",
            "storage_bucket": "cv-artifacts", "is_base": True, "is_active": True,
            "created_at": "2026-01-01T00:00:00Z", "notes": None,
        }]
        old_profile = representative_profile().model_copy(update={"source_cv_version_id": 1})
        self.profiles = [{
            "id": 11, "user_id": "user-a", "cv_version_id": 1,
            "profile_json": old_profile.model_dump(mode="json"), "is_active": True,
        }]
        self.storage = {("cv-artifacts", "user-a/base/old.tex"): VALID_TEX}
        self.search_rows = []
        self.writes = []
        self.next_cv = 2
        self.next_profile = 12

    def list_base_cvs(self, user_id):
        return [copy.deepcopy(row) for row in self.cvs if row["user_id"] == user_id]

    def list_active_profiles_for_user(self, user_id):
        return [copy.deepcopy(row) for row in self.profiles if row["user_id"] == user_id and row["is_active"]]

    def list_profiles(self, user_id, cv_version_id):
        return [copy.deepcopy(row) for row in self.profiles if row["user_id"] == user_id and row["cv_version_id"] == cv_version_id]

    def get_json(self, path):
        if "/search_profiles?" in path:
            return [copy.deepcopy(row) for row in self.search_rows if row["user_id"] in path]
        raise AssertionError(path)

    def upload_storage_object(self, bucket, path, data, *, content_type):
        self.storage[(bucket, path)] = data

    def download_storage_object(self, bucket, path):
        return self.storage[(bucket, path)]

    def delete_storage_object(self, bucket, path):
        self.storage.pop((bucket, path), None)

    def json_request(self, method, path, payload=None, *, prefer=None):
        self.writes.append((method, path, copy.deepcopy(payload)))
        if path == "/rest/v1/cv_versions" and method == "POST":
            row = {"id": self.next_cv, "created_at": "2026-10-05T00:00:00Z", **payload}
            self.next_cv += 1
            self.cvs.append(row)
            return [copy.deepcopy(row)]
        if path == "/rest/v1/candidate_profiles" and method == "POST":
            row = {"id": self.next_profile, **payload}
            self.next_profile += 1
            self.profiles.append(row)
            return [copy.deepcopy(row)]
        if path == "/rest/v1/search_profiles" and method == "POST":
            row = {"id": len(self.search_rows) + 1, **payload}
            self.search_rows.append(row)
            return [copy.deepcopy(row)]
        if path.startswith("/rest/v1/cv_versions?") and method == "PATCH":
            cv_id = int(path.split("id=eq.", 1)[1].split("&", 1)[0])
            row = next(row for row in self.cvs if row["id"] == cv_id and row["user_id"] == "user-a")
            row.update(payload)
            return [copy.deepcopy(row)]
        if path.startswith("/rest/v1/candidate_profiles?") and method == "PATCH":
            profile_id = int(path.split("id=eq.", 1)[1].split("&", 1)[0])
            row = next(row for row in self.profiles if row["id"] == profile_id and row["user_id"] == "user-a")
            row.update(payload)
            return [copy.deepcopy(row)]
        if path.startswith("/rest/v1/search_profiles?") and method == "PATCH":
            row = self.search_rows[0]
            row.update(payload)
            return [copy.deepcopy(row)]
        raise AssertionError((method, path))

    def request(self, method, path, **kwargs):
        self.writes.append((method, path, kwargs))
        if method == "DELETE" and "/cv_versions?" in path:
            cv_id = int(path.split("id=eq.", 1)[1].split("&", 1)[0])
            self.cvs = [row for row in self.cvs if row["id"] != cv_id]
        return 204, b""

    def set_cv_active(self, cv_id, user_id, active):
        row = next(row for row in self.cvs if row["id"] == cv_id and row["user_id"] == user_id)
        if active and any(row["user_id"] == user_id and row["is_base"] and row["is_active"] and row["id"] != cv_id for row in self.cvs):
            raise PersistenceError("active CV conflict")
        row["is_active"] = active

    def set_active(self, profile_id, active, *, user_id=None):
        row = next(row for row in self.profiles if row["id"] == profile_id and (user_id is None or row["user_id"] == user_id))
        if active and any(item["user_id"] == row["user_id"] and item["cv_version_id"] == row["cv_version_id"] and item["is_active"] and item["id"] != profile_id for item in self.profiles):
            raise PersistenceError("active profile conflict")
        row["is_active"] = active

    def insert_profile(self, payload):
        row = {"id": self.next_profile, **payload}
        self.next_profile += 1
        self.profiles.append(row)
        return copy.deepcopy(row)

    def resolve_active_base_cv(self, user_id):
        rows = [row for row in self.cvs if row["user_id"] == user_id and row["is_base"] and row["is_active"]]
        if len(rows) != 1:
            raise PersistenceError("active CV count mismatch")
        return type("CV", (), {"id": rows[0]["id"]})()


def test_valid_tex_requires_real_document_structure():
    assert validate_latex_upload("resume.tex", VALID_TEX).startswith("\\documentclass")
    for filename, data in [("resume.pdf", VALID_TEX), ("resume.tex", b""), ("resume.tex", b"% \\documentclass{article}\n" * 20)]:
        with pytest.raises(ValueError):
            validate_latex_upload(filename, data)
    with pytest.raises(ValueError, match="binary"):
        validate_latex_upload("resume.tex", b"\\documentclass{article}\x00")


def test_parse_failure_keeps_old_pair_active_and_cleans_uploaded_draft():
    client = FakeProfileClient()

    def fail_parse(source, cv_id):
        raise RuntimeError("parse failed")

    with pytest.raises(RuntimeError, match="parse failed"):
        save_and_parse_base_cv(client, user_id="user-a", filename="new.tex", data=VALID_TEX, parser=fail_parse, model="test")
    assert [row["id"] for row in client.cvs if row["is_active"]] == [1]
    assert [row["id"] for row in client.profiles if row["is_active"]] == [11]
    assert len(client.cvs) == 1
    assert len(client.storage) == 1


def test_success_activates_new_cv_profile_and_preserves_old_history():
    client = FakeProfileClient()

    def parse(source, cv_id):
        return representative_profile().model_copy(update={"source_cv_version_id": cv_id})

    result = save_and_parse_base_cv(client, user_id="user-a", filename="new.tex", data=VALID_TEX, parser=parse, model="test")
    active_cvs = [row for row in client.cvs if row["is_active"]]
    active_profiles = [row for row in client.profiles if row["is_active"]]
    assert result["cv_version_id"] == active_cvs[0]["id"] == 2
    assert result["candidate_profile_id"] == active_profiles[0]["id"] == 12
    assert client.cvs[0]["is_active"] is False
    assert client.profiles[0]["is_active"] is False
    assert len(client.cvs) == 2 and len(client.profiles) == 2
    assert client.storage[("cv-artifacts", client.cvs[1]["file_path"])] == VALID_TEX
    assert result["input_sha256"]


def test_search_preference_save_preserves_unedited_values_and_scopes_owner():
    client = FakeProfileClient()
    row = {
        "id": 3, "user_id": "user-a", "name": "Existing", "is_active": True,
        "definition": {"target_titles": ["Engineer"], "work_models": ["remote"], "custom_future_field": {"keep": True}},
    }
    client.search_rows = [copy.deepcopy(row)]
    saved = save_job_preferences(client, user_id="user-a", row=row, definition_updates={"target_titles": ["Product Manager"]})
    assert saved["definition"]["target_titles"] == ["Product Manager"]
    assert saved["definition"]["work_models"] == ["remote"]
    assert saved["definition"]["custom_future_field"] == {"keep": True}
    method, path, _ = client.writes[-1]
    assert method == "PATCH" and "user_id=eq.user-a" in path and "id=eq.3" in path
    before = len(client.writes)
    with pytest.raises(PersistenceError, match="current user's active SearchProfile"):
        save_job_preferences(client, user_id="user-b", row=row, definition_updates={"target_titles": []})
    assert len(client.writes) == before


def test_first_search_profile_is_created_only_after_explicit_save():
    client = FakeProfileClient()
    saved = save_job_preferences(
        client, user_id="user-b", row=None,
        definition_updates={"target_titles": ["Product Manager"], "work_models": ["remote"]},
    )
    assert saved["user_id"] == "user-b"
    assert saved["is_active"] is True
    assert saved["definition"]["target_titles"] == ["Product Manager"]
    assert len(client.search_rows) == 1
    assert client.writes[-1][0:2] == ("POST", "/rest/v1/search_profiles")


def test_profile_page_renders_for_owner_without_openai_or_writes():
    from streamlit.testing.v1 import AppTest

    profile_ui._APPTEST_CLIENT = FakeProfileClient()
    app = AppTest.from_function(profile_ui._render_profile_app_test).run()
    assert not app.exception
    assert any("Profile" in str(item.value) for item in app.title)
    assert profile_ui._APPTEST_CLIENT.writes == []


def test_profile_context_is_cached_until_data_revision_changes(monkeypatch):
    from ui import profile_data

    calls = []
    monkeypatch.setattr(profile_data, "_load_profile_context_uncached", lambda client, user_id: calls.append(user_id) or {"user": user_id})
    profile_data._load_profile_context_cached.clear()
    client = SimpleNamespace(base_url="https://supabase.example")

    first = profile_data.load_profile_context(client, "user-cache-test")
    second = profile_data.load_profile_context(client, "user-cache-test")

    assert first == second == {"user": "user-cache-test"}
    assert calls == ["user-cache-test"]


def test_profile_data_queries_do_not_return_another_users_cv():
    client = FakeProfileClient()
    assert client.list_base_cvs("user-b") == []
    assert client.list_profiles("user-b", 1) == []


def test_candidate_preview_does_not_render_internal_evidence_labels():
    profile = representative_profile()
    rendered = repr(profile_ui.candidate_preview_data(profile))
    assert "skills_only" not in rendered
    assert "production_ownership" not in rendered
    assert "Vulnerability Management" in rendered
