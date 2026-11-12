import pytest
from pydantic import ValidationError

from matching.holistic_match_persistence import FitCacheRecord, persist_fit


PAYLOAD = {
    "user_id": "user-1",
    "job_id": 8,
    "candidate_profile_id": 7,
    "evaluation_fingerprint": "a" * 64,
    "jd_sha256": "b" * 64,
    "job_snapshot": {"title": "Security Engineer"},
    "fit_score": 78,
    "strengths": ["Strong AppSec experience"],
    "gaps": ["Limited AWS production evidence"],
    "matcher_version": "holistic_fit_v1",
    "model": "gpt-6-luna",
}


class FakeClient:
    def __init__(self):
        self.rows = []

    def get_json(self, path):
        if path.startswith("/rest/v1/job_match_assessments?"):
            return [row for row in self.rows if row["user_id"] == "user-1" and row["evaluation_fingerprint"] == "a" * 64]
        raise AssertionError(path)

    def json_request(self, method, path, payload, *, prefer=None):
        if method == "POST":
            assert path == "/rest/v1/job_match_assessments"
            row = {"id": len(self.rows) + 1, **payload}
            self.rows.append(row)
            return [row]
        if method == "PATCH":
            row = self.rows[0]
            row.update(payload)
            return [row]
        raise AssertionError((method, path))


def test_identical_assessment_is_reused_without_duplicate_insert():
    client = FakeClient()
    first, created = persist_fit(client, PAYLOAD)
    second, reused_created = persist_fit(client, PAYLOAD)
    assert created is True
    assert reused_created is False
    assert first["id"] == second["id"]
    assert len(client.rows) == 1


def test_fit_cache_payload_rejects_legacy_fields_and_invalid_scores():
    with pytest.raises(ValidationError):
        FitCacheRecord.model_validate({**PAYLOAD, "recommendation": "Apply"})
    with pytest.raises(ValidationError):
        FitCacheRecord.model_validate({**PAYLOAD, "fit_score": 101})


def test_score_only_cache_row_can_be_enriched_without_creating_a_duplicate():
    client = FakeClient()
    first, created = persist_fit(client, {**PAYLOAD, "strengths": [], "gaps": []})
    assert created is True
    updated, reused = persist_fit(client, PAYLOAD)
    assert reused is False
    assert updated["id"] == first["id"]
    assert updated["strengths"] == PAYLOAD["strengths"]
    assert updated["gaps"] == PAYLOAD["gaps"]
    assert len(client.rows) == 1
