import json

import pytest

from matching.candidate_profile import representative_profile
from matching.candidate_profile_persistence import (
    PARSER_VERSION,
    PersistenceError,
    canonical_profile_json,
    invalidate_supabase_read_cache,
    persist_profile,
    replay_saved_extraction,
    sha256_bytes,
    supabase_data_revision,
    supabase_card_revision,
    SupabaseRestClient,
)
from matching.cv_normalizer import extracted_from_profile


def test_supabase_read_cache_revision_changes_only_after_write_requests(monkeypatch):
    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b"[]"

    monkeypatch.setattr("matching.candidate_profile_persistence.urlopen", lambda *_args, **_kwargs: Response())
    client = SupabaseRestClient("https://example.supabase.co", "test-secret")
    before = supabase_data_revision()
    client.request("GET", "/rest/v1/jobs")
    assert supabase_data_revision() == before
    client.request("PATCH", "/rest/v1/applications?id=eq.1", body=b"{}")
    client.request("POST", "/rest/v1/job_reviews", body=b"{}")
    client.request("POST", "/rest/v1/user_job_work_model_verifications?on_conflict=user_id,job_id", body=b"{}")
    assert supabase_data_revision() == before
    client.request("PATCH", "/rest/v1/jobs?id=eq.1", body=b"{}")
    assert supabase_data_revision() == before + 1
    assert invalidate_supabase_read_cache() == before + 2


def test_tailored_generation_writes_do_not_invalidate_other_cards(monkeypatch):
    class Response:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False
        def read(self):
            return b"[]"

    monkeypatch.setattr("matching.candidate_profile_persistence.urlopen", lambda *_args, **_kwargs: Response())
    client = SupabaseRestClient("https://offline.test", "dummy")
    revision = supabase_data_revision()
    card_revision = supabase_card_revision()
    for extension in ("tex", "pdf"):
        client.upload_storage_object("cv-artifacts", f"user-1/tailored/8/attempt.{extension}", b"dummy", content_type="application/octet-stream")
    client.json_request("POST", "/rest/v1/cv_versions", {
        "is_base": False, "is_active": False, "job_id": 8, "source_cv_version_id": 2,
    })
    client.json_request(
        "PATCH",
        "/rest/v1/cv_versions?user_id=eq.user-1&job_id=eq.8&is_base=eq.false&artifacts_deleted_at=is.null",
        {"expires_at": None},
    )
    client.delete_storage_object("cv-artifacts", "user-1/tailored/8/failed-attempt.pdf")
    assert supabase_data_revision() == revision
    assert supabase_card_revision() > card_revision
    client.upload_storage_object("cv-artifacts", "user-1/base/main.tex", b"dummy", content_type="application/x-tex")
    assert supabase_data_revision() == revision + 1
    client.json_request("POST", "/rest/v1/cv_versions", {"is_base": True})
    assert supabase_data_revision() == revision + 2
    client.json_request("PATCH", "/rest/v1/cv_versions?id=eq.2", {"is_active": True})
    assert supabase_data_revision() == revision + 3


def test_only_scoped_tailored_expiration_clear_is_card_local(monkeypatch):
    class Response:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False
        def read(self):
            return b"[]"

    monkeypatch.setattr("matching.candidate_profile_persistence.urlopen", lambda *_args, **_kwargs: Response())
    client = SupabaseRestClient("https://offline.test", "dummy")
    revision = supabase_data_revision()
    card_revision = supabase_card_revision()
    client.json_request(
        "PATCH",
        "/rest/v1/cv_versions?user_id=eq.user-1&job_id=eq.8&is_base=eq.false&artifacts_deleted_at=is.null",
        {"expires_at": None},
    )
    assert supabase_data_revision() == revision
    assert supabase_card_revision() == card_revision + 1

    client.json_request("PATCH", "/rest/v1/cv_versions?id=eq.2", {"expires_at": None})
    assert supabase_data_revision() == revision + 1


class FakeProfileClient:
    def __init__(self, rows=None, *, fail_activation=False):
        self.rows = [dict(row) for row in (rows or [])]
        self.fail_activation = fail_activation
        self.next_id = max((row["id"] for row in self.rows), default=0) + 1

    def list_profiles(self, user_id, cv_version_id):
        return [
            row for row in self.rows
            if row["user_id"] == user_id and row["cv_version_id"] == cv_version_id
        ]

    def insert_profile(self, payload):
        row = {"id": self.next_id, **payload}
        self.next_id += 1
        self.rows.append(row)
        return row

    def set_active(self, profile_id, active, *, user_id=None):
        if active and self.fail_activation and profile_id != 1:
            raise PersistenceError("simulated activation failure")
        row = next(row for row in self.rows if row["id"] == profile_id)
        row["is_active"] = active


def _profile():
    return representative_profile().model_copy(update={"schema_version": "2.0", "source_cv_version_id": 7})


def _payload(profile, profile_id=1, active=True, input_sha256="a" * 64):
    return {
        "id": profile_id,
        "user_id": "user-1",
        "cv_version_id": 7,
        "schema_version": profile.schema_version,
        "parser_version": PARSER_VERSION,
        "model": "gpt-6-luna",
        "input_sha256": input_sha256,
        "profile_json": json.loads(canonical_profile_json(profile)),
        "is_active": active,
    }


def test_storage_hash_is_exact_byte_hash():
    assert sha256_bytes(b"cv bytes") == "80d2aa97d0526e5486506801885cc182c4efb7b06504ec02557ff5fa6617dd99"


def test_replay_serializes_generalized_profile_without_legacy_field():
    profile = replay_saved_extraction(
        json.loads(json.dumps(extracted_from_profile(_profile()).model_dump(mode="json"))),
        cv_version_id=7,
        latex_text="",
    )
    serialized = json.loads(canonical_profile_json(profile))
    assert serialized["schema_version"] == "2.0"
    assert serialized["source_cv_version_id"] == 7
    assert "total_security_experience_years" not in serialized
    assert "production_experience" not in serialized
    assert all("evidence_level" in capability for capability in serialized["capabilities"])


def test_persistence_is_idempotent_for_identical_generation():
    profile = _profile()
    client = FakeProfileClient([_payload(profile)])
    profile_id, created = persist_profile(
        client, profile, user_id="user-1", cv_version_id=7,
        input_sha256="a" * 64, model="gpt-6-luna",
    )
    assert (profile_id, created) == (1, False)
    assert len(client.rows) == 1


def test_new_generation_switches_active_profile():
    old = _profile()
    new = old.model_copy(update={"summary": "new generation"})
    client = FakeProfileClient([_payload(old)])
    profile_id, created = persist_profile(
        client, new, user_id="user-1", cv_version_id=7,
        input_sha256="b" * 64, model="gpt-6-luna",
    )
    assert created is True
    assert profile_id == 2
    assert [row["is_active"] for row in client.rows] == [False, True]


def test_failed_activation_restores_previous_active_profile():
    old = _profile()
    client = FakeProfileClient([_payload(old)], fail_activation=True)
    with pytest.raises(PersistenceError, match="activation failure"):
        persist_profile(
            client, old.model_copy(update={"summary": "new generation"}),
            user_id="user-1", cv_version_id=7,
            input_sha256="b" * 64, model="gpt-6-luna",
        )
    assert client.rows[0]["is_active"] is True
    assert len(client.rows) == 2
