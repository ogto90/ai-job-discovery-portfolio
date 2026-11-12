from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest

from matching.candidate_profile_persistence import PersistenceError
from matching.interview_preparation import (
    create_interview_preparation,
    get_interview_preparation,
    list_interview_preparations_for_application,
    resolve_application_context,
    resolve_submitted_cv,
    update_interview_preparation,
)


USER = str(uuid4())
OTHER = str(uuid4())


class FakeClient:
    def __init__(self):
        self.tables = {
            "applications": [{"id": 10, "user_id": USER, "job_id": 20, "cv_version_id": 30,
                              "submitted_cv_version_id": None, "status": "applied", "applied_at": None}],
            "jobs": [{"id": 20, "company": "Nebius", "title": "Security Solutions Engineer",
                      "description": "Original JD", "description_kind": "full", "updated_at": None}],
            "job_metadata_overrides": [],
            "cv_versions": [
                {"id": 30, "user_id": USER, "job_id": None, "label": "Base A", "created_at": "2026-01-01T00:00:00Z",
                 "is_base": True, "is_active": True, "storage_bucket": "private", "file_path": "base.tex", "artifacts_deleted_at": None},
                {"id": 31, "user_id": USER, "job_id": 20, "label": "Tailored A", "created_at": "2026-02-01T00:00:00Z",
                 "is_base": False, "is_active": False, "storage_bucket": "private", "file_path": "tailored.pdf", "artifacts_deleted_at": None},
            ],
            "candidate_profiles": [{"id": 40, "user_id": USER, "cv_version_id": 30,
                                    "created_at": "2026-01-01T00:00:00Z", "profile_json": {"role": "Engineer"}}],
            "job_match_assessments": [{"id": 50, "user_id": USER, "job_id": 20, "candidate_profile_id": 40,
                                       "fit_score": 75, "created_at": "2026-02-01T00:00:00Z"}],
            "interview_preparations": [],
            "interview_preparation_packs": [],
        }
        self.blobs = {"base.tex": b"Base CV", "tailored.pdf": b"Submitted tailored CV"}
        self.writes = []
        self.fail_upload = False
        self.fail_create = False
        self.fail_idempotency_lookup = False
        self.create_failed = False
        self.uploaded_paths = []
        self.deleted_paths = []

    def get_json(self, path):
        parsed = urlsplit(path)
        table = parsed.path.rsplit("/", 1)[-1]
        if (table == "interview_preparations" and self.create_failed
                and self.fail_idempotency_lookup):
            raise PersistenceError("outcome lookup unavailable")
        assert table in self.tables, path
        params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
        rows = deepcopy(self.tables[table])
        for key, value in params.items():
            if key in {"select", "order", "limit", "or"}:
                continue
            if value.startswith("eq."):
                rows = [row for row in rows if str(row.get(key)) == value[3:]]
            elif value == "is.null":
                rows = [row for row in rows if row.get(key) is None]
        if "or" in params and table == "cv_versions":
            rows = [row for row in rows if row.get("job_id") == 20 or row["id"] == 30]
        order = params.get("order", "")
        if order.startswith("created_at.desc"):
            rows.sort(key=lambda row: (row.get("created_at", ""), str(row.get("id", ""))), reverse=True)
        if "limit" in params:
            rows = rows[:int(params["limit"])]
        return rows

    def json_request(self, method, path, payload=None, *, prefer=None):
        self.writes.append((method, path, deepcopy(payload)))
        table = urlsplit(path).path.rsplit("/", 1)[-1]
        if table == "applications" and method == "PATCH":
            rows = self.get_json(path)
            for row in self.tables[table]:
                if any(item["id"] == row["id"] for item in rows):
                    row.update(payload)
            return [{**row, **payload} for row in rows]
        if table == "interview_preparations" and method == "POST":
            if self.fail_create:
                self.create_failed = True
                raise PersistenceError("database unavailable")
            if any(row["idempotency_key"] == payload["idempotency_key"] for row in self.tables[table]):
                raise PersistenceError("duplicate key")
            row = {"id": str(uuid4()), **deepcopy(payload), "created_at": datetime.now(timezone.utc).isoformat()}
            self.tables[table].append(row)
            return [deepcopy(row)]
        if table == "interview_preparations" and method == "PATCH":
            rows = self.get_json(path)
            for row in self.tables[table]:
                if any(item["id"] == row["id"] for item in rows):
                    row.update(payload)
            return [{**row, **payload} for row in rows]
        raise AssertionError((method, path))

    def download_storage_object(self, _bucket, path):
        if path not in self.blobs:
            raise PersistenceError("unavailable")
        return self.blobs[path]

    def upload_storage_object(self, _bucket, path, data, *, content_type):
        self.blobs[path] = data
        self.uploaded_paths.append(path)
        if self.fail_upload:
            raise PersistenceError("upload response lost")

    def delete_storage_object(self, _bucket, path):
        self.deleted_paths.append(path)
        self.blobs.pop(path, None)


def create(client, **overrides):
    args = {"user_id": USER, "application_id": 10, "idempotency_key": str(uuid4()),
            "interview_type": "technical", "selected_cv_version_id": 31, "cv_confirmed": True}
    args.update(overrides)
    return create_interview_preparation(client, **args)


def test_create_reopen_update_and_second_round_preserve_sources():
    client = FakeClient()
    first_key = str(uuid4())
    first = create(client, idempotency_key=first_key)
    assert first["job_id"] == 20
    assert first["submitted_cv_version_id"] == 31
    assert first["source_context"]["schema_version"] == 1
    assert first["source_context"]["cv"]["sha256"]
    assert first["candidate_profile_id"] == 40
    assert first["fit_assessment_id"] == 50
    assert client.tables["applications"][0]["submitted_cv_version_id"] == 31
    assert client.tables["applications"][0]["status"] == "applied"
    assert create(client, idempotency_key=first_key)["id"] == first["id"]
    assert len(client.tables["interview_preparations"]) == 1
    updated = update_interview_preparation(
        client, user_id=USER, preparation_id=first["id"], interview_type="technical",
        interview_datetime=datetime(2026, 11, 1, 10, tzinfo=timezone.utc), interview_notes="Discuss architecture",
    )
    assert updated["interview_notes"] == "Discuss architecture"
    assert get_interview_preparation(client, user_id=USER, preparation_id=first["id"])["interview_datetime"]
    second = create(client, interview_type="hiring_manager", selected_cv_version_id=None, cv_confirmed=False)
    assert second["id"] != first["id"]
    assert second["submitted_cv_version_id"] == first["submitted_cv_version_id"] == 31
    assert second["source_context"]["cv"]["id"] == first["source_context"]["cv"]["id"]
    assert second["source_context"]["cv"]["snapshot_path"] != first["source_context"]["cv"]["snapshot_path"]
    assert client.blobs[second["source_context"]["cv"]["snapshot_path"]] == b"Submitted tailored CV"
    assert len(list_interview_preparations_for_application(client, user_id=USER, application_id=10)) == 2
    client.tables["jobs"][0]["description"] = "Changed JD"
    client.tables["cv_versions"][0]["is_active"] = False
    client.tables["cv_versions"].append({"id": 32, "user_id": USER, "job_id": None, "is_active": True})
    reopened = get_interview_preparation(client, user_id=USER, preparation_id=first["id"])
    assert reopened["source_context"]["description"] == "Original JD"
    assert reopened["source_context"]["cv"]["id"] == 31
    assert client.blobs[reopened["source_context"]["cv"]["snapshot_path"]] == b"Submitted tailored CV"


def test_failed_storage_upload_does_not_create_preparation_and_cleans_partial_object():
    client = FakeClient()
    client.fail_upload = True
    with pytest.raises(PersistenceError, match="upload response lost"):
        create(client)
    assert not client.tables["interview_preparations"]
    assert client.tables["applications"][0]["submitted_cv_version_id"] is None
    assert client.uploaded_paths == client.deleted_paths
    assert all(path not in client.blobs for path in client.uploaded_paths)


def test_failed_database_insert_cleans_uploaded_snapshot_when_absence_is_confirmed():
    client = FakeClient()
    client.fail_create = True
    with pytest.raises(PersistenceError, match="database unavailable"):
        create(client)
    assert not client.tables["interview_preparations"]
    assert client.uploaded_paths == client.deleted_paths
    assert all(path not in client.blobs for path in client.uploaded_paths)


def test_uncertain_database_outcome_retains_snapshot_for_safe_retry():
    client = FakeClient()
    client.fail_create = True
    client.fail_idempotency_lookup = True
    with pytest.raises(PersistenceError, match="retained for a safe retry"):
        create(client)
    assert not client.tables["interview_preparations"]
    assert client.uploaded_paths
    assert not client.deleted_paths
    assert client.uploaded_paths[0] in client.blobs


def test_unknown_cv_requires_explicit_confirmation_and_never_defaults_to_base():
    client = FakeClient()
    context = resolve_application_context(client, user_id=USER, application_id=10)
    assert context["submitted_cv"] is None
    assert resolve_submitted_cv(context, None, confirmed=False) is None
    with pytest.raises(ValueError, match="Confirm"):
        create(client, cv_confirmed=False)
    assert not client.tables["interview_preparations"]
    draft = create(client, selected_cv_version_id=None, cv_confirmed=False)
    assert draft["submitted_cv_version_id"] is None
    assert draft["status"] == "draft"
    assert client.tables["applications"][0]["submitted_cv_version_id"] is None


def test_missing_optional_sources_and_deleted_artifact_allow_draft():
    client = FakeClient()
    client.tables["candidate_profiles"].clear()
    client.tables["job_match_assessments"].clear()
    client.tables["jobs"][0]["description"] = None
    client.tables["cv_versions"][1]["artifacts_deleted_at"] = "2026-10-01T00:00:00Z"
    row = create(client)
    assert row["status"] == "draft"
    assert row["source_context"]["cv"]["artifact_status"] == "unavailable"
    assert row["candidate_profile_id"] is None
    assert row["fit_assessment_id"] is None


@pytest.mark.parametrize("changes", [
    {"application_id": 999},
    {"user_id": OTHER},
    {"interview_type": "arbitrary"},
    {"selected_cv_version_id": 999},
    {"interview_datetime": datetime(2026, 11, 1)},
])
def test_invalid_or_unauthorized_create_rejected(changes):
    with pytest.raises(ValueError):
        create(FakeClient(), **changes)


def test_cross_user_reads_rejected_and_update_is_metadata_only():
    client = FakeClient()
    row = create(client)
    with pytest.raises(ValueError):
        get_interview_preparation(client, user_id=OTHER, preparation_id=row["id"])
    with pytest.raises(ValueError):
        update_interview_preparation(client, user_id=USER, preparation_id="invalid", interview_type="technical")
    update_interview_preparation(client, user_id=USER, preparation_id=row["id"], interview_type="behavioral")
    patch = client.writes[-1]
    assert patch[0] == "PATCH"
    assert set(patch[2]) == {"interview_type", "interview_datetime", "interviewer_name", "interviewer_role", "interview_notes"}
    assert "source_context" not in patch[2]


def test_untrusted_input_is_data_not_query_or_html():
    client = FakeClient()
    value = "'); drop table applications; -- <script>"
    row = create(client, interviewer_name=value)
    assert row["interviewer_name"] == value
    assert client.tables["applications"][0]["status"] == "applied"


def test_user_corrected_company_and_title_are_frozen_with_source_provenance():
    client = FakeClient()
    client.tables["job_metadata_overrides"].append({
        "user_id": USER, "job_id": 20,
        "company_override": "Nebius Cloud", "title_override": "Senior Security Solutions Engineer",
    })
    row = create(client)
    source = row["source_context"]
    assert (source["company"], source["title"]) == ("Nebius Cloud", "Senior Security Solutions Engineer")
    assert (source["source_company"], source["source_title"]) == ("Nebius", "Security Solutions Engineer")
