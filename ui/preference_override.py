"""Per-user, per-listing preference exceptions."""

from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import urlencode
from typing import Iterable

from matching.candidate_profile_persistence import PersistenceError, SupabaseRestClient


PREFERENCE_FIELDS = frozenset({"role", "location", "employment_type", "seniority"})


def load_preference_overrides(
    client: SupabaseRestClient, *, user_id: str, job_ids: Iterable[int]
) -> list[dict]:
    ids = sorted({int(value) for value in job_ids})
    if not ids:
        return []
    rows: list[dict] = []
    for start in range(0, len(ids), 50):
        batch = ids[start : start + 50]
        params = urlencode({
            "select": "job_id,overridden_preferences,is_active,accepted_at,updated_at",
            "user_id": f"eq.{user_id}", "is_active": "eq.true",
            "job_id": "in.(" + ",".join(map(str, batch)) + ")",
        })
        result = client.get_json(f"/rest/v1/user_job_preference_overrides?{params}")
        if not isinstance(result, list):
            raise PersistenceError("Supabase returned invalid per-listing preference overrides.")
        rows.extend(result)
    return rows


def save_preference_override(
    client: SupabaseRestClient, *, user_id: str, job_id: int, fields: Iterable[str]
) -> None:
    selected = sorted(set(fields) & PREFERENCE_FIELDS)
    if not selected:
        raise ValueError("Select at least one listing decision to accept.")
    now = datetime.now(timezone.utc).isoformat()
    client.json_request(
        "POST", "/rest/v1/user_job_preference_overrides?on_conflict=user_id,job_id",
        {"user_id": user_id, "job_id": int(job_id), "overridden_preferences": selected,
         "is_active": True, "accepted_at": now, "updated_at": now},
        prefer="resolution=merge-duplicates,return=minimal",
    )


def remove_preference_override(
    client: SupabaseRestClient, *, user_id: str, job_id: int
) -> None:
    params = urlencode({"user_id": f"eq.{user_id}", "job_id": f"eq.{int(job_id)}"})
    client.json_request(
        "PATCH", f"/rest/v1/user_job_preference_overrides?{params}",
        {"is_active": False, "updated_at": datetime.now(timezone.utc).isoformat()},
        prefer="return=minimal",
    )
