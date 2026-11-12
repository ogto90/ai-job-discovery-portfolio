"""Offline planning boundary between discovery and holistic matching.

This module decides which verified jobs are reusable, need AI, or must be
discarded before matching. It intentionally does not call OpenAI or Supabase.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .candidate_profile import CandidateProfile
from .holistic_matcher import (
    DEFAULT_MODEL,
    HOLISTIC_MATCHER_VERSION,
    VerifiedJob,
    evaluation_fingerprint,
)
from .job_eligibility import assess_discovered_job
from .search_profile import SearchProfile


class MatchPlanAction(StrEnum):
    REUSE = "reuse"
    EVALUATE = "evaluate"
    SKIP = "skip"


class VerifiedDiscoveredJob(BaseModel):
    """A discovered job after live verification, before AI matching."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    job_id: int = Field(gt=0)
    title: str = Field(min_length=1)
    company: str = Field(min_length=1)
    description: str = Field(min_length=1)
    source_url: str = Field(min_length=1)
    location: str | None = None
    remote_scope: str | None = None
    employment_type: str | None = None
    description_sha256: str | None = None
    description_kind: Literal["full"] = "full"
    availability_status: Literal["active", "unknown", "expired", "validation_failed"] = "active"
    verification_status: Literal["verified", "pending", "failed"] = "verified"
    application_status: Literal["new", "applied", "rejected", "ignored"] = "new"
    manual: bool = False

    def as_verified_job(self) -> VerifiedJob:
        return VerifiedJob(
            title=self.title,
            company=self.company,
            description=self.description,
            source_url=self.source_url,
            location=self.location,
        remote_scope=self.remote_scope,
            description_sha256=self.description_sha256,
        )


class JobMatchPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: int = Field(gt=0)
    action: MatchPlanAction
    evaluation_fingerprint: str | None = None
    existing_assessment_id: int | None = None
    skip_reason: str | None = None


class MatchPlanSummary(BaseModel):
    jobs_received: int = 0
    skipped_before_matching: int = 0
    cached_reused: int = 0
    needs_ai: int = 0


class MatchPlanBatch(BaseModel):
    plans: list[JobMatchPlan] = Field(default_factory=list)
    summary: MatchPlanSummary


CacheLookup = Callable[[str, str], dict[str, Any] | None]


def _light_filter_reason(job: VerifiedDiscoveredJob, profile: SearchProfile) -> str | None:
    if job.manual:
        return None
    eligibility = assess_discovered_job(
        title=job.title,
        location=job.location,
        remote_scope=job.remote_scope,
        description=job.description,
        profile=profile.model_dump(mode="json"),
        manual=job.manual,
        employment_type=job.employment_type,
        description_kind=job.description_kind,
    )
    if eligibility.role == "excluded":
        return "excluded_by_search_profile"
    if eligibility.role == "unrelated":
        return "unrelated_to_search_profile"
    if eligibility.role == "unclear":
        return "role_unclear"
    if eligibility.location == "ineligible":
        return "location_ineligible"
    if eligibility.location == "unclear":
        return "location_unclear"
    if eligibility.language == "ineligible":
        return "language_ineligible"
    if eligibility.employment_type == "ineligible":
        return "employment_type_ineligible"
    if eligibility.seniority == "ineligible":
        return "seniority_ineligible"
    return None


def _lifecycle_skip_reason(job: VerifiedDiscoveredJob) -> str | None:
    if job.application_status in {"applied", "rejected", "ignored"}:
        return f"{job.application_status}_history"
    if job.availability_status == "expired":
        return "expired"
    if job.availability_status == "validation_failed":
        return "validation_failed"
    if job.verification_status in {"pending", "failed"}:
        return f"verification_{job.verification_status}"
    if job.availability_status != "active":
        return "availability_not_confirmed"
    return None


def plan_holistic_matches(
    *,
    user_id: str,
    candidate_profile_id: int,
    candidate_profile: CandidateProfile,
    search_profile: SearchProfile,
    jobs: Iterable[VerifiedDiscoveredJob],
    cache_lookup: CacheLookup,
    matcher_version: str = HOLISTIC_MATCHER_VERSION,
    model: str = DEFAULT_MODEL,
) -> MatchPlanBatch:
    """Plan a batch without invoking the matcher.

    ``cache_lookup`` is called only after filtering, suppression, and live
    verification. Its contract is ``(user_id, evaluation_fingerprint)``.
    """

    plans: list[JobMatchPlan] = []
    received = 0
    skipped = reused = needs_ai = 0
    for job in jobs:
        received += 1
        reason = _light_filter_reason(job, search_profile) or _lifecycle_skip_reason(job)
        if reason:
            plans.append(JobMatchPlan(job_id=job.job_id, action=MatchPlanAction.SKIP, skip_reason=reason))
            skipped += 1
            continue

        verified = job.as_verified_job()
        fingerprint = evaluation_fingerprint(
            candidate_profile=candidate_profile,
            job=verified,
            matcher_version=matcher_version,
            model=model,
        )
        existing = cache_lookup(user_id, fingerprint)
        if existing is not None:
            plans.append(
                JobMatchPlan(
                    job_id=job.job_id,
                    action=MatchPlanAction.REUSE,
                    evaluation_fingerprint=fingerprint,
                    existing_assessment_id=int(existing["id"]),
                )
            )
            reused += 1
        else:
            plans.append(
                JobMatchPlan(
                    job_id=job.job_id,
                    action=MatchPlanAction.EVALUATE,
                    evaluation_fingerprint=fingerprint,
                )
            )
            needs_ai += 1

    return MatchPlanBatch(
        plans=plans,
        summary=MatchPlanSummary(
            jobs_received=received,
            skipped_before_matching=skipped,
            cached_reused=reused,
            needs_ai=needs_ai,
        ),
    )
