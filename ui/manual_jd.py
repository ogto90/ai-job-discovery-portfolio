"""Manual job-description completion and score-only Fit evaluation."""

from __future__ import annotations

import os
import re
import hashlib
from typing import Any
from urllib.parse import urlencode

from openai import OpenAI
from pydantic import ValidationError
from matching.application_lifecycle import can_rate_state, lifecycle_state

from matching.candidate_profile import CandidateProfile
from matching.candidate_profile_persistence import PersistenceError, SupabaseRestClient
from matching.holistic_match_persistence import FitCacheRecord, get_by_fingerprint, persist_fit
from matching.job_eligibility import assess_discovered_job, detected_employment_types
from matching.job_metadata_overrides import get_job_metadata_override, resolve_effective_job_metadata
from matching.holistic_matcher import (
    DEFAULT_MODEL,
    HOLISTIC_MATCHER_VERSION,
    VerifiedJob,
    evaluate_holistic_match,
    evaluation_fingerprint,
)


MIN_MANUAL_JD_CHARS = 200
MAX_MANUAL_JD_CHARS = 30_000


def load_manual_job_context(client: SupabaseRestClient, *, user_id: str) -> tuple[int, int | None]:
    """Load only the active CV/profile lineage needed by the Add Job form."""
    cv = client.resolve_active_base_cv(user_id)
    profiles = client.list_profiles(cv.user_id, cv.id)
    active_profiles = [row for row in profiles if row.get("is_active") is True]
    if len(active_profiles) > 1:
        raise PersistenceError("More than one active CandidateProfile exists for the current CV.")
    profile_id = int(active_profiles[0]["id"]) if active_profiles else None
    if profile_id is not None:
        try:
            CandidateProfile.model_validate(active_profiles[0]["profile_json"])
        except (KeyError, TypeError, ValidationError) as exc:
            raise PersistenceError("The active CandidateProfile is invalid.") from exc
    return cv.id, profile_id


class ManualJDValidationError(ValueError):
    """The submitted text is not sufficient to treat as a full JD."""


class ManualJDOperationError(RuntimeError):
    """A persistence or scoring error, with whether the JD was already saved."""

    def __init__(self, message: str, *, jd_saved: bool):
        super().__init__(message)
        self.jd_saved = jd_saved


class ManualEmploymentTypeDecisionRequired(ManualJDOperationError):
    """A detected employment type needs a user-specific decision before Fit."""

    def __init__(self, employment_type: str, reason: str, jd_sha256: str, *, detected_in_jd: bool):
        label = employment_type.replace("_", " ").title()
        source = "The job description identifies" if detected_in_jd else "The listing metadata identifies"
        super().__init__(
            f"{source} this position as {label}. {reason}",
            jd_saved=False,
        )
        self.employment_type = employment_type
        self.reason = reason
        self.jd_sha256 = jd_sha256
        self.detected_in_jd = detected_in_jd


def normalize_manual_jd(value: str) -> str:
    """Normalize whitespace without rewriting the user's job-description content."""

    text = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    normalized: list[str] = []
    blank = False
    for line in lines:
        if not line:
            if not blank:
                normalized.append("")
            blank = True
        else:
            normalized.append(line)
            blank = False
    return "\n".join(normalized).strip()


def validate_manual_jd(value: str) -> str:
    """Return normalized JD text or raise before any database write."""

    text = normalize_manual_jd(value)
    if not text:
        raise ManualJDValidationError("Paste a job description before saving.")
    if len(text) < MIN_MANUAL_JD_CHARS:
        raise ManualJDValidationError(
            f"The job description is too short. Paste the complete listing (at least {MIN_MANUAL_JD_CHARS} characters)."
        )
    if len(text) > MAX_MANUAL_JD_CHARS:
        raise ManualJDValidationError(
            f"The job description is too long. Keep it to {MAX_MANUAL_JD_CHARS} characters or fewer."
        )
    return text


def manual_jd_sha256(text: str) -> str:
    normalized = normalize_manual_jd(text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def save_employment_type_decision(
    client: SupabaseRestClient, *, user_id: str, job_id: int,
    employment_type: str, decision: str, jd_sha256: str,
) -> None:
    if employment_type not in {"contract", "permanent", "full_time", "part_time", "temporary", "internship"}:
        raise ValueError("Choose a detected employment type.")
    if decision not in {"accepted", "rejected"} or not re.fullmatch(r"[a-f0-9]{64}", jd_sha256):
        raise ValueError("The employment-type decision is invalid.")
    try:
        client.json_request(
            "POST",
            "/rest/v1/user_job_employment_type_verifications?on_conflict=user_id,job_id",
            {
                "user_id": user_id,
                "job_id": job_id,
                "employment_type": employment_type,
                "decision": decision,
                "jd_sha256": jd_sha256,
            },
            prefer="resolution=merge-duplicates,return=minimal",
        )
    except PersistenceError as exc:
        message = str(exc).lower()
        if "user_job_employment_type_verifications" in message and any(code in message for code in ("pgrst205", "42p01", "404")):
            raise PersistenceError("Contract-type approval needs the latest Supabase migration. Apply it, then retry.") from exc
        raise


def _active_profile(client: SupabaseRestClient, *, user_id: str, cv_version_id: int, profile_id: int) -> CandidateProfile:
    profiles = client.list_profiles(user_id, cv_version_id)
    matches = [row for row in profiles if int(row["id"]) == profile_id and row.get("is_active") is True]
    if len(matches) != 1:
        raise PersistenceError("The active CandidateProfile could not be resolved.")
    return CandidateProfile.model_validate(matches[0]["profile_json"])


def _job_row(client: SupabaseRestClient, job_id: int) -> dict[str, Any]:
    query = urlencode({"select": "*", "id": f"eq.{job_id}", "limit": "1"})
    rows = client.get_json(f"/rest/v1/jobs?{query}")
    if not isinstance(rows, list) or len(rows) != 1:
        raise PersistenceError("The job could not be resolved.")
    return rows[0]


def rate_job_with_manual_jd(
    client: SupabaseRestClient,
    *,
    user_id: str,
    cv_version_id: int,
    candidate_profile_id: int,
    job_id: int,
    jd_text: str,
    employment_type_decision: dict[str, str] | None = None,
    ai_client: Any | None = None,
    model: str = DEFAULT_MODEL,
) -> dict[str, Any]:
    """Save a validated JD, then cache-hit or perform exactly one Fit call."""

    text = validate_manual_jd(jd_text)
    row = _job_row(client, job_id)
    if row.get("source") == "manual" and str(row.get("manual_owner_user_id")) != user_id:
        raise ManualJDOperationError("This manual listing does not belong to the current user.", jd_saved=False)
    try:
        application_rows = client.get_json("/rest/v1/applications?" + urlencode({
            "select": "status", "user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}", "limit": "1",
        }))
        review_rows = client.get_json("/rest/v1/job_reviews?" + urlencode({
            "select": "status", "user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}", "limit": "1",
        }))
    except PersistenceError as exc:
        raise ManualJDOperationError("Could not verify this listing's user-specific lifecycle before rating.", jd_saved=False) from exc
    if not isinstance(application_rows, list) or not isinstance(review_rows, list):
        raise ManualJDOperationError("Could not verify this listing's user-specific lifecycle before rating.", jd_saved=False)
    state = lifecycle_state(
        application_rows[0] if application_rows else None,
        review_rows[0] if review_rows else None,
        has_current_fit=False,
    )
    if not can_rate_state(state):
        raise ManualJDOperationError(f"Rating is disabled while this listing is {state}.", jd_saved=False)
    override = get_job_metadata_override(client, user_id=user_id, job_id=job_id)
    effective_metadata = resolve_effective_job_metadata(
        row.get("company"), row.get("title"), override
    )
    if row.get("source") != "manual":
        verifications = client.get_json(
            "/rest/v1/user_job_verifications?" + urlencode({
                "select": "verification_status",
                "user_id": f"eq.{user_id}",
                "job_id": f"eq.{job_id}",
                "limit": "1",
            })
        )
        user_status = (
            verifications[0].get("verification_status")
            if isinstance(verifications, list) and len(verifications) == 1
            else None
        )
        manually_confirmed_live = user_status == "confirmed_live"
        manually_not_live = user_status in {"confirmed_closed", "unable_to_verify"}
        if (
            row.get("availability_status") == "expired"
            or manually_not_live
            or (row.get("availability_status") != "active" and not manually_confirmed_live)
        ):
            raise ManualJDOperationError(
                "This listing is not verified live. Open it, record a manual live confirmation, then retry rating.",
                jd_saved=False,
            )
        profiles = client.get_json(
            "/rest/v1/search_profiles?" + urlencode({
                "select": "id,definition",
                "user_id": f"eq.{user_id}",
                "is_active": "eq.true",
                "limit": "2",
            })
        )
        if not isinstance(profiles, list) or len(profiles) != 1:
            raise ManualJDOperationError("The active SearchProfile could not be resolved; no Fit call was made.", jd_saved=False)
        try:
            location_rows = client.get_json("/rest/v1/user_job_location_verifications?" + urlencode({
                "select": "user_id,job_id,location_status",
                "user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}", "limit": "2",
            }))
        except PersistenceError as exc:
            raise ManualJDOperationError("Could not load the saved location approval; no Fit call was made.", jd_saved=False) from exc
        if not isinstance(location_rows, list) or len(location_rows) > 1 or any(
            not isinstance(item, dict) or item.get("user_id") != user_id
            or item.get("job_id") != job_id
            or item.get("location_status") not in {"accepted", "rejected"}
            for item in location_rows
        ):
            raise ManualJDOperationError("Invalid saved location approval; no Fit call was made.", jd_saved=False)
        try:
            preference_rows = client.get_json("/rest/v1/user_job_preference_overrides?" + urlencode({
                "select": "user_id,job_id,overridden_preferences,is_active",
                "user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}", "is_active": "eq.true", "limit": "2",
            }))
        except PersistenceError as exc:
            raise ManualJDOperationError("Could not revalidate this listing's saved review decision; no Fit call was made.", jd_saved=False) from exc
        if not isinstance(preference_rows, list) or len(preference_rows) > 1 or any(
            not isinstance(item, dict) or item.get("user_id") != user_id
            or item.get("job_id") != job_id
            or not isinstance(item.get("overridden_preferences"), list)
            for item in preference_rows
        ):
            raise ManualJDOperationError("Invalid saved listing review decision; no Fit call was made.", jd_saved=False)
        preference_overrides = set()
        if preference_rows:
            allowed = {"role", "location", "employment_type", "seniority"}
            saved = preference_rows[0]["overridden_preferences"]
            if any(not isinstance(value, str) for value in saved):
                raise ManualJDOperationError("Invalid saved listing review decision; no Fit call was made.", jd_saved=False)
            if set(saved) - allowed - {"work_model", "language"}:
                raise ManualJDOperationError("Invalid saved listing review decision; no Fit call was made.", jd_saved=False)
            preference_overrides = set(saved) & allowed
        eligibility = assess_discovered_job(
            title=effective_metadata.title,
            location=row.get("location"),
            remote_scope=row.get("remote_scope"),
            description=text,
            profile=profiles[0],
            employment_type=row.get("employment_type"),
            description_kind="full",
            verified_location_status=location_rows[0]["location_status"] if location_rows else None,
            preference_overrides=preference_overrides,
        )
        if eligibility.employment_type == "ineligible":
            detected = detected_employment_types(row.get("employment_type"), text)
            definition = profiles[0].get("definition", {})
            excluded = {
                str(value).casefold().replace("-", "_").replace(" ", "_")
                for value in (definition.get("excluded_employment_types", []) if isinstance(definition, dict) else [])
                if isinstance(value, str)
            }
            blocked_types = sorted(detected & excluded)
            accepted_types = {
                str(value).casefold().replace("-", "_").replace(" ", "_")
                for value in (
                    definition.get("accepted_employment_types", definition.get("employment_types", []))
                    if isinstance(definition, dict) else []
                )
                if isinstance(value, str)
            }
            if accepted_types and not detected & accepted_types:
                blocked_types = sorted(set(blocked_types) | detected)
            if len(blocked_types) == 1:
                employment_type = blocked_types[0]
                digest = manual_jd_sha256(text)
                detected_in_jd = employment_type in detected_employment_types(None, text)
                decision = employment_type_decision
                if decision is None:
                    try:
                        saved = client.get_json("/rest/v1/user_job_employment_type_verifications?" + urlencode({
                            "select": "user_id,job_id,employment_type,decision,jd_sha256",
                            "user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}", "limit": "2",
                        }))
                    except PersistenceError as exc:
                        message = str(exc).lower()
                        if "user_job_employment_type_verifications" not in message or not any(code in message for code in ("pgrst205", "42p01", "404")):
                            raise ManualJDOperationError("Could not load the saved employment-type decision.", jd_saved=False) from exc
                        saved = []
                    if isinstance(saved, list) and len(saved) == 1:
                        item = saved[0]
                        if item.get("user_id") == user_id and item.get("job_id") == job_id and item.get("jd_sha256") == digest and item.get("employment_type") == employment_type:
                            if item.get("decision") == "accepted":
                                decision = {"employment_type": employment_type, "decision": "accepted"}
                if decision is None:
                    raise ManualEmploymentTypeDecisionRequired(employment_type, eligibility.employment_type_reason, digest, detected_in_jd=detected_in_jd)
                if not isinstance(decision, dict) or (
                    decision.get("employment_type") != employment_type
                    or decision.get("decision") not in {"accepted", "rejected"}
                    or (employment_type_decision is not None and decision.get("jd_sha256") != digest)
                ):
                    raise ManualEmploymentTypeDecisionRequired(employment_type, eligibility.employment_type_reason, digest, detected_in_jd=detected_in_jd)
                if decision["decision"] == "rejected":
                    save_employment_type_decision(
                        client, user_id=user_id, job_id=job_id, employment_type=employment_type,
                        decision="rejected", jd_sha256=digest,
                    )
                    return {"declined": True}
                eligibility = assess_discovered_job(
                    title=effective_metadata.title,
                    location=row.get("location"),
                    remote_scope=row.get("remote_scope"),
                    description=text,
                    profile=profiles[0],
                    employment_type=row.get("employment_type"),
                    description_kind="full",
                    verified_location_status=location_rows[0]["location_status"] if location_rows else None,
                    verified_employment_type_status="accepted",
                    verified_employment_type=employment_type,
                    preference_overrides=preference_overrides,
                )
                if not eligibility.actionable:
                    raise ManualJDOperationError(
                        f"This discovered listing is not eligible for Fit: {eligibility.reason}. No JD or assessment was saved.",
                        jd_saved=False,
                    )
                if employment_type_decision is not None:
                    save_employment_type_decision(
                        client, user_id=user_id, job_id=job_id, employment_type=employment_type,
                        decision="accepted", jd_sha256=digest,
                    )
        if not eligibility.actionable:
            raise ManualJDOperationError(
                f"This discovered listing is not eligible for Fit: {eligibility.reason}. No JD or assessment was saved.",
                jd_saved=False,
            )
    if row.get("description") != text or row.get("description_kind") != "full":
        try:
            client.json_request(
                "PATCH",
                f"/rest/v1/jobs?id=eq.{job_id}",
                {"description": text, "description_kind": "full"},
                prefer="return=minimal",
            )
        except Exception as exc:
            raise ManualJDOperationError(f"Could not save the job description: {exc}", jd_saved=False) from exc

    try:
        profile = _active_profile(
            client,
            user_id=user_id,
            cv_version_id=cv_version_id,
            profile_id=candidate_profile_id,
        )
        source_url = row.get("source_url") or row.get("application_url")
        # A manually supplied JD is sufficient for Fit. Legacy manual-history
        # rows may have no external listing URL, so use an internal stable
        # reference without presenting it as a link or inventing a destination.
        source_url = source_url or f"manual://job/{job_id}"
        job = VerifiedJob(
            title=effective_metadata.title,
            company=effective_metadata.company,
            description=text,
            source_url=source_url,
            location=row.get("location"),
            remote_scope=row.get("remote_scope"),
        )
        fingerprint = evaluation_fingerprint(
            candidate_profile=profile,
            job=job,
            matcher_version=HOLISTIC_MATCHER_VERSION,
            model=model,
        )
        cached = get_by_fingerprint(client, user_id=user_id, evaluation_fingerprint=fingerprint)
        if cached is not None:
            return {
                "fit_assessment_id": int(cached["id"]),
                "fit_fingerprint": fingerprint,
                "fit_score": int(cached["fit_score"]),
                "strengths": list(cached.get("strengths", [])),
                "gaps": list(cached.get("gaps", [])),
                "cache_hit": True,
                "created": False,
            }

        evaluator = ai_client or OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        output = evaluate_holistic_match(
            candidate_profile=profile,
            job=job,
            client=evaluator,
            model=model,
        )
        snapshot = {
            "title": job.title,
            "company": job.company,
            "source_title": row.get("title"),
            "source_company": row.get("company"),
            "description": job.description,
            "source_url": job.source_url,
            "application_url": row.get("application_url"),
            "location": job.location,
            "remote_scope": job.remote_scope,
            "description_sha256": job.description_sha256,
            "description_kind": "full",
            "source": row.get("source"),
        }
        saved, created = persist_fit(
            client,
            FitCacheRecord(
                user_id=user_id,
                job_id=job_id,
                candidate_profile_id=candidate_profile_id,
                evaluation_fingerprint=fingerprint,
                jd_sha256=job.description_sha256,
                job_snapshot=snapshot,
                fit_score=output.fit_score,
                strengths=output.strengths,
                gaps=output.gaps,
                matcher_version=HOLISTIC_MATCHER_VERSION,
                model=model,
            ),
        )
        return {
            "fit_assessment_id": int(saved["id"]),
            "fit_fingerprint": fingerprint,
            "fit_score": int(saved["fit_score"]),
            "strengths": list(saved.get("strengths", [])),
            "gaps": list(saved.get("gaps", [])),
            "cache_hit": False,
            "created": created,
        }
    except Exception as exc:
        raise ManualJDOperationError(f"Rating failed after saving the JD: {exc}", jd_saved=True) from exc
