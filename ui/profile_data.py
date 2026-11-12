"""User-scoped Profile page data access and deterministic workflows."""

from __future__ import annotations

import json
import os
import re
from pathlib import PurePosixPath
from typing import Any, Callable
from urllib.parse import urlencode
from uuid import UUID
from uuid import uuid4

import streamlit as st

from matching.candidate_profile import CandidateProfile
from matching.candidate_profile_persistence import (
    PARSER_VERSION,
    PersistenceError,
    SupabaseRestClient,
    sha256_bytes,
    supabase_data_revision,
)
from matching.search_profile import SearchProfile

MAX_CV_BYTES = 2 * 1024 * 1024
CV_BUCKET = "cv-artifacts"
SENIORITY = ("intern", "junior", "mid", "senior", "staff", "principal", "lead", "manager", "director", "executive")
WORK_MODELS = ("remote", "hybrid", "onsite", "flexible")
EMPLOYMENT_TYPES = ("full_time", "part_time", "contract", "temporary", "internship")


def resolve_application_user_id(client: SupabaseRestClient) -> str:
    """Resolve a server-owned user context, never from query or widget input."""
    configured = os.getenv("AI_JOB_SEARCH_USER_ID", "").strip()
    if configured:
        try:
            return str(UUID(configured))
        except ValueError as exc:
            raise PersistenceError("AI_JOB_SEARCH_USER_ID must be a valid user UUID.") from exc
    # Backwards-compatible only while the deployment has exactly one active base CV.
    try:
        return _resolve_fallback_user_id_cached(
            client, getattr(client, "base_url", ""), supabase_data_revision()
        )
    except PersistenceError as exc:
        raise PersistenceError(
            "Set AI_JOB_SEARCH_USER_ID in the local server environment to select this app instance's user context."
        ) from exc


@st.cache_data(ttl=60, max_entries=8, show_spinner=False)
def _resolve_fallback_user_id_cached(
    _client: SupabaseRestClient, project_url: str, data_revision: int
) -> str:
    return _client.resolve_active_base_cv().user_id


def _rows(client: SupabaseRestClient, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    rows = client.get_json(f"/rest/v1/{table}?{urlencode(params)}")
    if not isinstance(rows, list):
        raise PersistenceError(f"Supabase returned invalid {table} data.")
    return rows


def _validated_search_profile(row: dict[str, Any]) -> SearchProfile:
    definition = row.get("definition")
    if not isinstance(definition, dict):
        raise PersistenceError("The active SearchProfile definition is invalid.")
    try:
        known = {key: value for key, value in definition.items() if key in SearchProfile.model_fields}
        return SearchProfile.model_validate({**known, "name": row.get("name") or "Job preferences"})
    except Exception as exc:
        raise PersistenceError("The active SearchProfile contains unsupported preference values.") from exc


def load_profile_context(client: SupabaseRestClient, user_id: str) -> dict[str, Any]:
    return _load_profile_context_cached(
        client, user_id, getattr(client, "base_url", ""), supabase_data_revision()
    )


@st.cache_data(max_entries=32, show_spinner=False)
def _load_profile_context_cached(
    _client: SupabaseRestClient, user_id: str, project_url: str, data_revision: int
) -> dict[str, Any]:
    return _load_profile_context_uncached(_client, user_id)


def _load_profile_context_uncached(client: SupabaseRestClient, user_id: str) -> dict[str, Any]:
    cvs = client.list_base_cvs(user_id)
    active = [row for row in cvs if row.get("is_active") is True]
    if len(active) > 1:
        raise PersistenceError("More than one active base CV exists for this user.")
    cv = active[0] if active else None
    candidate = None
    if cv:
        profiles = client.list_profiles(user_id, int(cv["id"]))
        current = [row for row in profiles if row.get("is_active") is True]
        if len(current) > 1:
            raise PersistenceError("More than one active CandidateProfile exists for the current CV.")
        if current:
            candidate = CandidateProfile.model_validate(current[0]["profile_json"])
    search_rows = _rows(client, "search_profiles", {
        "select": "id,user_id,name,definition,min_fit_score,is_active,created_at,updated_at",
        "user_id": f"eq.{user_id}", "is_active": "eq.true", "limit": "2",
    })
    if any(str(row.get("user_id")) != user_id for row in search_rows):
        raise PersistenceError("SearchProfile ownership did not match the current user.")
    if len(search_rows) > 1:
        raise PersistenceError("More than one active SearchProfile exists for this user.")
    search = search_rows[0] if search_rows else None
    if search:
        _validated_search_profile(search)
    return {"cv": cv, "cv_history": cvs, "candidate": candidate, "search_profile": search}


def validate_latex_upload(filename: str, data: bytes) -> str:
    """Reject empty, binary, oversized, or structurally incomplete uploads."""
    if not filename.lower().endswith(".tex"):
        raise ValueError("Upload a LaTeX .tex file.")
    if not data:
        raise ValueError("The selected CV file is empty.")
    if len(data) > MAX_CV_BYTES:
        raise ValueError("The CV file must be 2 MB or smaller.")
    if b"\x00" in data:
        raise ValueError("The selected file appears to be binary, not a text LaTeX document.")
    try:
        source = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("The CV must be valid UTF-8 text.") from exc
    uncommented = "\n".join(re.split(r"(?<!\\)%", line, maxsplit=1)[0] for line in source.splitlines())
    if len(source.strip()) < 80 or not re.search(r"\\documentclass(?:\[[^]]*\])?\{[^}]+\}", uncommented):
        raise ValueError("This file does not contain a recognizable LaTeX document class.")
    if not re.search(r"\\begin\s*\{document\}", uncommented) or not re.search(r"\\end\s*\{document\}", uncommented):
        raise ValueError("The LaTeX CV must contain a complete document environment.")
    if re.search(r"\\begin\s*\{document\}.*\\end\s*\{document\}", uncommented, flags=re.S) is None:
        raise ValueError("The LaTeX document structure is incomplete or out of order.")
    return source


def parse_line_values(value: str) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for part in re.split(r"[\n,]", value):
        item = part.strip()
        if item and item.casefold() not in seen:
            items.append(item)
            seen.add(item.casefold())
    return items


def search_profile_model(row: dict[str, Any]) -> SearchProfile:
    return _validated_search_profile(row)


def save_job_preferences(
    client: SupabaseRestClient,
    *,
    user_id: str,
    row: dict[str, Any] | None,
    definition_updates: dict[str, Any],
) -> dict[str, Any]:
    """Patch only the active user's definition while preserving unedited keys."""
    if row is not None and (str(row.get("user_id")) != user_id or not row.get("is_active")):
        raise PersistenceError("Only the current user's active SearchProfile can be updated.")
    old = (row or {}).get("definition", {})
    if not isinstance(old, dict):
        raise PersistenceError("The active SearchProfile definition is invalid.")
    merged = {**old, **definition_updates}
    name = (row or {}).get("name") or "Job preferences"
    _validated_search_profile({**(row or {}), "name": name, "definition": merged})
    if row is None:
        saved = client.json_request(
            "POST", "/rest/v1/search_profiles",
            {"user_id": user_id, "name": name, "definition": merged, "min_fit_score": 0, "is_active": True},
            prefer="return=representation",
        )
        if not isinstance(saved, list) or len(saved) != 1 or str(saved[0].get("user_id")) != user_id:
            raise PersistenceError("The current user's SearchProfile could not be created.")
        return saved[0]
    params = urlencode({"id": f"eq.{row['id']}", "user_id": f"eq.{user_id}", "is_active": "eq.true"})
    saved = client.json_request(
        "PATCH", f"/rest/v1/search_profiles?{params}", {"definition": merged},
        prefer="return=representation",
    )
    if not isinstance(saved, list) or len(saved) != 1 or str(saved[0].get("user_id")) != user_id:
        raise PersistenceError("The current user's SearchProfile was not updated.")
    return saved[0]


def _rollback_activation(
    client: SupabaseRestClient, *, user_id: str, new_cv_id: int, new_profile_id: int,
    old_cv_id: int | None, old_profiles: list[dict[str, Any]],
) -> bool:
    operations = [
        lambda: client.set_active(new_profile_id, False, user_id=user_id),
        lambda: client.set_cv_active(new_cv_id, user_id, False),
    ]
    if old_cv_id is not None:
        operations.append(lambda: client.set_cv_active(old_cv_id, user_id, True))
    operations.extend(lambda row=row: client.set_active(int(row["id"]), True, user_id=user_id) for row in old_profiles)
    succeeded = True
    for operation in operations:
        try:
            operation()
        except Exception:
            succeeded = False
    return succeeded


def save_and_parse_base_cv(
    client: SupabaseRestClient, *, user_id: str, filename: str, data: bytes,
    parser: Callable[..., CandidateProfile], model: str,
) -> dict[str, Any]:
    """Create an inactive CV generation and switch the active CV/profile only after parse succeeds."""
    source = validate_latex_upload(filename, data)
    current_rows = client.list_base_cvs(user_id)
    active_cvs = [row for row in current_rows if row.get("is_active") is True]
    if len(active_cvs) > 1:
        raise PersistenceError("More than one active base CV exists; replacement was not started.")
    old_cv_id = int(active_cvs[0]["id"]) if active_cvs else None
    old_profiles = client.list_active_profiles_for_user(user_id)
    if len(old_profiles) > 1 or (old_profiles and (old_cv_id is None or int(old_profiles[0]["cv_version_id"]) != old_cv_id)):
        raise PersistenceError("The active CV and CandidateProfile lineage is inconsistent; replacement was not started.")

    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", PurePosixPath(filename).name).strip("._") or "resume.tex"
    if not safe_name.lower().endswith(".tex"):
        safe_name += ".tex"
    path = f"{user_id}/base/{uuid4().hex}-{safe_name}"
    client.upload_storage_object(CV_BUCKET, path, data, content_type="application/x-tex")
    cv_row: dict[str, Any] | None = None
    profile_id: int | None = None
    activation_started = False
    try:
        if sha256_bytes(client.download_storage_object(CV_BUCKET, path)) != sha256_bytes(data):
            raise PersistenceError("Uploaded CV verification failed; the active CV was not changed.")
        inserted = client.json_request("POST", "/rest/v1/cv_versions", {
            "user_id": user_id, "label": safe_name, "file_path": path,
            "storage_bucket": CV_BUCKET, "is_base": True, "is_active": False,
            "notes": "Uploaded as an inactive base CV pending CandidateProfile parsing.",
        }, prefer="return=representation")
        if not isinstance(inserted, list) or len(inserted) != 1 or str(inserted[0].get("user_id")) != user_id:
            raise PersistenceError("The new CV version could not be verified as owned by the current user.")
        cv_row = inserted[0]
        cv_id = int(cv_row["id"])
        profile = CandidateProfile.model_validate(parser(source, cv_id).model_dump(mode="python"))
        if profile.source_cv_version_id != cv_id:
            raise PersistenceError("The parsed CandidateProfile does not reference the uploaded CV version.")
        if client.list_profiles(user_id, cv_id):
            raise PersistenceError("A CandidateProfile generation already exists for the new CV version.")
        profile_row = client.insert_profile({
            "user_id": user_id, "cv_version_id": cv_id,
            "schema_version": profile.schema_version, "parser_version": PARSER_VERSION,
            "model": model, "input_sha256": sha256_bytes(data),
            "profile_json": json.loads(profile.to_deterministic_json()), "is_active": False,
        })
        if str(profile_row.get("user_id")) != user_id or int(profile_row.get("cv_version_id")) != cv_id:
            raise PersistenceError("The new CandidateProfile lineage could not be verified.")
        profile_id = int(profile_row["id"])

        try:
            activation_started = True
            for old_profile in old_profiles:
                client.set_active(int(old_profile["id"]), False, user_id=user_id)
            if old_cv_id is not None:
                client.set_cv_active(old_cv_id, user_id, False)
            client.set_cv_active(cv_id, user_id, True)
            client.set_active(profile_id, True, user_id=user_id)
        except Exception as exc:
            if _rollback_activation(client, user_id=user_id, new_cv_id=cv_id, new_profile_id=profile_id, old_cv_id=old_cv_id, old_profiles=old_profiles):
                raise PersistenceError("Could not activate the new CV; the previous active pair was restored.") from exc
            raise PersistenceError("CV activation failed and rollback could not be fully verified; inspect this user's Profile before continuing.") from exc

        active_cv = client.resolve_active_base_cv(user_id)
        active_profiles = [row for row in client.list_profiles(user_id, cv_id) if row.get("is_active") is True]
        if active_cv.id != cv_id or len(active_profiles) != 1 or int(active_profiles[0]["id"]) != profile_id:
            if _rollback_activation(client, user_id=user_id, new_cv_id=cv_id, new_profile_id=profile_id, old_cv_id=old_cv_id, old_profiles=old_profiles):
                raise PersistenceError("The new CV/Profile pair failed read-back verification; the previous pair was restored.")
            raise PersistenceError("CV/Profile read-back failed and rollback could not be fully verified; inspect this user's Profile before continuing.")
        return {"cv_version_id": cv_id, "candidate_profile_id": profile_id, "input_sha256": sha256_bytes(data)}
    except Exception:
        if cv_row is None:
            try:
                client.delete_storage_object(CV_BUCKET, path)
            except Exception:
                pass
        elif profile_id is None and not activation_started:
            # A rejected/failed parse must not leave a misleading CV generation behind.
            try:
                client.delete_storage_object(CV_BUCKET, path)
            except Exception:
                raise PersistenceError("CV parsing failed; the previous pair remains active, but the inactive uploaded file could not be cleaned up.")
            try:
                client.request(
                    "DELETE",
                    f"/rest/v1/cv_versions?id=eq.{cv_row['id']}&user_id=eq.{user_id}&is_active=eq.false",
                )
            except Exception:
                raise PersistenceError("CV parsing failed; the uploaded file was removed but the inactive draft row could not be cleaned up.")
        raise
