"""Deterministic retention and cleanup for tailored CV Storage artifacts."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

from .candidate_profile_persistence import PersistenceError, SupabaseRestClient
from .artifact_lifecycle_lock import artifact_lifecycle_lock


TAILORED_RETENTION = timedelta(days=40)
ACTIVE_APPLICATION_STATUSES = frozenset({"applied", "interview", "offer", "hired"})
TERMINAL_APPLICATION_STATUSES = frozenset({"rejected", "no_response", "withdrawn"})


def _as_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def calculate_expiration(
    *,
    created_at: datetime,
    application_status: str | None = None,
    terminal_at: datetime | None = None,
    application_updated_at: datetime | None = None,
) -> datetime | None:
    """Return the artifact deadline; ``None`` means retained while active."""

    status = (application_status or "").casefold()
    if status in ACTIVE_APPLICATION_STATUSES:
        return None
    if status in TERMINAL_APPLICATION_STATUSES:
        terminal = terminal_at or application_updated_at or created_at
        return terminal + TAILORED_RETENTION
    return created_at + TAILORED_RETENTION


def artifacts_available(row: dict[str, Any], *, now: datetime | None = None) -> bool:
    """Whether a tailored row still points to live, usable artifacts."""

    if row.get("is_base") is True or row.get("artifacts_deleted_at"):
        return False
    if not (row.get("tex_file_path") and (row.get("pdf_file_path") or row.get("file_path"))):
        return False
    deadline = _as_datetime(row.get("expires_at"))
    return deadline is None or deadline > (now or datetime.now(timezone.utc))


@dataclass
class CleanupResult:
    inspected: int = 0
    expired: int = 0
    deleted: int = 0
    retained: int = 0
    failures: list[str] = field(default_factory=list)


def _rows(client: SupabaseRestClient, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    rows = client.get_json(f"/rest/v1/{table}?{urlencode(params)}")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise PersistenceError(f"Supabase returned invalid {table} data.")
    return rows


def _candidate_rows(client: SupabaseRestClient, user_id: str | None):
    last_id = 0
    while True:
        page = _rows(client, "cv_versions", {
            "select": "id,user_id", "is_base": "eq.false", "id": f"gt.{last_id}",
            "order": "id.asc", "limit": "500",
            **({"user_id": f"eq.{user_id}"} if user_id else {}),
        })
        if not page:
            return
        for row in page:
            next_id = int(row["id"])
            if next_id <= last_id:
                raise PersistenceError("Cleanup received unordered CV versions.")
            last_id = next_id
            yield row


def _delete_object_retry_safe(client: SupabaseRestClient, bucket: str, path: str | None) -> None:
    if not path:
        return
    try:
        client.delete_storage_object(bucket, path)
    except PersistenceError as exc:
        # A missing object is already in the desired state. Other failures stay
        # visible and leave the DB row retryable.
        if "http 404" not in str(exc).casefold() and "not found" not in str(exc).casefold():
            raise


def run_tailored_cv_cleanup(
    client: SupabaseRestClient,
    *,
    now: datetime | None = None,
    user_id: str | None = None,
) -> CleanupResult:
    """Expire due tailored artifacts; safe to rerun after partial failures."""

    current = now or datetime.now(timezone.utc)
    result = CleanupResult()
    for candidate in _candidate_rows(client, user_id):
        result.inspected += 1
        try:
            with artifact_lifecycle_lock(client.base_url, cleanup=True):
                _cleanup_one(client, candidate, current, result)
        except Exception as exc:
            result.failures.append(f"cv_version {candidate.get('id')}: {exc}")
    return result


def run_archived_cv_cleanup_for_job(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_id: int,
    now: datetime | None = None,
) -> CleanupResult:
    """Immediately remove tailored artifacts for an archived, unapplied job."""

    current = now or datetime.now(timezone.utc)
    result = CleanupResult()
    candidates = _rows(client, "cv_versions", {
        "select": "id,user_id", "user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}",
        "is_base": "eq.false", "order": "id.asc", "limit": "500",
    })
    for candidate in candidates:
        result.inspected += 1
        try:
            with artifact_lifecycle_lock(client.base_url, cleanup=True):
                _cleanup_one(client, candidate, current, result, require_archived=True)
        except Exception as exc:
            result.failures.append(f"cv_version {candidate.get('id')}: {exc}")
    return result


def run_archived_tailored_cv_cleanup(
    client: SupabaseRestClient,
    *,
    now: datetime | None = None,
    user_id: str | None = None,
) -> CleanupResult:
    """Clean archived listings only, without sweeping ordinary expired CVs."""

    result = CleanupResult()
    offset = 0
    while True:
        params = {
            "select": "user_id,job_id", "status": "eq.archived",
            "order": "user_id.asc,job_id.asc", "limit": "500", "offset": str(offset),
        }
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        page = _rows(client, "job_reviews", params)
        if not page:
            break
        for row in page:
            outcome = run_archived_cv_cleanup_for_job(
                client,
                user_id=str(row["user_id"]),
                job_id=int(row["job_id"]),
                now=now,
            )
            result.inspected += outcome.inspected
            result.expired += outcome.expired
            result.deleted += outcome.deleted
            result.retained += outcome.retained
            result.failures.extend(outcome.failures)
        offset += len(page)
    return result


def _cleanup_one(client, candidate, current, result, *, require_archived: bool = False):
    # Both reads happen inside the lock, not against the earlier enumeration.
    rows = _rows(client, "cv_versions", {
        "select": "id,user_id,job_id,is_base,storage_bucket,created_at,expires_at,artifacts_deleted_at,tex_file_path,pdf_file_path,file_path",
        "id": f"eq.{candidate['id']}", "user_id": f"eq.{candidate['user_id']}", "limit": "2",
    })
    if len(rows) != 1:
        raise PersistenceError("Cleanup could not confirm the CV version.")
    row = rows[0]
    if row.get("id") != candidate["id"] or row.get("user_id") != candidate["user_id"]:
        raise PersistenceError("Cleanup CV ownership mismatch.")
    if row.get("is_base") is not False or row.get("artifacts_deleted_at"):
        result.retained += 1
        return
    job_id = int(row["job_id"])
    apps = _rows(client, "applications", {
        "select": "user_id,job_id,status,terminal_at,updated_at",
        "user_id": f"eq.{row['user_id']}", "job_id": f"eq.{job_id}", "limit": "2",
    })
    if len(apps) > 1 or any(app.get("user_id") != row["user_id"] or app.get("job_id") != job_id for app in apps):
        raise PersistenceError("Cleanup could not confirm the unique application.")
    application = apps[0] if apps else {}
    status = application.get("status")
    if apps and status not in ACTIVE_APPLICATION_STATUSES | TERMINAL_APPLICATION_STATUSES | {"draft"}:
        raise PersistenceError("Unknown application state; artifacts retained.")
    created = _as_datetime(row.get("created_at"))
    if created is None:
        raise PersistenceError("Invalid CV creation time; artifacts retained.")
    terminal = _as_datetime(application.get("terminal_at"))
    updated_at = _as_datetime(application.get("updated_at"))
    if status in TERMINAL_APPLICATION_STATUSES and terminal is None and updated_at is None:
        raise PersistenceError("Unknown terminal timestamp; artifacts retained.")
    reviews = _rows(client, "job_reviews", {
        "select": "user_id,job_id,status",
        "user_id": f"eq.{row['user_id']}", "job_id": f"eq.{job_id}", "limit": "2",
    })
    if len(reviews) > 1 or any(review.get("user_id") != row["user_id"] or review.get("job_id") != job_id for review in reviews):
        raise PersistenceError("Cleanup could not confirm the unique job review.")
    archived = bool(reviews and reviews[0].get("status") == "archived")
    if require_archived and not archived:
        result.retained += 1
        return
    if archived and status not in ACTIVE_APPLICATION_STATUSES:
        # Archiving ends CV availability immediately. Keep the historical row,
        # but make the existing idempotent artifact cleanup path due now.
        deadline = created - timedelta(microseconds=1)
    else:
        deadline = calculate_expiration(created_at=created, application_status=status, terminal_at=terminal, application_updated_at=updated_at)
    deadline_text = deadline.isoformat() if deadline else None
    query = urlencode({"id": f"eq.{row['id']}", "user_id": f"eq.{row['user_id']}", "is_base": "eq.false", "artifacts_deleted_at": "is.null"})

    def update(payload):
        saved = client.json_request("PATCH", f"/rest/v1/cv_versions?{query}", payload, prefer="return=representation")
        if not isinstance(saved, list) or len(saved) != 1:
            raise PersistenceError("Cleanup update returned no CV row.")

    if row.get("expires_at") != deadline_text:
        update({"expires_at": deadline_text})
    if deadline is None or deadline > current:
        result.retained += 1
        return
    paths = (row.get("tex_file_path"), row.get("pdf_file_path") or row.get("file_path"))
    prefix = f"{row['user_id']}/tailored/{job_id}/"
    if any(not isinstance(path, str) or not path.startswith(prefix) or any(part in {".", ".."} for part in path.split("/")) for path in paths):
        raise PersistenceError("Unsafe tailored artifact path; artifacts retained.")
    result.expired += 1
    for path in paths:
        _delete_object_retry_safe(client, str(row["storage_bucket"]), path)
    update({"artifacts_deleted_at": current.isoformat(), "expires_at": deadline_text})
    result.deleted += 1


def clear_tailored_expiration_for_job(client: SupabaseRestClient, *, user_id: str, job_id: int) -> None:
    """Pause deletion deadlines when the user marks a job Applied."""

    # Keep lightweight action test doubles and alternate read-only clients from
    # needing to implement this ancillary update. The real server-side client
    # always performs it; the nightly cleanup also derives the same state.
    if not isinstance(client, SupabaseRestClient):
        return
    query = urlencode({"user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}", "is_base": "eq.false", "artifacts_deleted_at": "is.null"})
    client.json_request(
        "PATCH",
        f"/rest/v1/cv_versions?{query}",
        {"expires_at": None},
        prefer="return=minimal",
    )
