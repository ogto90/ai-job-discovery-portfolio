"""Private, application-linked interview preparation persistence."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from typing import Any
from urllib.parse import urlencode
from uuid import UUID

from matching.candidate_profile_persistence import PersistenceError, SupabaseRestClient
from matching.job_metadata_overrides import get_job_metadata_override, resolve_effective_job_metadata


INTERVIEW_TYPES = {
    "recruiter": "Recruiter screening",
    "hiring_manager": "Hiring manager",
    "technical": "Technical",
    "behavioral": "Behavioral",
    "leadership_final": "Leadership / final",
    "custom": "Custom",
}


def _positive_id(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("A valid record ID is required.")
    return value


def _uuid(value: str) -> str:
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("A valid identifier is required.") from exc


def _rows(client: SupabaseRestClient, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    rows = client.get_json(f"/rest/v1/{table}?{urlencode(params)}")
    if not isinstance(rows, list):
        raise PersistenceError("The interview preparation data could not be loaded.")
    return rows


def _one(client: SupabaseRestClient, table: str, params: dict[str, str]) -> dict[str, Any] | None:
    rows = _rows(client, table, {**params, "limit": "1"})
    return rows[0] if rows else None


def _existing_or_cleanup_snapshot(client: SupabaseRestClient, *, user_id: str,
                                  idempotency_key: str,
                                  snapshot_path: str | None) -> dict[str, Any] | None:
    try:
        existing = _one(client, "interview_preparations", {
            "select": "*", "user_id": f"eq.{user_id}",
            "idempotency_key": f"eq.{idempotency_key}",
        })
    except PersistenceError as exc:
        raise PersistenceError(
            "The preparation save outcome could not be confirmed; its uploaded CV artifact was retained for a safe retry."
        ) from exc
    if existing or not snapshot_path:
        return existing
    try:
        client.delete_storage_object("cv-artifacts", snapshot_path)
    except PersistenceError as exc:
        if "http 404" not in str(exc).casefold() and "not found" not in str(exc).casefold():
            raise PersistenceError(
                "The preparation was not saved, and its uploaded CV artifact could not be cleaned up."
            ) from exc
    return None


def _metadata(interview_type: str, interview_datetime: datetime | None,
              interviewer_name: str | None, interviewer_role: str | None,
              interview_notes: str | None) -> dict[str, Any]:
    if interview_type not in INTERVIEW_TYPES:
        raise ValueError("Choose a supported interview type.")
    if interview_datetime is not None and (
        not isinstance(interview_datetime, datetime)
        or interview_datetime.tzinfo is None
        or interview_datetime.utcoffset() is None
    ):
        raise ValueError("Interview time must include a timezone.")
    fields = {}
    for key, value, limit in (
        ("interviewer_name", interviewer_name, 200),
        ("interviewer_role", interviewer_role, 200),
        ("interview_notes", interview_notes, 10000),
    ):
        if value is not None and (not isinstance(value, str) or len(value) > limit):
            raise ValueError(f"{key.replace('_', ' ').capitalize()} is too long or invalid.")
        fields[key] = value.strip() or None if value is not None else None
    return {
        "interview_type": interview_type,
        "interview_datetime": interview_datetime.isoformat() if interview_datetime else None,
        **fields,
    }


def resolve_application_context(client: SupabaseRestClient, *, user_id: str,
                                application_id: int) -> dict[str, Any]:
    """Resolve only records owned by this user; nothing here is yet frozen."""
    user_id = _uuid(user_id)
    application_id = _positive_id(application_id)
    app = _one(client, "applications", {
        "select": "id,user_id,job_id,cv_version_id,submitted_cv_version_id,status,applied_at",
        "id": f"eq.{application_id}", "user_id": f"eq.{user_id}",
    })
    if not app or str(app.get("user_id")) != user_id:
        raise ValueError("Application not found.")
    job_id = _positive_id(int(app["job_id"]))
    job = _one(client, "jobs", {
        "select": "id,company,title,description,description_kind,source_url,application_url,updated_at",
        "id": f"eq.{job_id}",
    })
    if not job:
        raise ValueError("The application's job could not be found.")
    effective = resolve_effective_job_metadata(
        job.get("company"), job.get("title"),
        get_job_metadata_override(client, user_id=user_id, job_id=job_id),
    )
    job = {**job, "source_company": job.get("company"), "source_title": job.get("title"),
           "company": effective.company, "title": effective.title}
    versions = _rows(client, "cv_versions", {
        "select": "id,user_id,job_id,label,created_at,is_base,is_active,storage_bucket,file_path,artifacts_deleted_at",
        "user_id": f"eq.{user_id}",
        "or": f"(job_id.eq.{job_id},id.eq.{int(app['cv_version_id'])})" if app.get("cv_version_id") else f"(job_id.eq.{job_id})",
        "order": "created_at.desc,id.desc",
    })
    versions = [row for row in versions if str(row.get("user_id")) == user_id]
    submitted = None
    if app.get("submitted_cv_version_id"):
        submitted = next((row for row in versions if int(row["id"]) == int(app["submitted_cv_version_id"])), None)
        if submitted is None:
            submitted = _one(client, "cv_versions", {
                "select": "id,user_id,job_id,label,created_at,is_base,is_active,storage_bucket,file_path,artifacts_deleted_at",
                "id": f"eq.{int(app['submitted_cv_version_id'])}", "user_id": f"eq.{user_id}",
            })
            if submitted:
                versions.append(submitted)
    assessment = _one(client, "job_match_assessments", {
        "select": "id,user_id,job_id,candidate_profile_id,fit_score,created_at",
        "user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}",
        "order": "created_at.desc,id.desc",
    })
    profile = None
    if assessment:
        profile = _one(client, "candidate_profiles", {
            "select": "id,user_id,cv_version_id,created_at,profile_json",
            "user_id": f"eq.{user_id}", "id": f"eq.{int(assessment['candidate_profile_id'])}",
        })
    elif app.get("cv_version_id"):
        profile = _one(client, "candidate_profiles", {
            "select": "id,user_id,cv_version_id,created_at,profile_json",
            "user_id": f"eq.{user_id}", "cv_version_id": f"eq.{int(app['cv_version_id'])}",
            "order": "created_at.desc,id.desc",
        })
    return {"application": app, "job": job, "cv_versions": versions,
            "submitted_cv": submitted, "profile": profile, "assessment": assessment}


def resolve_submitted_cv(context: dict[str, Any], selected_cv_version_id: int | None,
                         *, confirmed: bool) -> dict[str, Any] | None:
    known = context["submitted_cv"]
    if known is not None:
        if selected_cv_version_id is not None and int(known["id"]) != selected_cv_version_id:
            raise ValueError("The submitted CV is already recorded for this application.")
        return known
    if selected_cv_version_id is None:
        return None
    selected_cv_version_id = _positive_id(selected_cv_version_id)
    if not confirmed:
        raise ValueError("Confirm that this is the CV actually submitted.")
    version = next((row for row in context["cv_versions"] if int(row["id"]) == selected_cv_version_id), None)
    if version is None:
        raise ValueError("Select a CV associated with this application or job.")
    return version


def get_interview_preparation(client: SupabaseRestClient, *, user_id: str,
                              preparation_id: str) -> dict[str, Any]:
    row = _one(client, "interview_preparations", {
        "select": "*", "id": f"eq.{_uuid(preparation_id)}", "user_id": f"eq.{_uuid(user_id)}",
    })
    if not row or str(row.get("user_id")) != _uuid(user_id):
        raise ValueError("Interview preparation not found.")
    return row


def list_interview_preparations_for_application(client: SupabaseRestClient, *, user_id: str,
                                                 application_id: int) -> list[dict[str, Any]]:
    rows = _rows(client, "interview_preparations", {
        "select": "id,application_id,user_id,interview_type,interview_datetime,status,created_at",
        "user_id": f"eq.{_uuid(user_id)}", "application_id": f"eq.{_positive_id(application_id)}",
        "order": "created_at.desc,id.desc",
    })
    if any(str(row.get("user_id")) != _uuid(user_id) for row in rows):
        raise PersistenceError("The interview preparation list could not be verified.")
    return rows


def create_interview_preparation(
    client: SupabaseRestClient, *, user_id: str, application_id: int, idempotency_key: str,
    interview_type: str, selected_cv_version_id: int | None = None, cv_confirmed: bool = False,
    interview_datetime: datetime | None = None, interviewer_name: str | None = None,
    interviewer_role: str | None = None, interview_notes: str | None = None,
) -> dict[str, Any]:
    user_id, idempotency_key = _uuid(user_id), _uuid(idempotency_key)
    application_id = _positive_id(application_id)
    metadata = _metadata(interview_type, interview_datetime, interviewer_name, interviewer_role, interview_notes)
    existing = _one(client, "interview_preparations", {
        "select": "*", "user_id": f"eq.{user_id}", "idempotency_key": f"eq.{idempotency_key}",
    })
    if existing:
        if int(existing["application_id"]) != application_id:
            raise ValueError("This request key belongs to another application.")
        return existing
    context = resolve_application_context(client, user_id=user_id, application_id=application_id)
    cv = resolve_submitted_cv(context, selected_cv_version_id, confirmed=cv_confirmed)
    job, app = context["job"], context["application"]
    snapshot: dict[str, Any] = {
        "schema_version": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "application_id": application_id,
        "application_status": app["status"],
        "job_id": job["id"], "company": job["company"], "title": job["title"],
        "source_company": job["source_company"], "source_title": job["source_title"],
        "description": job.get("description"), "description_kind": job.get("description_kind"),
        "job_updated_at": job.get("updated_at"),
        "cv": None,
        "candidate_profile_id": context["profile"]["id"] if context["profile"] else None,
        "fit_assessment_id": context["assessment"]["id"] if context["assessment"] else None,
        "candidate_profile": {
            "id": context["profile"]["id"],
            "created_at": context["profile"]["created_at"],
            "profile_json": context["profile"]["profile_json"],
        } if context["profile"] else None,
        "fit_assessment": {
            "id": context["assessment"]["id"],
            "created_at": context["assessment"]["created_at"],
            "fit_score": context["assessment"]["fit_score"],
        } if context["assessment"] else None,
    }
    snapshot_path = None
    if cv:
        snapshot["cv"] = {key: cv.get(key) for key in ("id", "label", "created_at", "is_base", "job_id")}
        if not cv.get("artifacts_deleted_at"):
            try:
                data = client.download_storage_object(str(cv["storage_bucket"]), str(cv["file_path"]))
            except PersistenceError:
                snapshot["cv"]["artifact_status"] = "unavailable"
            else:
                if data:
                    is_pdf = str(cv["file_path"]).lower().endswith(".pdf")
                    path = f"interview-preparations/{user_id}/{idempotency_key}/{cv['id']}.{'pdf' if is_pdf else 'tex'}"
                    snapshot_path = path
                    try:
                        client.upload_storage_object("cv-artifacts", path, data,
                                                     content_type="application/pdf" if is_pdf else "text/plain")
                    except PersistenceError:
                        existing = _existing_or_cleanup_snapshot(
                            client, user_id=user_id, idempotency_key=idempotency_key,
                            snapshot_path=snapshot_path,
                        )
                        if existing:
                            return existing
                        raise
                    snapshot["cv"].update({"artifact_status": "saved", "snapshot_bucket": "cv-artifacts",
                                           "snapshot_path": path, "sha256": hashlib.sha256(data).hexdigest()})
                else:
                    snapshot["cv"]["artifact_status"] = "unavailable"
        else:
            snapshot["cv"]["artifact_status"] = "unavailable"
    ready = bool(cv and snapshot["cv"].get("artifact_status") == "saved"
                 and job.get("description") and job.get("description_kind") == "full"
                 and context["profile"])
    payload = {
        "user_id": user_id, "application_id": application_id, "job_id": int(job["id"]),
        "idempotency_key": idempotency_key,
        "submitted_cv_version_id": int(cv["id"]) if cv else None,
        "candidate_profile_id": snapshot["candidate_profile_id"],
        "fit_assessment_id": snapshot["fit_assessment_id"],
        "source_context": snapshot, "status": "ready" if ready else "draft", **metadata,
    }
    try:
        if cv and context["submitted_cv"] is None:
            query = urlencode({"id": f"eq.{application_id}", "user_id": f"eq.{user_id}",
                               "submitted_cv_version_id": "is.null"})
            recorded = client.json_request("PATCH", f"/rest/v1/applications?{query}",
                                           {"submitted_cv_version_id": int(cv["id"])},
                                           prefer="return=representation")
            if not isinstance(recorded, list) or len(recorded) != 1:
                latest = resolve_application_context(client, user_id=user_id, application_id=application_id)
                if not latest["submitted_cv"] or int(latest["submitted_cv"]["id"]) != int(cv["id"]):
                    raise PersistenceError("The submitted CV changed while this preparation was being created.")
        created = client.json_request("POST", "/rest/v1/interview_preparations", payload,
                                      prefer="return=representation")
        if not isinstance(created, list) or len(created) != 1:
            raise PersistenceError("The preparation could not be confirmed after saving.")
    except (PersistenceError, ValueError):
        existing = _existing_or_cleanup_snapshot(
            client, user_id=user_id, idempotency_key=idempotency_key,
            snapshot_path=snapshot_path,
        )
        if existing:
            return existing
        raise
    return created[0]


def update_interview_preparation(
    client: SupabaseRestClient, *, user_id: str, preparation_id: str,
    interview_type: str, interview_datetime: datetime | None = None,
    interviewer_name: str | None = None, interviewer_role: str | None = None,
    interview_notes: str | None = None,
) -> dict[str, Any]:
    user_id, preparation_id = _uuid(user_id), _uuid(preparation_id)
    get_interview_preparation(client, user_id=user_id, preparation_id=preparation_id)
    payload = _metadata(interview_type, interview_datetime, interviewer_name, interviewer_role, interview_notes)
    updated = client.json_request("PATCH", f"/rest/v1/interview_preparations?{urlencode({'id': f'eq.{preparation_id}', 'user_id': f'eq.{user_id}'})}",
                                  payload, prefer="return=representation")
    if not isinstance(updated, list) or len(updated) != 1:
        raise PersistenceError("The preparation update could not be confirmed.")
    return updated[0]
