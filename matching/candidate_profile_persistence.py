"""Server-side persistence for validated candidate-profile generations.

This module deliberately has no OpenAI dependency. It replays a saved typed
extraction, validates the generalized profile, and persists it through the
Supabase REST API using a trusted server-side secret key.
"""

from __future__ import annotations

import hashlib
import json
import os
from threading import Lock
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode
from urllib.request import Request, urlopen
from contextlib import nullcontext

from .artifact_lifecycle_lock import artifact_lifecycle_lock
from .postgrest_metrics import record_response

from .candidate_profile import CandidateProfile, CURRENT_CANDIDATE_PROFILE_SCHEMA_VERSION
from .cv_normalizer import (
    augment_explicit_skill_capabilities,
    load_extracted_candidate_profile,
    normalize_extracted_profile,
)
from .domains.cybersecurity import CYBERSECURITY_DOMAIN


PARSER_VERSION = "2.0.0"
"""Version of the extraction contract plus generic and cybersecurity normalization."""

_SUPABASE_DATA_REVISION = 0
_SUPABASE_CARD_REVISION = 0
_SUPABASE_DATA_REVISION_LOCK = Lock()


def supabase_data_revision() -> int:
    """Return a process-local cache revision advanced after successful writes."""
    with _SUPABASE_DATA_REVISION_LOCK:
        return _SUPABASE_DATA_REVISION


def supabase_card_revision() -> int:
    """Refresh future read-model loads without expiring active page snapshots."""
    with _SUPABASE_DATA_REVISION_LOCK:
        return _SUPABASE_CARD_REVISION


def invalidate_supabase_read_cache() -> int:
    """Advance the revision to force cached read models to refresh."""
    global _SUPABASE_DATA_REVISION
    with _SUPABASE_DATA_REVISION_LOCK:
        _SUPABASE_DATA_REVISION += 1
        return _SUPABASE_DATA_REVISION


def _is_card_local_cv_write(method: str, path: str, body: bytes | None) -> bool:
    """Tailored artifact changes are reconciled by their card, not a page reload."""
    endpoint = path.split("?", 1)[0]
    parts = endpoint.strip("/").split("/")
    if method.upper() in {"POST", "DELETE"} and len(parts) >= 8:
        if parts[:3] == ["storage", "v1", "object"] and parts[5] == "tailored":
            return True
    if method.upper() == "POST" and endpoint == "/rest/v1/cv_versions" and body:
        try:
            row = json.loads(body)
        except (ValueError, UnicodeError):
            return False
        return (
            isinstance(row, dict) and row.get("is_base") is False
            and row.get("is_active") is False
            and row.get("job_id") is not None and row.get("source_cv_version_id") is not None
        )
    if method.upper() == "PATCH" and endpoint == "/rest/v1/cv_versions" and body:
        try:
            payload = json.loads(body)
            filters = parse_qs(path.partition("?")[2])
        except (ValueError, UnicodeError):
            return False
        return (
            isinstance(payload, dict)
            and payload.get("expires_at", object()) is None
            and filters.get("user_id") and filters["user_id"][0].startswith("eq.")
            and filters.get("job_id") and filters["job_id"][0].startswith("eq.")
            and filters.get("is_base") == ["eq.false"]
            and filters.get("artifacts_deleted_at") == ["is.null"]
        )
    return False


class PersistenceError(RuntimeError):
    """A safe, actionable persistence failure without secret material."""


@dataclass(frozen=True)
class ActiveBaseCV:
    id: int
    user_id: str
    storage_bucket: str
    file_path: str
    is_base: bool
    is_active: bool
    label: str = ""
    created_at: str | None = None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_profile_json(profile: CandidateProfile) -> str:
    """Return the exact stable JSON representation stored in JSONB."""

    return profile.to_deterministic_json()


def replay_saved_extraction(
    extraction_json: dict[str, Any], *, cv_version_id: int, latex_text: str
) -> CandidateProfile:
    """Replay extraction -> domain normalization -> generic normalization locally."""

    extraction = load_extracted_candidate_profile(extraction_json)
    extraction = augment_explicit_skill_capabilities(extraction, latex_text)
    extraction = CYBERSECURITY_DOMAIN.augment(extraction)
    profile = normalize_extracted_profile(
        extraction, cv_version_id, domain_rules=CYBERSECURITY_DOMAIN
    )
    profile = profile.model_copy(
        update={
            "schema_version": CURRENT_CANDIDATE_PROFILE_SCHEMA_VERSION,
            "source_cv_version_id": cv_version_id,
        }
    )
    return CandidateProfile.model_validate(profile.model_dump(mode="python"))


class SupabaseRestClient:
    """Minimal REST client for the trusted server-side Supabase secret key."""

    def __init__(self, url: str, secret_key: str):
        self.base_url = url.rstrip("/")
        self.secret_key = secret_key

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        content_type: str | None = None,
        prefer: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[int, bytes]:
        application_write = method.upper() != "GET" and path.split("?", 1)[0] == "/rest/v1/applications"
        try:
            with artifact_lifecycle_lock(self.base_url, application_write=True) if application_write else nullcontext():
                return self._request_unlocked(
                    method, path, body=body, content_type=content_type,
                    prefer=prefer, extra_headers=extra_headers,
                )
        except TimeoutError as exc:
            raise PersistenceError(str(exc)) from exc

    def _request_unlocked(
        self, method: str, path: str, *, body: bytes | None = None,
        content_type: str | None = None, prefer: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[int, bytes]:
        headers = {
            "apikey": self.secret_key,
            "Authorization": f"Bearer {self.secret_key}",
        }
        if content_type:
            headers["Content-Type"] = content_type
        if prefer:
            headers["Prefer"] = prefer
        if extra_headers:
            headers.update(extra_headers)
        request = Request(self.base_url + path, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=30) as response:
                result = response.status, response.read()
                record_response(method, path, result[0], len(result[1]))
                user_lifecycle_write = path.split("?", 1)[0] in {
                    "/rest/v1/applications",
                    "/rest/v1/job_reviews",
                    "/rest/v1/job_match_assessments",
                    "/rest/v1/user_job_work_model_verifications",
                }
                if method.upper() != "GET":
                    if _is_card_local_cv_write(method, path, body) or path.split("?", 1)[0] == "/rest/v1/job_match_assessments":
                        global _SUPABASE_CARD_REVISION
                        with _SUPABASE_DATA_REVISION_LOCK:
                            _SUPABASE_CARD_REVISION += 1
                    elif not user_lifecycle_write:
                        invalidate_supabase_read_cache()
                return result
        except HTTPError as exc:
            error_body = exc.read(512)
            record_response(method, path, exc.code, len(error_body))
            detail = error_body.decode("utf-8", errors="replace")
            raise PersistenceError(
                f"Supabase {method} {path} failed with HTTP {exc.code}: {detail}"
            ) from exc
        except URLError as exc:
            record_response(method, path, 0, 0)
            raise PersistenceError(f"Supabase {method} {path} failed: {exc.reason}") from exc

    def json_request(self, method: str, path: str, payload: Any = None, *, prefer: str | None = None) -> Any:
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        _, raw = self.request(method, path, body=body, content_type="application/json", prefer=prefer)
        if not raw:
            return None
        return json.loads(raw)

    def get_json(self, path: str) -> Any:
        return self.json_request("GET", path)

    def resolve_active_base_cv(self, user_id: str | None = None) -> ActiveBaseCV:
        params = {
            "select": "id,user_id,storage_bucket,file_path,is_base,is_active,label,created_at",
            "is_base": "eq.true",
            "is_active": "eq.true",
            "order": "id",
        }
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        query = urlencode(params)
        rows = self.get_json(f"/rest/v1/cv_versions?{query}")
        if not isinstance(rows, list) or len(rows) != 1:
            raise PersistenceError(
                f"Expected exactly one active base CV{f' for user {user_id}' if user_id else ''}; found {len(rows) if isinstance(rows, list) else 'invalid data'}."
            )
        row = rows[0]
        if user_id and str(row.get("user_id")) != user_id:
            raise PersistenceError("The active base CV ownership did not match the current user.")
        return ActiveBaseCV(
            id=int(row["id"]),
            user_id=str(row["user_id"]),
            storage_bucket=str(row["storage_bucket"]),
            file_path=str(row["file_path"]),
            is_base=bool(row["is_base"]),
            is_active=bool(row["is_active"]),
            label=str(row.get("label") or ""),
            created_at=str(row["created_at"]) if row.get("created_at") else None,
        )

    def list_base_cvs(self, user_id: str) -> list[dict[str, Any]]:
        query = urlencode({
            "select": "id,user_id,label,file_path,storage_bucket,is_base,is_active,created_at,notes",
            "user_id": f"eq.{user_id}",
            "is_base": "eq.true",
            "order": "created_at.desc,id.desc",
        })
        rows = self.get_json(f"/rest/v1/cv_versions?{query}")
        if not isinstance(rows, list) or any(str(row.get("user_id")) != user_id for row in rows):
            raise PersistenceError("Supabase returned invalid CV history data.")
        return rows

    def list_active_profiles_for_user(self, user_id: str) -> list[dict[str, Any]]:
        query = urlencode({
            "select": "id,user_id,cv_version_id,is_active",
            "user_id": f"eq.{user_id}",
            "is_active": "eq.true",
            "order": "cv_version_id",
        })
        rows = self.get_json(f"/rest/v1/candidate_profiles?{query}")
        if not isinstance(rows, list) or any(str(row.get("user_id")) != user_id for row in rows):
            raise PersistenceError("Supabase returned invalid active profile data.")
        return rows

    def set_cv_active(self, cv_version_id: int, user_id: str, active: bool) -> None:
        query = urlencode({"id": f"eq.{cv_version_id}", "user_id": f"eq.{user_id}", "is_base": "eq.true"})
        rows = self.json_request(
            "PATCH", f"/rest/v1/cv_versions?{query}", {"is_active": active},
            prefer="return=representation",
        )
        if not isinstance(rows, list) or len(rows) != 1 or str(rows[0].get("user_id")) != user_id:
            raise PersistenceError("The requested user's base CV could not be updated.")

    def download_storage_object(self, bucket: str, path: str) -> bytes:
        encoded = quote(path, safe="/")
        _, raw = self.request("GET", f"/storage/v1/object/{quote(bucket, safe='')}/{encoded}")
        return raw

    def upload_storage_object(self, bucket: str, path: str, data: bytes, *, content_type: str) -> None:
        encoded_bucket = quote(bucket, safe="")
        encoded_path = quote(path, safe="/")
        self.request(
            "POST",
            f"/storage/v1/object/{encoded_bucket}/{encoded_path}",
            body=data,
            content_type=content_type,
            extra_headers={"x-upsert": "true"},
        )

    def delete_storage_object(self, bucket: str, path: str) -> None:
        encoded_bucket = quote(bucket, safe="")
        encoded_path = quote(path, safe="/")
        self.request("DELETE", f"/storage/v1/object/{encoded_bucket}/{encoded_path}")

    def list_profiles(self, user_id: str, cv_version_id: int) -> list[dict[str, Any]]:
        query = urlencode(
            {
                "select": "id,user_id,cv_version_id,schema_version,parser_version,model,input_sha256,profile_json,is_active,created_at",
                "user_id": f"eq.{user_id}",
                "cv_version_id": f"eq.{cv_version_id}",
                "order": "created_at.desc,id.desc",
            }
        )
        rows = self.get_json(f"/rest/v1/candidate_profiles?{query}")
        if not isinstance(rows, list) or any(
            str(row.get("user_id")) != user_id or int(row.get("cv_version_id", -1)) != cv_version_id
            for row in rows
        ):
            raise PersistenceError("Supabase returned invalid candidate profile data.")
        return rows

    def set_active(self, profile_id: int, active: bool, *, user_id: str | None = None) -> None:
        params = {"id": f"eq.{profile_id}"}
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        query = urlencode(params)
        rows = self.json_request(
            "PATCH",
            f"/rest/v1/candidate_profiles?{query}",
            {"is_active": active},
            prefer="return=representation",
        )
        if not isinstance(rows, list) or len(rows) != 1:
            raise PersistenceError(f"Expected one candidate profile update for id {profile_id}.")
        if user_id and str(rows[0].get("user_id")) != user_id:
            raise PersistenceError("Candidate profile ownership did not match the current user.")

    def insert_profile(self, payload: dict[str, Any]) -> dict[str, Any]:
        rows = self.json_request(
            "POST",
            "/rest/v1/candidate_profiles",
            payload,
            prefer="return=representation",
        )
        if not isinstance(rows, list) or len(rows) != 1:
            raise PersistenceError("Expected one inserted candidate profile.")
        return rows[0]


def _same_generation(
    row: dict[str, Any],
    profile: CandidateProfile,
    *,
    user_id: str,
    model: str,
    input_sha256: str,
) -> bool:
    return (
        str(row.get("user_id")) == user_id
        and int(row.get("cv_version_id")) == profile.source_cv_version_id
        and row.get("schema_version") == profile.schema_version
        and row.get("parser_version") == PARSER_VERSION
        and row.get("model") == model
        and row.get("input_sha256") == input_sha256
        and json.dumps(row.get("profile_json"), sort_keys=True, separators=(",", ":"))
        == canonical_profile_json(profile)
    )


def persist_profile(
    client: SupabaseRestClient,
    profile: CandidateProfile,
    *,
    user_id: str,
    cv_version_id: int,
    input_sha256: str,
    model: str,
) -> tuple[int, bool]:
    """Persist/reuse one generation, with compensating activation rollback."""

    if profile.source_cv_version_id != cv_version_id:
        raise PersistenceError("Candidate profile source CV version does not match database context.")
    rows = client.list_profiles(user_id, cv_version_id)
    for row in rows:
        if _same_generation(
            row,
            profile,
            user_id=user_id,
            model=model,
            input_sha256=input_sha256,
        ):
            profile_id = int(row["id"])
            if not row.get("is_active"):
                old_active = next((r for r in rows if r.get("is_active")), None)
                if old_active:
                    client.set_active(int(old_active["id"]), False, user_id=user_id)
                try:
                    client.set_active(profile_id, True, user_id=user_id)
                except Exception:
                    if old_active:
                        client.set_active(int(old_active["id"]), True, user_id=user_id)
                    raise
            return profile_id, False

    payload = {
        "user_id": user_id,
        "cv_version_id": cv_version_id,
        "schema_version": profile.schema_version,
        "parser_version": PARSER_VERSION,
        "model": model,
        "input_sha256": input_sha256,
        "profile_json": json.loads(canonical_profile_json(profile)),
        "is_active": False,
    }
    inserted = client.insert_profile(payload)
    profile_id = int(inserted["id"])
    old_active = next((r for r in rows if r.get("is_active")), None)
    if old_active:
        client.set_active(int(old_active["id"]), False, user_id=user_id)
    try:
        client.set_active(profile_id, True, user_id=user_id)
    except Exception:
        if old_active:
            client.set_active(int(old_active["id"]), True, user_id=user_id)
        raise
    return profile_id, True


def load_env_file(path: Path) -> None:
    """Load simple KEY=value settings without printing or shell-evaluating them."""

    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
