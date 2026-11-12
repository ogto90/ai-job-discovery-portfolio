"""Idempotent persistence helpers for holistic match assessments.

This module performs only cache lookup and persistence. It does not call an AI
model and deliberately does not store the derived match level.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from pydantic import BaseModel, ConfigDict, Field

from .candidate_profile_persistence import PersistenceError, SupabaseRestClient


class FitCacheRecord(BaseModel):
    """Fit score cache payload with concise optional explanation bullets."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    user_id: str = Field(min_length=1)
    job_id: int = Field(gt=0)
    candidate_profile_id: int = Field(gt=0)
    evaluation_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    jd_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    job_snapshot: dict[str, Any]
    fit_score: int = Field(ge=0, le=100)
    strengths: list[str] = Field(default_factory=list, max_length=4)
    gaps: list[str] = Field(default_factory=list, max_length=4)
    matcher_version: str = Field(min_length=1)
    model: str = Field(min_length=1)


def get_by_fingerprint(
    client: SupabaseRestClient, *, user_id: str, evaluation_fingerprint: str
) -> dict[str, Any] | None:
    """Return the score cache row for a user/fingerprint, if present."""

    query = urlencode(
        {
            "select": "*",
            "user_id": f"eq.{user_id}",
            "evaluation_fingerprint": f"eq.{evaluation_fingerprint}",
            "limit": "1",
        }
    )
    rows = client.get_json(f"/rest/v1/job_match_assessments?{query}")
    if not isinstance(rows, list):
        raise PersistenceError("Supabase returned invalid Fit cache data.")
    if len(rows) > 1:
        raise PersistenceError("Fit cache returned duplicate rows.")
    return rows[0] if rows else None


def persist_fit(
    client: SupabaseRestClient, payload: FitCacheRecord | dict[str, Any]
) -> tuple[dict[str, Any], bool]:
    """Validate, look up before insert, and return ``(row, created)``."""

    record = payload if isinstance(payload, FitCacheRecord) else FitCacheRecord.model_validate(payload)
    data = record.model_dump(mode="json")
    existing = get_by_fingerprint(
        client,
        user_id=record.user_id,
        evaluation_fingerprint=record.evaluation_fingerprint,
    )
    if existing is not None:
        existing_strengths = existing.get("strengths") or []
        existing_gaps = existing.get("gaps") or []
        if (not existing_strengths or not existing_gaps) and (record.strengths or record.gaps):
            rows = client.json_request(
                "PATCH",
                f"/rest/v1/job_match_assessments?id=eq.{existing['id']}",
                {"strengths": record.strengths, "gaps": record.gaps},
                prefer="return=representation",
            )
            if not isinstance(rows, list) or len(rows) != 1:
                raise PersistenceError("Expected one updated Fit cache row.")
            return rows[0], False
        return existing, False

    rows = client.json_request(
        "POST",
        "/rest/v1/job_match_assessments",
        data,
        prefer="return=representation",
    )
    if not isinstance(rows, list) or len(rows) != 1:
        raise PersistenceError("Expected one inserted Fit cache row.")
    return rows[0], True
