"""Read-only data shaping for the local Jobs dashboard.

The functions in this module are deliberately independent of Streamlit so the
dashboard's joins, filtering, and ordering can be tested without a browser or
Supabase connection.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
import hashlib
import re
from typing import Any, Iterable

from matching.job_eligibility import assess_discovered_job, detected_employment_types
from matching.job_description import classify_job_description
from matching.job_metadata_overrides import (
    effective_metadata_issues,
    resolve_effective_job_metadata,
)
from matching.tailored_cv_expiration import artifacts_available
from matching.application_lifecycle import CLOSED_STATES, lifecycle_state


ACTIVE_MATCHER_VERSION = "holistic_fit_v1"

RATING_GROUPS: tuple[tuple[str, int | None, int | None], ...] = (
    ("90–100", 90, 100),
    ("80–89", 80, 89),
    ("70–79", 70, 79),
    ("60–69", 60, 69),
    ("50–59", 50, 59),
    ("Under 50", 0, 49),
    ("JD required", None, None),
)


def job_pdf_filename(company: str | None, title: str | None) -> str:
    """Build a concise, filesystem-safe download name from job metadata."""
    parts = [re.sub(r"\s+", " ", value or "").strip() for value in (company, title)]
    stem = " - ".join(part for part in parts if part)
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", stem).strip(" .-")
    return f"{stem or 'resume'}.pdf"


@dataclass(frozen=True)
class DashboardJob:
    id: int
    source: str | None
    company: str
    title: str
    location: str | None
    remote_scope: str | None
    source_url: str | None
    application_url: str | None
    availability_status: str
    verification_status: str | None
    review_status: str
    posted_at: str | None
    first_seen_at: str | None
    last_seen_at: str | None
    fit_score: int | None
    fit_assessment_id: int | None
    historical_fit_score: int | None = None
    historical_fit_assessment_id: int | None = None
    previous_profile_rating: bool = False
    fit_assessment_job_id: int | None = None
    fit_job_snapshot: dict[str, Any] | None = None
    source_company: str | None = None
    source_title: str | None = None
    metadata_override: dict[str, Any] | None = None
    source_metadata_quality_issues: tuple[str, ...] = ()
    user_verification_status: str | None = None
    user_verification_reason: str | None = None
    verified_work_model: str | None = None
    work_model_checked_at: str | None = None
    verified_language_status: str | None = None
    verified_location_status: str | None = None
    verified_employment_type: str | None = None
    employment_type_decision: str | None = None
    preference_override_fields: tuple[str, ...] = ()
    preference_override_at: str | None = None
    location_checked_at: str | None = None
    application_status: str | None = None
    applied_at: str | None = None
    interview_at: str | None = None
    offer_at: str | None = None
    hired_at: str | None = None
    rejected_at: str | None = None
    withdrawn_at: str | None = None
    status_changed_at: str | None = None
    fit_fingerprint: str | None = None
    existing_fit_assessment_status: str = "none"
    stale_fit_assessment_id: int | None = None
    fit_attempt_failed: bool = False
    employment_type: str | None = None
    duplicate_review_status: str | None = None
    duplicate_review_decision: str | None = None
    duplicate_review_matched_job_id: int | None = None
    duplicate_match_job_id: int | None = None
    duplicate_match_company: str | None = None
    duplicate_match_title: str | None = None
    duplicate_match_status: str | None = None
    duplicate_match_updated_at: str | None = None
    fit_strengths: tuple[str, ...] = ()
    fit_gaps: tuple[str, ...] = ()
    tailored_cv_id: int | None = None
    tailored_cv_bucket: str | None = None
    tailored_tex_path: str | None = None
    tailored_pdf_path: str | None = None
    tailored_expires_at: str | None = None
    tailored_artifacts_deleted_at: str | None = None
    description: str | None = None
    description_kind: str = "missing"
    is_manual: bool = False
    role_eligibility: str = "unclear"
    location_eligibility: str = "unclear"
    work_model_eligibility: str = "eligible"
    language_eligibility: str = "eligible"
    employment_type_eligibility: str = "eligible"
    seniority_eligibility: str = "eligible"
    eligibility_reason: str = "SearchProfile eligibility was not evaluated"
    role_reason: str = ""
    location_reason: str = ""
    work_model_reason: str = ""
    language_reason: str = ""
    employment_type_reason: str = ""
    seniority_reason: str = ""
    metadata_quality_issues: tuple[str, ...] = ()
    description_available: bool | None = None
    summary_backed: bool = False

    @property
    def actionable(self) -> bool:
        if self.duplicate_review_status in {"pending", "same_listing"}:
            return False
        if self.metadata_quality_issues:
            return False
        if self.is_manual:
            return True
        return (
            self.role_eligibility == "target_match"
            and self.location_eligibility == "eligible"
            and self.employment_type_eligibility == "eligible"
            and self.seniority_eligibility == "eligible"
        )

    @property
    def live_for_user(self) -> bool:
        if self.availability_status == "expired":
            return False
        if self.user_verification_status == "confirmed_live":
            return True
        if self.user_verification_status in {"confirmed_closed", "unable_to_verify"}:
            return False
        return self.availability_status == "active"

    @property
    def direct_url(self) -> str | None:
        return self.application_url or self.source_url

    @property
    def scored(self) -> bool:
        return self.fit_score is not None

    @property
    def displayed_fit_score(self) -> int | None:
        return self.fit_score if self.fit_score is not None else self.historical_fit_score

    @property
    def has_fit_history(self) -> bool:
        return self.displayed_fit_score is not None

    @property
    def lifecycle_status(self) -> str:
        return self.review_status

    @property
    def metadata_unresolved(self) -> bool:
        return bool(self.metadata_quality_issues)

    @property
    def pending_category(self) -> str | None:
        return pending_category(self)

    @property
    def decision(self) -> "DashboardDecision":
        return dashboard_decision(self)

    @property
    def pending_reason(self) -> str | None:
        return pending_reason(self)

    @property
    def jd_required(self) -> bool:
        return (
            not (self.scored or self.previous_profile_rating)
            and self.description_kind != "full"
            and self.live_for_user
            and self.actionable
            and self.review_status not in CLOSED_STATES | {"applied", "interview", "offer"}
        )

    @property
    def ready_to_rate(self) -> bool:
        return (
            not (self.scored or self.previous_profile_rating)
            and self.description_kind == "full"
            and (bool(self.description) if self.description_available is None else self.description_available)
            and self.live_for_user
            and self.actionable
            and self.review_status not in CLOSED_STATES | {"applied", "interview", "offer"}
            and not self.rating_failed
        )

    @property
    def rating_failed(self) -> bool:
        return self.fit_attempt_failed and not (self.scored or self.previous_profile_rating) and self.ready_eligible

    @property
    def ready_eligible(self) -> bool:
        return (
            self.description_kind == "full"
            and (bool(self.description) if self.description_available is None else self.description_available)
            and self.live_for_user
            and self.actionable
            and self.review_status not in CLOSED_STATES | {"applied", "interview", "offer"}
        )

    @property
    def tailored_artifact_available(self) -> bool:
        return artifacts_available(
            {
                "is_base": False,
                "artifacts_deleted_at": self.tailored_artifacts_deleted_at,
                "expires_at": self.tailored_expires_at,
                "tex_file_path": self.tailored_tex_path,
                "pdf_file_path": self.tailored_pdf_path,
            }
        )


def _timestamp(value: Any) -> datetime:
    if not value:
        return datetime.min
    text = str(value).replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return datetime.min
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


def _latest_by_job(rows: Iterable[dict[str, Any]], *, timestamp_key: str) -> dict[int, dict[str, Any]]:
    latest: dict[int, dict[str, Any]] = {}
    for row in rows:
        try:
            job_id = int(row["job_id"])
        except (KeyError, TypeError, ValueError):
            continue
        previous = latest.get(job_id)
        if previous is None or _timestamp(row.get(timestamp_key)) >= _timestamp(previous.get(timestamp_key)):
            latest[job_id] = row
    return latest


def _latest_by_fingerprint(rows: Iterable[dict[str, Any]], *, timestamp_key: str) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        fingerprint = row.get("evaluation_fingerprint")
        if not isinstance(fingerprint, str) or not fingerprint:
            continue
        previous = latest.get(fingerprint)
        if previous is None or _timestamp(row.get(timestamp_key)) >= _timestamp(previous.get(timestamp_key)):
            latest[fingerprint] = row
    return latest


def _latest_user_status(
    application: dict[str, Any] | None,
    review: dict[str, Any] | None,
    *,
    has_current_fit: bool,
) -> str:
    """Application workflow state takes precedence over pre-application review state."""

    return lifecycle_state(application, review, has_current_fit=has_current_fit)


def merge_dashboard_rows(
    jobs: Iterable[dict[str, Any]],
    applications: Iterable[dict[str, Any]],
    assessments: Iterable[dict[str, Any]],
    reviews: Iterable[dict[str, Any]] = (),
    tailored_versions: Iterable[dict[str, Any]] = (),
    search_profile: dict[str, Any] | None = None,
    current_fit_fingerprints: dict[int, str] | None = None,
    failed_fit_fingerprints: dict[int, str] | None = None,
    user_verifications: Iterable[dict[str, Any]] = (),
    work_model_verifications: Iterable[dict[str, Any]] = (),
    language_verifications: Iterable[dict[str, Any]] = (),
    location_verifications: Iterable[dict[str, Any]] = (),
    employment_type_verifications: Iterable[dict[str, Any]] = (),
    metadata_overrides: dict[int, dict[str, Any]] | None = None,
    classified_description_kinds: dict[int, str] | None = None,
    active_profile_id: int | None = None,
    preference_overrides: Iterable[dict[str, Any]] = (),
) -> list[DashboardJob]:
    """Join jobs with the latest user review and current score-cache row."""

    latest_applications = _latest_by_job(applications, timestamp_key="updated_at")
    latest_reviews = _latest_by_job(reviews, timestamp_key="updated_at")
    latest_verifications = _latest_by_job(user_verifications, timestamp_key="checked_at")
    latest_work_model_verifications = _latest_by_job(
        work_model_verifications, timestamp_key="verified_at"
    )
    latest_language_verifications = _latest_by_job(
        language_verifications, timestamp_key="verified_at"
    )
    latest_location_verifications = _latest_by_job(
        location_verifications, timestamp_key="verified_at"
    )
    latest_employment_type_verifications = _latest_by_job(
        employment_type_verifications, timestamp_key="verified_at"
    )
    latest_preference_overrides = _latest_by_job(preference_overrides, timestamp_key="updated_at")
    matcher_assessments = [
        row for row in assessments
        if row.get("matcher_version", ACTIVE_MATCHER_VERSION) == ACTIVE_MATCHER_VERSION
    ]
    latest_all_assessments = _latest_by_job(
        matcher_assessments,
        timestamp_key="created_at",
    )
    latest_assessments_by_job = _latest_by_job(
        (
            row for row in matcher_assessments
            if current_fit_fingerprints is None
            or row.get("evaluation_fingerprint") == current_fit_fingerprints.get(int(row.get("job_id", 0)))
        ),
        timestamp_key="created_at",
    )
    # Fit identity is candidate + exact job projection + matcher + model, not
    # the global job row ID. Reuse the same cache result for duplicate listings
    # whose current fingerprints are identical.
    latest_assessments_by_fingerprint = (
        _latest_by_fingerprint(matcher_assessments, timestamp_key="created_at")
        if current_fit_fingerprints is not None
        else {}
    )
    latest_tailored = _latest_by_job(tailored_versions, timestamp_key="created_at")
    merged: list[DashboardJob] = []

    for row in jobs:
        try:
            job_id = int(row["id"])
        except (KeyError, TypeError, ValueError):
            continue
        application = latest_applications.get(job_id)
        review = latest_reviews.get(job_id)
        verification = latest_verifications.get(job_id)
        work_model_verification = latest_work_model_verifications.get(job_id)
        language_verification = latest_language_verifications.get(job_id)
        location_verification = latest_location_verifications.get(job_id)
        employment_verification = latest_employment_type_verifications.get(job_id)
        preference_override = latest_preference_overrides.get(job_id)
        preference_override_fields = tuple(sorted(
            set(preference_override.get("overridden_preferences") or [])
            & {"role", "location", "employment_type", "seniority"}
        )) if preference_override and preference_override.get("is_active") else ()
        current_fingerprint = (current_fit_fingerprints or {}).get(job_id)
        assessment = (
            latest_assessments_by_fingerprint.get(current_fingerprint)
            if current_fingerprint is not None and current_fit_fingerprints is not None
            else latest_assessments_by_job.get(job_id)
        )
        latest_assessment = latest_all_assessments.get(job_id)
        existing_assessment_status = "current" if assessment is not None else ("stale" if latest_assessment else "none")
        stale_assessment_id = int(latest_assessment["id"]) if assessment is None and latest_assessment and latest_assessment.get("id") else None
        tailored = latest_tailored.get(job_id)
        fit_score = assessment.get("fit_score") if assessment else None
        try:
            fit_score = int(fit_score) if fit_score is not None else None
        except (TypeError, ValueError):
            fit_score = None
        historical_fit_score = None
        if assessment is None and latest_assessment is not None:
            try:
                historical_fit_score = int(latest_assessment.get("fit_score"))
            except (TypeError, ValueError):
                historical_fit_score = None
        previous_profile_rating = bool(
            historical_fit_score is not None and active_profile_id is not None
            and latest_assessment is not None
            and latest_assessment.get("candidate_profile_id") is not None
            and str(latest_assessment["candidate_profile_id"]) != str(active_profile_id)
        )
        is_manual = row.get("source") == "manual"
        source_company = row.get("company") if isinstance(row.get("company"), str) else ""
        source_title = row.get("title") if isinstance(row.get("title"), str) else ""
        override = (metadata_overrides or {}).get(job_id)
        effective_metadata = resolve_effective_job_metadata(source_company, source_title, override)
        metadata_quality_issues, source_metadata_quality_issues = effective_metadata_issues(
            effective_metadata, is_manual=is_manual
        )
        description = row.get("description")
        description_kind = (classified_description_kinds or {}).get(job_id) or classify_job_description(
            description, str(row.get("description_kind") or "missing")
        )
        employment_decision_matches = (
            isinstance(description, str)
            and isinstance(employment_verification, dict)
            and employment_verification.get("jd_sha256") == hashlib.sha256(description.encode("utf-8")).hexdigest()
            and employment_verification.get("employment_type") in detected_employment_types(row.get("employment_type"), description)
        )
        eligibility = assess_discovered_job(
            title=effective_metadata.title,
            location=row.get("location"),
            remote_scope=row.get("remote_scope"),
            description=description,
            profile=search_profile,
            manual=is_manual,
            employment_type=row.get("employment_type"),
            description_kind=description_kind,
            verified_work_model=(work_model_verification or {}).get("work_model"),
            verified_language=(language_verification or {}).get("language_status"),
            verified_location_status=(location_verification or {}).get("location_status"),
            verified_employment_type_status=(employment_verification or {}).get("decision") if employment_decision_matches else None,
            verified_employment_type=(employment_verification or {}).get("employment_type") if employment_decision_matches else None,
            preference_overrides=preference_override_fields,
        )
        merged.append(
            DashboardJob(
                id=job_id,
                source=row.get("source"),
                company=effective_metadata.company,
                title=effective_metadata.title,
                location=row.get("location"),
                remote_scope=row.get("remote_scope"),
                employment_type=row.get("employment_type"),
                source_url=row.get("source_url"),
                application_url=row.get("application_url"),
                availability_status=str(row.get("availability_status") or "unknown"),
                verification_status=None,
                user_verification_status=verification.get("verification_status") if verification else None,
                user_verification_reason=verification.get("verification_reason") if verification else None,
                verified_work_model=work_model_verification.get("work_model") if work_model_verification else None,
                work_model_checked_at=work_model_verification.get("verified_at") if work_model_verification else None,
                verified_language_status=language_verification.get("language_status") if language_verification else None,
                verified_location_status=location_verification.get("location_status") if location_verification else None,
                verified_employment_type=(employment_verification.get("employment_type") if employment_decision_matches else None),
                employment_type_decision=(employment_verification.get("decision") if employment_decision_matches else None),
                preference_override_fields=preference_override_fields,
                preference_override_at=preference_override.get("updated_at") if preference_override_fields and preference_override else None,
                location_checked_at=location_verification.get("verified_at") if location_verification else None,
                application_status=application.get("status") if application else None,
                applied_at=application.get("applied_at") if application else None,
                interview_at=application.get("interview_at") if application else None,
                offer_at=application.get("offer_at") if application else None,
                hired_at=application.get("hired_at") if application else None,
                rejected_at=application.get("rejected_at") if application else None,
                withdrawn_at=application.get("withdrawn_at") if application else None,
                status_changed_at=application.get("status_changed_at") if application else None,
                review_status=_latest_user_status(application, review, has_current_fit=fit_score is not None or previous_profile_rating),
                posted_at=row.get("posted_at"),
                first_seen_at=row.get("first_seen_at"),
                last_seen_at=row.get("last_seen_at"),
                fit_score=fit_score,
                fit_assessment_id=int(assessment["id"]) if assessment and assessment.get("id") else None,
                historical_fit_score=historical_fit_score,
                previous_profile_rating=previous_profile_rating,
                historical_fit_assessment_id=(
                    int(latest_assessment["id"])
                    if historical_fit_score is not None and latest_assessment and latest_assessment.get("id")
                    else None
                ),
                fit_assessment_job_id=int(assessment["job_id"]) if assessment and assessment.get("job_id") else None,
                fit_job_snapshot=assessment.get("job_snapshot") if assessment and isinstance(assessment.get("job_snapshot"), dict) else None,
                source_company=source_company,
                source_title=source_title,
                metadata_override=override,
                source_metadata_quality_issues=source_metadata_quality_issues,
                fit_fingerprint=current_fingerprint,
                existing_fit_assessment_status=existing_assessment_status,
                stale_fit_assessment_id=stale_assessment_id,
                fit_attempt_failed=(failed_fit_fingerprints or {}).get(job_id) == current_fingerprint and current_fingerprint is not None,
                fit_strengths=tuple(str(item) for item in (assessment or {}).get("strengths", []) if isinstance(item, str)),
                fit_gaps=tuple(str(item) for item in (assessment or {}).get("gaps", []) if isinstance(item, str)),
                tailored_cv_id=int(tailored["id"]) if tailored and tailored.get("id") else None,
                tailored_cv_bucket=tailored.get("storage_bucket") if tailored else None,
                tailored_tex_path=tailored.get("tex_file_path") if tailored and not tailored.get("artifacts_deleted_at") else None,
                tailored_pdf_path=(tailored.get("pdf_file_path") or tailored.get("file_path")) if tailored and not tailored.get("artifacts_deleted_at") else None,
                tailored_expires_at=tailored.get("expires_at") if tailored else None,
                tailored_artifacts_deleted_at=tailored.get("artifacts_deleted_at") if tailored else None,
                description=description,
                description_kind=description_kind,
                is_manual=is_manual,
                metadata_quality_issues=tuple(metadata_quality_issues),
                role_eligibility=eligibility.role,
                location_eligibility=eligibility.location,
                work_model_eligibility=eligibility.work_model,
                language_eligibility=eligibility.language,
                employment_type_eligibility=eligibility.employment_type,
                seniority_eligibility=eligibility.seniority,
                eligibility_reason=eligibility.reason,
                role_reason=eligibility.role_reason,
                location_reason=eligibility.location_reason,
                work_model_reason=eligibility.work_model_reason,
                language_reason=eligibility.language_reason,
                employment_type_reason=eligibility.employment_type_reason,
                seniority_reason=eligibility.seniority_reason,
            )
        )
    return resolve_duplicate_review_matches(merged)


def resolve_duplicate_review_matches(jobs: Iterable[DashboardJob]) -> list[DashboardJob]:
    """Match current rows against handled applications across the supplied full set."""
    merged = list(jobs)
    handled = {"applied", "interview", "offer", "hired", "rejected", "withdrawn", "no_response"}

    def identity(value: str | None) -> str:
        return re.sub(r"[^a-z0-9]+", " ", (value or "").casefold()).strip()

    historical = [job for job in merged if job.application_status in handled]
    result = []
    for job in merged:
        if job.application_status in handled:
            result.append(replace(job, duplicate_review_status=None, duplicate_match_job_id=None,
                                  duplicate_match_company=None, duplicate_match_title=None))
            continue
        matches = [prior for prior in historical if prior.id != job.id
                   and identity(prior.company) == identity(job.company)
                   and identity(prior.title) == identity(job.title)]
        if not matches:
            result.append(job)
            continue
        prior = max(matches, key=lambda item: _timestamp(item.status_changed_at or item.applied_at))
        decision = job.duplicate_review_decision if job.duplicate_review_matched_job_id == prior.id else None
        result.append(replace(job,
            duplicate_review_status=decision if decision in {"same_listing", "different_listing"} else "pending",
            duplicate_match_job_id=prior.id, duplicate_match_company=prior.company,
            duplicate_match_title=prior.title,
            duplicate_match_status=str(prior.application_status or prior.review_status),
            duplicate_match_updated_at=prior.status_changed_at or prior.applied_at))
    return result


def sort_dashboard_jobs(jobs: Iterable[DashboardJob]) -> list[DashboardJob]:
    """Score first, then highest score, then most recently seen."""

    return sorted(
        jobs,
        key=lambda job: (
            job.displayed_fit_score is not None,
            job.displayed_fit_score if job.displayed_fit_score is not None else -1,
            _timestamp(job.last_seen_at),
        ),
        reverse=True,
    )


HANDLED_REVIEW_STATES = {
    "applied", "interview", "offer", "hired", "rejected", "no_response",
    "withdrawn", "ignored", "archived", "closed",
}


@dataclass(frozen=True)
class DashboardDecision:
    state: str
    primary_reason_code: str
    primary_reason_label: str
    primary_reason_detail: str
    secondary_reasons: tuple[str, ...] = ()
    resolvable: bool = False
    recommended_actions: tuple[str, ...] = ()


def dashboard_decision(job: DashboardJob) -> DashboardDecision:
    """Single profile-relative state/reason/action derivation for dashboard rows."""
    handled = job.review_status in HANDLED_REVIEW_STATES
    if job.review_status in {"ignored", "archived"}:
        return DashboardDecision("archive", "archived", "Archived", "You archived this listing.")
    if handled:
        return DashboardDecision("handled", job.review_status, job.review_status.replace("_", " ").title(), "This listing already has a recorded application or review outcome.")

    if job.availability_status == "expired" or job.user_verification_status == "confirmed_closed":
        detail = "The listing was confirmed expired." if job.availability_status == "expired" else (
            f"You checked this listing and marked it closed{': ' + job.user_verification_reason if job.user_verification_reason else '.'}"
        )
        secondary = tuple(reason for reason in _eligibility_secondary_reasons(job) if reason)
        return DashboardDecision("not_actionable", "listing_closed", "Listing expired / closed", detail, secondary, False, ("open_listing",) if job.direct_url else ())
    if job.role_eligibility == "excluded":
        return _definitive_decision(job, "profile_exclusion", "Excluded by your preferences", job.role_reason or job.eligibility_reason)
    if job.role_eligibility == "unrelated":
        return _definitive_decision(job, "outside_target_roles", "Outside your target roles", job.role_reason or job.eligibility_reason)

    # A user's explicit rejection is definitive even when unrelated metadata
    # cleanup is also pending; don't leave a rejected listing in the review queue.
    if job.verified_location_status == "rejected" and "location" not in job.preference_override_fields:
        return _definitive_decision(
            job, "location_incompatible", "Location not compatible",
            job.location_reason or "You marked this location as outside your preferences.",
        )

    # Metadata quality is an input to the Fit identity and actionability. A
    # historical score must not make malformed current metadata look resolved.
    if job.metadata_unresolved:
        details = ", ".join(job.metadata_quality_issues)
        return DashboardDecision(
            "pending", "metadata_unresolved", "Metadata unresolved",
            f"Company/title details need review: {details}." if details else "Company/title details need review.",
            resolvable=True, recommended_actions=("retry_evidence", "ignore"),
        )

    incompatibilities = (
        (job.location_eligibility, "location_incompatible", "Location not compatible", job.location_reason),
        (job.employment_type_eligibility, "employment_type_incompatible", _employment_label(job.employment_type_reason), job.employment_type_reason),
        (job.seniority_eligibility, "seniority_incompatible", "Seniority not compatible", job.seniority_reason),
    )
    incompatible = next((item for item in incompatibilities if item[0] == "ineligible"), None)
    if incompatible:
        _, code, label, detail = incompatible
        return _definitive_decision(job, code, label, detail or job.eligibility_reason)

    if job.scored:
        return DashboardDecision("rated", "fit_available", "AI Fit available", "This job has a current AI Fit score.")

    if job.eligibility_reason in SEARCH_PROFILE_INCOMPLETE_REASONS or job.role_eligibility == "unclear":
        return DashboardDecision("pending", "search_profile_incomplete", "SearchProfile needs review", "The active profile is missing or does not define enough target roles.", resolvable=True, recommended_actions=("review_profile",))
    if job.role_eligibility == "target_adjacent":
        return DashboardDecision("pending", "role_relevance_unclear", "Role relevance unclear", job.role_reason or "The role is adjacent to configured targets.", resolvable=True, recommended_actions=("retry_evidence", "ignore"))

    unclear = next((item for item in incompatibilities if item[0] == "unclear"), None)
    if unclear:
        _, code, label, detail = unclear
        category = {
            "location_incompatible": "Location unclear",
            "employment_type_incompatible": "Employment type unclear",
            "seniority_incompatible": "Seniority unclear",
        }[code]
        if job.user_verification_status in {"confirmed_live", "confirmed_closed", "unable_to_verify"}:
            # Eligibility evidence is still unresolved even if liveness was manually checked.
            pass
        reason_code = code.replace("_incompatible", "_unclear")
        reason_label = category
        if job.availability_status != "active" and job.user_verification_status != "confirmed_live":
            return _verification_decision(job, secondary=(detail or "",))
        if not detail:
            if reason_code == "location_unclear":
                place = job.location or job.remote_scope
                detail = f"The listing names {place}, but its geographic eligibility is unclear." if place else "The listing does not establish a location allowed by the configured preferences."
            elif reason_code == "employment_type_unclear":
                detail = "The listing does not establish an accepted employment type."
            else:
                detail = "The listing does not establish a configured seniority."
        return DashboardDecision("pending", reason_code, reason_label, detail or "The listing does not establish this profile requirement.", resolvable=True, recommended_actions=("retry_evidence", "ignore"))

    if job.user_verification_status == "confirmed_closed":
        return DashboardDecision("not_actionable", "listing_closed", "Listing closed", job.user_verification_reason or "You confirmed this listing is closed.")
    if not job.live_for_user:
        return _verification_decision(job)
    if job.jd_required:
        return DashboardDecision("jd_required", "full_jd_required", "Full job description required", "The listing is actionable, but a complete job description is needed for Fit.", resolvable=True, recommended_actions=("add_jd", "open_listing", "ignore"))
    if job.rating_failed:
        return DashboardDecision("rating_failed", "fit_failed", "AI Fit failed", "The latest Fit attempt failed; retry is available.", resolvable=True, recommended_actions=("retry_rating", "open_listing", "ignore"))
    if job.ready_to_rate:
        return DashboardDecision("ready_to_rate", "ready_for_fit", "Ready to rate", "The listing is eligible and has a full job description.", resolvable=True, recommended_actions=("rate", "open_listing", "ignore"))
    return DashboardDecision("not_actionable", "not_actionable_other", "Not actionable", job.eligibility_reason or "This listing does not currently meet the conditions for review.")


def _eligibility_secondary_reasons(job: DashboardJob) -> tuple[str, ...]:
    reasons = []
    for status, detail in (
        (job.role_eligibility, job.role_reason),
        (job.location_eligibility, job.location_reason),
        (job.employment_type_eligibility, job.employment_type_reason),
        (job.seniority_eligibility, job.seniority_reason),
    ):
        if status in {"ineligible", "unrelated", "excluded", "unclear", "target_adjacent"} and detail:
            reasons.append(detail)
    return tuple(dict.fromkeys(reasons))


def _work_model_label(reason: str) -> str:
    return "Remote requirement not met" if "accepts remote" in reason.casefold() else "Work model not compatible"


def _employment_label(reason: str) -> str:
    return "Contract role excluded" if "contract" in reason.casefold() and "excluded" in reason.casefold() else "Employment type not compatible"


def _definitive_decision(job: DashboardJob, code: str, label: str, detail: str) -> DashboardDecision:
    return DashboardDecision(
        "not_actionable", code, label, detail,
        _eligibility_secondary_reasons(job),
        False,
        ("open_listing", "ignore") if job.direct_url else ("ignore",),
    )


def _verification_decision(job: DashboardJob, secondary: tuple[str, ...] = ()) -> DashboardDecision:
    if job.user_verification_status == "unable_to_verify":
        detail = f"Manual verification could not confirm this exact requisition: {job.user_verification_reason or 'no reason recorded'}."
    else:
        detail = "Not verified: the automatic check could not confirm this exact requisition. Open the listing to check it yourself."
    return DashboardDecision("pending", "verification_needed", "Verification needed", detail, secondary, True, ("retry_verification", "manual_verify", "ignore"))
SEARCH_PROFILE_INCOMPLETE_REASONS = {
    "active SearchProfile is unavailable",
    "SearchProfile targets or role evidence are insufficient",
}


def pending_category(job: DashboardJob) -> str | None:
    """Pending view uses the central decision model."""
    decision = dashboard_decision(job)
    if decision.state != "pending":
        return None
    return decision.primary_reason_label


def pending_reason(job: DashboardJob) -> str | None:
    decision = dashboard_decision(job)
    if decision.state != "pending":
        return None
    if decision.primary_reason_code == "verification_needed" and job.user_verification_status == "unable_to_verify":
        return f"Your manual check could not verify this listing: {job.user_verification_reason}"
    return decision.primary_reason_detail


def can_retry_pending_evidence(job: DashboardJob) -> bool:
    """Whether the existing targeted verifier can do useful work on this row."""
    has_full_jd = job.description_kind == "full" and (
        bool(job.description) if job.description_available is None else job.description_available
    )
    ordinary_retry = (
        job.decision.primary_reason_code in {"verification_needed", "location_unclear", "employment_type_unclear", "seniority_unclear", "role_relevance_unclear", "metadata_unresolved"}
        and job.role_eligibility not in {"unrelated", "excluded"}
        and job.availability_status != "expired"
        and job.user_verification_status is None
        and job.review_status not in HANDLED_REVIEW_STATES
    )
    missing_jd_for_review = (
        job.review_status == "new"
        and job.live_for_user
        and not has_full_jd
        and not (job.scored or job.previous_profile_rating)
        and job.role_eligibility not in {"unrelated", "excluded", "unclear"}
        and not job.metadata_unresolved
        and job.duplicate_review_status != "pending"
        and (
            job.role_eligibility == "target_adjacent"
            or job.location_eligibility in {"unclear", "ineligible"}
            or job.employment_type_eligibility in {"unclear", "ineligible"}
            or job.seniority_eligibility in {"unclear", "ineligible"}
        )
    )
    return ordinary_retry or missing_jd_for_review


def can_archive_job(job: DashboardJob) -> bool:
    """Whether the dashboard currently offers an Archive action for this job."""
    from matching.application_lifecycle import can_archive_state
    return can_archive_state(job.lifecycle_status)


def can_rate_job(job: DashboardJob) -> bool:
    """Whether this job can use the existing score/retry workflow now."""
    from matching.application_lifecycle import can_rate_state
    return can_rate_state(job.lifecycle_status) and (job.ready_to_rate or job.rating_failed)


def can_generate_cv(job: DashboardJob) -> bool:
    from matching.application_lifecycle import can_generate_cv_state
    return can_generate_cv_state(job.lifecycle_status) and job.fit_score is not None


def can_rerate_job(job: DashboardJob) -> bool:
    from matching.application_lifecycle import can_rate_state
    return (
        can_rate_state(job.lifecycle_status)
        and job.actionable and job.live_for_user
        and job.description_kind == "full" and bool(job.description)
    )


def can_select_job(job: DashboardJob) -> bool:
    """Selectable jobs must support at least one bulk action."""
    return can_archive_job(job) or can_rate_job(job)


def group_dashboard_jobs(jobs: Iterable[DashboardJob]) -> list[tuple[str, list[DashboardJob]]]:
    """Group jobs into descending AI-Fit bands for the dashboard layout."""

    rows = [job for job in jobs if job.review_status not in {"ignored", "archived"}]
    groups: list[tuple[str, list[DashboardJob]]] = []
    unresolved_metadata = [job for job in rows if job.decision.primary_reason_code == "metadata_unresolved"]
    if unresolved_metadata:
        groups.append(("Metadata unresolved", sort_dashboard_jobs(unresolved_metadata)))
    review_rows = [job for job in rows if job.review_status in {"new", "rated"}]
    scoreable_rows = [job for job in review_rows if not job.metadata_unresolved and job.decision.state != "not_actionable"]
    for label, lower, upper in RATING_GROUPS:
        if lower is None:
            matched = [job for job in scoreable_rows if job.jd_required]
        else:
            matched = [
                job for job in scoreable_rows
                if job.displayed_fit_score is not None and lower <= job.displayed_fit_score <= upper
            ]
        if matched:
            groups.append((label, sort_dashboard_jobs(matched)))
    failed = [job for job in scoreable_rows if job.rating_failed]
    if failed:
        groups.append(("Rating failed", sort_dashboard_jobs(failed)))
    ready = [job for job in scoreable_rows if job.ready_to_rate and job.historical_fit_score is None]
    if ready:
        groups.append(("Ready to rate", sort_dashboard_jobs(ready)))
    pending = [job for job in scoreable_rows if job.pending_category]
    if pending:
        groups.append(("Pending / unresolved", sort_dashboard_jobs(pending)))
    return groups


def group_needs_attention_jobs(jobs: Iterable[DashboardJob]) -> list[tuple[str, list[DashboardJob]]]:
    """Keep the familiar fit bands while ensuring every queued row is rendered once."""
    rows = list(jobs)
    grouped = group_dashboard_jobs(rows)
    seen: set[int] = set()
    disjoint: list[tuple[str, list[DashboardJob]]] = []
    for label, members in grouped:
        unique_members = [job for job in members if job.id not in seen]
        seen.update(job.id for job in unique_members)
        if unique_members:
            disjoint.append((label, unique_members))
    remaining = [job for job in rows if job.id not in seen]
    if remaining:
        disjoint.append(("Other listings", sort_dashboard_jobs(remaining)))
    return disjoint


def group_application_jobs(jobs: Iterable[DashboardJob]) -> list[tuple[str, list[DashboardJob]]]:
    """Group application records by their current stage."""
    rows = list(jobs)
    groups: list[tuple[str, list[DashboardJob]]] = []
    for state, label in (
        ("applied", "Applied"),
        ("interview", "Interview"),
        ("offer", "Offer"),
    ):
        matched = [job for job in rows if job.review_status == state]
        if matched:
            groups.append((label, sort_dashboard_jobs(matched)))
    closed = [job for job in rows if job.review_status in {"hired", "rejected", "withdrawn", "no_response"}]
    if closed:
        groups.append(("Closed applications", sort_dashboard_jobs(closed)))
    return groups


def application_view_jobs(jobs: Iterable[DashboardJob]) -> list[DashboardJob]:
    """Use application records as the source of truth in the Applications page."""
    valid_states = {"applied", "interview", "offer", "hired", "rejected", "withdrawn", "no_response"}
    return [
        replace(job, review_status=job.application_status)
        for job in jobs
        if job.application_status in valid_states
    ]


def group_archive_jobs(jobs: Iterable[DashboardJob]) -> list[tuple[str, list[DashboardJob]]]:
    """Group archived user decisions and profile-ineligible jobs separately."""
    rows = [job for job in jobs if job.application_status is None]
    ignored = [job for job in rows if job.review_status == "ignored"]
    archived = [job for job in rows if job.review_status == "archived"]
    preference_mismatches = [
        job for job in rows
        if job.review_status not in {"ignored", "archived"} and _is_preference_mismatch(job)
    ]
    not_actionable = [
        job for job in rows
        if job.review_status not in {"ignored", "archived"} and job.decision.state == "not_actionable" and not _is_preference_mismatch(job)
    ]
    groups: list[tuple[str, list[DashboardJob]]] = []
    if ignored or archived:
        groups.append(("Archived", sort_dashboard_jobs([*ignored, *archived])))
    if preference_mismatches:
        groups.append(("Preference mismatches", sort_dashboard_jobs(preference_mismatches)))
    if not_actionable:
        groups.append(("Not actionable", sort_dashboard_jobs(not_actionable)))
    return groups


def paginate_job_groups(
    groups: Iterable[tuple[str, list[DashboardJob]]], *, page: int, page_size: int
) -> tuple[list[tuple[str, list[DashboardJob]]], int, int, int]:
    """Return one page across grouped jobs, preserving group order."""
    if page < 1 or page_size < 1:
        raise ValueError("page and page_size must be positive")
    grouped = list(groups)
    total = sum(len(rows) for _, rows in grouped)
    start = (page - 1) * page_size
    end = min(start + page_size, total)
    if start >= total:
        return [], total, 0, 0
    paged: list[tuple[str, list[DashboardJob]]] = []
    cursor = 0
    for label, rows in grouped:
        group_start, group_end = cursor, cursor + len(rows)
        cursor = group_end
        selected_start = max(start, group_start)
        selected_end = min(end, group_end)
        if selected_start < selected_end:
            paged.append((label, rows[selected_start - group_start:selected_end - group_start]))
    return paged, total, start + 1, end


PREFERENCE_MISMATCH_CODES = {
    "location_incompatible",
    "employment_type_incompatible",
    "seniority_incompatible",
}


def _is_preference_mismatch(job: DashboardJob) -> bool:
    return job.decision.state == "not_actionable" and job.decision.primary_reason_code in PREFERENCE_MISMATCH_CODES


def _has_reviewable_mismatch(job: DashboardJob) -> bool:
    if job.review_status != "new" or job.duplicate_review_status == "pending":
        return False
    return (
        job.role_eligibility == "target_adjacent"
        or job.location_eligibility == "unclear"
        or job.employment_type_eligibility == "unclear"
        or job.seniority_eligibility == "unclear"
    )


def filter_dashboard_jobs(
    jobs: Iterable[DashboardJob],
    *,
    search: str = "",
    review_status: str = "Unaddressed",
    score_state: str = "All",
    minimum_fit: int = 0,
    work_model: str = "All",
    pending_category_filter: str = "All unresolved",
    archive_category_filter: str = "All",
) -> list[DashboardJob]:
    """Apply local dashboard filters, hiding unhandled, definitively irrelevant roles."""

    needle = search.strip().casefold()
    result: list[DashboardJob] = []
    for job in jobs:
        if (
            not job.is_manual
            and job.role_eligibility in {"unrelated", "excluded"}
            and job.review_status not in HANDLED_REVIEW_STATES
            and review_status != "Archive"
        ):
            continue
        if needle and needle not in f"{job.company} {job.title}".casefold():
            continue
        if not _matches_review_filter(job, review_status):
            continue
        if review_status == "Pending / unresolved" and pending_category_filter != "All unresolved" and job.pending_category != pending_category_filter:
            continue
        if review_status == "Archive":
            if archive_category_filter == "Archived" and job.review_status not in {"ignored", "archived"}:
                continue
            if archive_category_filter == "Preference mismatches" and not _is_preference_mismatch(job):
                continue
            if archive_category_filter == "Not actionable" and (job.decision.state != "not_actionable" or _is_preference_mismatch(job)):
                continue
        if score_state == "Scored" and not job.has_fit_history:
            continue
        if score_state == "Unscored" and job.scored:
            continue
        if score_state == "JD required" and not job.jd_required:
            continue
        if score_state == "Rating failed" and not job.rating_failed:
            continue
        if score_state == "Ready to rate" and not job.ready_to_rate:
            continue
        if job.displayed_fit_score is not None and job.displayed_fit_score < minimum_fit:
            continue
        if work_model != "All" and not _matches_work_model(job, work_model):
            continue
        result.append(job)
    return result


def _matches_review_filter(job: DashboardJob, requested: str) -> bool:
    if requested == "All":
        return (
            job.review_status not in CLOSED_STATES | {"applied", "interview", "offer"}
            and job.decision.state != "not_actionable"
        )
    if requested == "Applications":
        return job.review_status in {"applied", "interview", "offer", "hired", "rejected", "withdrawn", "no_response"}
    if requested == "Unaddressed":
        return (
            job.actionable
            and job.live_for_user
            and job.review_status not in CLOSED_STATES | {"applied", "interview", "offer"}
        )
    if requested == "Needs attention":
        # This view is a queue of genuinely new, unaddressed listings. A
        # saved Fit, application outcome, dismissal, or archive moves the job
        # out of this queue; preference mismatches belong in Archive.
        if job.review_status != "new":
            return False
        if job.duplicate_review_status == "pending":
            return True
        return (
            job.live_for_user
            and not job.ready_to_rate
            and (job.actionable or job.decision.state == "pending" or _has_reviewable_mismatch(job))
        )
    if requested == "Pending / unresolved":
        return job.pending_category is not None
    if requested == "New":
        return job.review_status == "new"
    if requested == "Ready to rate":
        return job.ready_to_rate
    if requested == "Rated":
        return job.review_status == "rated"
    if requested in {"Applied", "Interview", "Offer", "Hired", "Rejected", "Withdrawn"}:
        return job.review_status == requested.lower()
    if requested == "Active applications":
        return job.review_status in {"applied", "interview", "offer"}
    if requested == "Closed":
        return job.review_status in {"rejected", "withdrawn", "hired", "no_response"}
    if requested == "Archive":
        return job.application_status is None and (
            job.review_status in {"ignored", "archived"} or dashboard_decision(job).state == "not_actionable"
        )
    if requested == "Rejected / Closed":
        return job.review_status in {"rejected", "no_response", "withdrawn", "hired", "closed"}
    return job.review_status == requested


def _matches_work_model(job: DashboardJob, requested: str) -> bool:
    text = f"{job.remote_scope or ''} {job.location or ''}".casefold()
    if requested == "Unknown":
        return not text.strip()
    if requested == "Remote":
        return "remote" in text
    if requested == "Hybrid":
        return "hybrid" in text
    if requested == "On-site":
        return "onsite" in text or "on-site" in text or "on site" in text
    return True


def dashboard_summary(jobs: Iterable[DashboardJob]) -> dict[str, int]:
    rows = list(jobs)
    return {
        "total": len(rows),
        "scored": sum(job.scored for job in rows),
        "new": sum(job.review_status == "new" for job in rows),
        "seen": sum(job.review_status != "new" for job in rows),
        "metadata_unresolved": sum(job.metadata_unresolved for job in rows),
    }
