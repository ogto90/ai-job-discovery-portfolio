"""User-scoped job metadata overrides, kept separate from shared source data."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlencode

from .candidate_profile_persistence import PersistenceError, SupabaseRestClient
from .job_metadata import (
    MANUAL_FALLBACK_COMPANIES,
    MANUAL_FALLBACK_TITLES,
    company_metadata_issues,
    manual_metadata_issues,
    metadata_issues,
    normalize_metadata,
    title_metadata_issues,
)


MetadataField = Literal["company", "title"]
_FIELD_COLUMNS: dict[MetadataField, str] = {
    "company": "company_override",
    "title": "title_override",
}
_MAX_LENGTH: dict[MetadataField, int] = {"company": 140, "title": 180}
_PAGE_SIZE = 1000


@dataclass(frozen=True)
class EffectiveJobMetadata:
    source_company: str
    source_title: str
    company: str
    title: str
    company_overridden: bool
    title_overridden: bool


def validate_metadata_override(field: MetadataField, value: str) -> str:
    """Trim and validate a single-line user-provided company/title value."""

    if field not in _FIELD_COLUMNS:
        raise ValueError("Choose a valid metadata field.")
    if not isinstance(value, str):
        raise ValueError("Enter a value for this field.")
    result = value.strip()
    if not result:
        raise ValueError("Company and title cannot be blank.")
    if "\n" in result or "\r" in result:
        raise ValueError("Company and title must fit on one line.")
    if len(result) > _MAX_LENGTH[field]:
        raise ValueError(f"Keep {field} to {_MAX_LENGTH[field]} characters or fewer.")
    return result


def resolve_effective_job_metadata(
    source_company: Any,
    source_title: Any,
    override: dict[str, Any] | None = None,
) -> EffectiveJobMetadata:
    """Resolve display values while retaining the original source values."""

    row = override or {}
    raw_company = source_company if isinstance(source_company, str) else ""
    raw_title = source_title if isinstance(source_title, str) else ""
    company_override = row.get("company_override")
    title_override = row.get("title_override")
    company_overridden = isinstance(company_override, str) and bool(company_override.strip())
    title_overridden = isinstance(title_override, str) and bool(title_override.strip())
    company = company_override.strip() if company_overridden else (raw_company or "Unknown company")
    title = title_override.strip() if title_overridden else (raw_title or "Untitled role")
    return EffectiveJobMetadata(
        source_company=raw_company,
        source_title=raw_title,
        company=company,
        title=title,
        company_overridden=company_overridden,
        title_overridden=title_overridden,
    )


def effective_metadata_issues(
    metadata: EffectiveJobMetadata, *, is_manual: bool
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Return (effective issues, source issues), trusting explicitly edited fields."""

    source_company = metadata.source_company or "Unknown company"
    source_title = metadata.source_title or "Untitled role"
    source_issues = (
        manual_metadata_issues(source_company, source_title)
        if is_manual
        else metadata_issues(source_company, source_title)
    )

    effective: list[str] = []
    if not metadata.company_overridden:
        if is_manual and normalize_metadata(metadata.company) in MANUAL_FALLBACK_COMPANIES:
            pass
        else:
            effective.extend(company_metadata_issues(metadata.company))
    if not metadata.title_overridden:
        if is_manual and normalize_metadata(metadata.title) in MANUAL_FALLBACK_TITLES:
            pass
        else:
            effective.extend(title_metadata_issues(metadata.title))
    if normalize_metadata(metadata.company) == normalize_metadata(metadata.title):
        effective.append("company_and_title_identical")
    return tuple(dict.fromkeys(effective)), tuple(source_issues)


def load_job_metadata_overrides(
    client: SupabaseRestClient, *, user_id: str, job_ids: set[int] | None = None
) -> dict[int, dict[str, Any]]:
    """Load a user's overrides in bounded pages, not one query per card."""

    if job_ids is not None and not job_ids:
        return {}
    result: dict[int, dict[str, Any]] = {}
    offset = 0
    while True:
        filters = {
            "select": "user_id,job_id,company_override,title_override,created_at,updated_at",
            "user_id": f"eq.{user_id}",
            "order": "job_id.asc",
            "limit": str(_PAGE_SIZE),
            "offset": str(offset),
        }
        if job_ids is not None:
            filters["job_id"] = "in.(" + ",".join(str(value) for value in sorted(job_ids)) + ")"
        params = urlencode(filters)
        rows = client.get_json(f"/rest/v1/job_metadata_overrides?{params}")
        if not isinstance(rows, list):
            raise PersistenceError("Supabase returned invalid job metadata overrides.")
        for row in rows:
            if str(row.get("user_id")) != user_id:
                raise PersistenceError("A job metadata override has mismatched ownership.")
            result[int(row["job_id"])] = row
        if len(rows) < _PAGE_SIZE:
            return result
        offset += len(rows)


def _get_one(
    client: SupabaseRestClient, *, user_id: str, job_id: int
) -> dict[str, Any] | None:
    params = urlencode({
        "select": "user_id,job_id,company_override,title_override",
        "user_id": f"eq.{user_id}",
        "job_id": f"eq.{job_id}",
        "limit": "2",
    })
    rows = client.get_json(f"/rest/v1/job_metadata_overrides?{params}")
    if not isinstance(rows, list) or len(rows) > 1:
        raise PersistenceError("The user-scoped metadata override could not be resolved.")
    if not rows:
        return None
    if str(rows[0].get("user_id")) != user_id or int(rows[0].get("job_id", 0)) != job_id:
        raise PersistenceError("The metadata override does not belong to this user and job.")
    return rows[0]


def get_job_metadata_override(
    client: SupabaseRestClient, *, user_id: str, job_id: int
) -> dict[str, Any] | None:
    """Load one override without exposing another user's row."""

    return _get_one(client, user_id=user_id, job_id=job_id)


def save_job_metadata_override(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_id: int,
    field: MetadataField,
    value: str,
    current_value: str,
) -> bool:
    """Save only one override column; return False when the value is unchanged."""

    normalized = validate_metadata_override(field, value)
    if normalized == current_value:
        return False
    column = _FIELD_COLUMNS[field]
    params = urlencode({"user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}"})
    existing = _get_one(client, user_id=user_id, job_id=job_id)
    if existing:
        if existing.get(column) == normalized:
            return False
        saved = client.json_request(
            "PATCH", f"/rest/v1/job_metadata_overrides?{params}",
            {column: normalized}, prefer="return=representation",
        )
        if not isinstance(saved, list) or len(saved) != 1:
            raise PersistenceError("The metadata override was not saved.")
        return True

    try:
        saved = client.json_request(
            "POST", "/rest/v1/job_metadata_overrides",
            {"user_id": user_id, "job_id": job_id, column: normalized},
            prefer="return=representation",
        )
    except PersistenceError:
        # If a concurrent insert won, update only the requested field.
        raced = _get_one(client, user_id=user_id, job_id=job_id)
        if not raced:
            raise
        saved = client.json_request(
            "PATCH", f"/rest/v1/job_metadata_overrides?{params}",
            {column: normalized}, prefer="return=representation",
        )
    if not isinstance(saved, list) or len(saved) != 1:
        raise PersistenceError("The metadata override was not saved.")
    return True


def reset_job_metadata_override(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_id: int,
    field: MetadataField,
) -> bool:
    """Clear one override, deleting the row only when both fields are empty."""

    if field not in _FIELD_COLUMNS:
        raise ValueError("Choose a valid metadata field.")
    column = _FIELD_COLUMNS[field]
    existing = _get_one(client, user_id=user_id, job_id=job_id)
    if not existing or existing.get(column) is None:
        return False
    other_column = _FIELD_COLUMNS["title" if field == "company" else "company"]
    params = urlencode({"user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}"})
    if existing.get(other_column) is None:
        deleted = client.json_request(
            "DELETE", f"/rest/v1/job_metadata_overrides?{params}",
            prefer="return=representation",
        )
        if not isinstance(deleted, list) or len(deleted) != 1:
            raise PersistenceError("The empty metadata override could not be removed.")
        return True
    updated = client.json_request(
        "PATCH", f"/rest/v1/job_metadata_overrides?{params}",
        {column: None}, prefer="return=representation",
    )
    if not isinstance(updated, list) or len(updated) != 1:
        raise PersistenceError("The metadata override could not be reset.")
    return True
