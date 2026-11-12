"""Conservative, provenance-backed candidate evidence schema.

This module deliberately models evidence strength rather than treating a CV as a
bag of skills. OpenAI extraction, matching, and persistence layers should consume
this model instead of inventing stronger claims from raw text.
"""

from __future__ import annotations

import json
from datetime import date
from enum import IntEnum, StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


CURRENT_CANDIDATE_PROFILE_SCHEMA_VERSION = "2.0"


class EvidenceLevel(IntEnum):
    """Strength of evidence, from no evidence to owned production work."""

    NONE = 0
    WEAK = 1
    EXPOSURE = 2
    DIRECT_PRODUCTION = 3
    OWNED_PRODUCTION = 4


class EvidenceType(StrEnum):
    PRODUCTION_OWNERSHIP = "production_ownership"
    PRODUCTION_HANDS_ON = "production_hands_on"
    PRACTICAL_EXPOSURE = "practical_exposure"
    EVALUATION_OR_POC = "evaluation_or_poc"
    SKILLS_ONLY = "skills_only"
    FUNDAMENTALS = "fundamentals"
    HISTORICAL_EXPOSURE = "historical_exposure"
    TRANSFERABLE = "transferable"


class EvidenceOrigin(StrEnum):
    WORK_HISTORY = "work_history"
    SUMMARY = "summary"
    SKILLS = "skills"
    EDUCATION = "education"
    CERTIFICATION = "certification"


class DateRange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: date | None = None
    end: date | None = None

    @model_validator(mode="after")
    def dates_are_ordered(self) -> "DateRange":
        if self.start and self.end and self.end < self.start:
            raise ValueError("date range end cannot precede start")
        return self


class EvidenceItem(BaseModel):
    """A traceable claim copied or closely paraphrased from the CV."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    source_section: str = Field(min_length=1)
    origin: EvidenceOrigin
    employer: str | None = None
    role: str | None = None
    date_range: DateRange | None = None
    cv_text: str = Field(min_length=1)
    evidence_type: EvidenceType


class Capability(BaseModel):
    """A normalized capability whose strength is constrained by its evidence."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    normalized_name: str = Field(min_length=1)
    category: str = Field(min_length=1)
    evidence_level: EvidenceLevel
    evidence_type: EvidenceType
    professional_experience: bool = False
    ownership: bool = False
    current_or_recent: bool = False
    date_range: DateRange | None = None
    years_supported: float | None = Field(default=None, ge=0)
    tools: list[str] = Field(default_factory=list)
    evidence_refs: list[str] = Field(default_factory=list)
    notes: str | None = None

    @model_validator(mode="after")
    def enforce_conservative_evidence(self) -> "Capability":
        weak_types = {
            EvidenceType.SKILLS_ONLY,
            EvidenceType.FUNDAMENTALS,
            EvidenceType.TRANSFERABLE,
        }
        limited_types = {
            EvidenceType.PRACTICAL_EXPOSURE,
            EvidenceType.EVALUATION_OR_POC,
        }
        production_types = {
            EvidenceType.PRODUCTION_OWNERSHIP,
            EvidenceType.PRODUCTION_HANDS_ON,
            EvidenceType.HISTORICAL_EXPOSURE,
        }

        if self.evidence_level == EvidenceLevel.NONE:
            if self.evidence_refs or self.professional_experience or self.ownership:
                raise ValueError("level 0 capabilities cannot cite or claim evidence")
            return self

        if not self.evidence_refs:
            raise ValueError("positive evidence levels require evidence_refs")
        if self.evidence_type in weak_types:
            if self.evidence_level > EvidenceLevel.WEAK:
                raise ValueError("skills, fundamentals, and transferable evidence cap at level 1")
            if self.professional_experience or self.ownership:
                raise ValueError("weak evidence cannot claim professional experience or ownership")
        if self.evidence_type in limited_types and self.evidence_level > EvidenceLevel.EXPOSURE:
            raise ValueError("exposure and POC evidence cap at level 2")
        if self.professional_experience and self.evidence_type not in production_types:
            raise ValueError("professional experience requires real-work evidence")
        if self.ownership:
            if self.evidence_type != EvidenceType.PRODUCTION_OWNERSHIP:
                raise ValueError("ownership requires production_ownership evidence type")
            if not self.professional_experience:
                raise ValueError("ownership requires professional_experience")
        if self.evidence_level == EvidenceLevel.OWNED_PRODUCTION:
            if not (self.professional_experience and self.ownership):
                raise ValueError("level 4 requires professional experience and ownership")
        if self.years_supported is not None and not self.date_range:
            raise ValueError("years_supported requires an explicit date range")
        return self

    @property
    def production_experience(self) -> bool:
        """Backward-compatible read alias for older callers."""

        return self.professional_experience


class ToolPlatform(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    normalized_name: str = Field(min_length=1)
    evidence_level: EvidenceLevel
    professional_experience: bool = False
    evidence_refs: list[str] = Field(default_factory=list)
    notes: str | None = None

    @model_validator(mode="after")
    def tools_are_not_inflated(self) -> "ToolPlatform":
        if self.evidence_level > EvidenceLevel.WEAK and not self.evidence_refs:
            raise ValueError("tool evidence above level 1 requires provenance references")
        if self.evidence_level <= EvidenceLevel.WEAK and self.professional_experience:
            raise ValueError("weak tool evidence cannot claim professional experience")
        return self

    @property
    def production_experience(self) -> bool:
        """Backward-compatible read alias for older callers."""

        return self.professional_experience


class Education(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    degree: str = Field(min_length=1)
    institution: str = Field(min_length=1)
    date_range: DateRange | None = None
    evidence_refs: list[str] = Field(default_factory=list)


class Certification(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1)
    issuer: str | None = None
    date_obtained: date | None = None
    evidence_refs: list[str] = Field(default_factory=list)


class Language(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    language: str = Field(min_length=1)
    proficiency: str = Field(min_length=1)


class EmploymentHistory(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    employer: str = Field(min_length=1)
    title: str = Field(min_length=1)
    date_range: DateRange | None = None
    location: str | None = None
    evidence_refs: list[str] = Field(default_factory=list)


class CandidateProfile(BaseModel):
    """The structured candidate source of truth for later matching."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    schema_version: str = Field(min_length=1)
    source_cv_version_id: int = Field(gt=0)
    summary: str = Field(min_length=1)
    total_professional_experience_years: float | None = Field(default=None, ge=0)
    current_role: str = Field(min_length=1)
    seniority: str = Field(min_length=1)
    education: list[Education] = Field(default_factory=list)
    certifications: list[Certification] = Field(default_factory=list)
    languages: list[Language] = Field(default_factory=list)
    roles: list[EmploymentHistory] = Field(default_factory=list)
    capabilities: list[Capability] = Field(default_factory=list)
    tools_platforms: list[ToolPlatform] = Field(default_factory=list)
    evidence_provenance: list[EvidenceItem] = Field(default_factory=list)

    @model_validator(mode="after")
    def all_references_resolve(self) -> "CandidateProfile":
        evidence_ids = {item.id for item in self.evidence_provenance}
        if len(evidence_ids) != len(self.evidence_provenance):
            raise ValueError("evidence provenance IDs must be unique")

        refs: list[str] = []
        for capability in self.capabilities:
            refs.extend(capability.evidence_refs)
        for tool in self.tools_platforms:
            refs.extend(tool.evidence_refs)
        for ref in refs:
            if ref not in evidence_ids:
                raise ValueError(f"unknown evidence reference: {ref}")
        return self

    def to_deterministic_json(self) -> str:
        """Serialize with stable key ordering for snapshots and audit trails."""

        return json.dumps(
            self.model_dump(mode="json", exclude_none=True),
            sort_keys=True,
            separators=(",", ":"),
        )


def representative_profile() -> CandidateProfile:
    """Synthetic profile for examples and regression tests."""

    evidence = [
        EvidenceItem(
            id="exampleco-vulnerability-management",
            source_section="Professional Experience",
            origin=EvidenceOrigin.WORK_HISTORY,
            employer="ExampleCo",
            role="Senior Security Engineer",
            date_range=DateRange(start=date(2023, 6, 1)),
            cv_text="Owned a sample vulnerability management program and tracked remediation progress.",
            evidence_type=EvidenceType.PRODUCTION_OWNERSHIP,
        ),
        EvidenceItem(
            id="exampleco-coverity-sast",
            source_section="Professional Experience",
            origin=EvidenceOrigin.WORK_HISTORY,
            employer="ExampleCo",
            role="Senior Security Engineer",
            date_range=DateRange(start=date(2023, 6, 1)),
            cv_text="Led the integration of application security capabilities into the Secure SDLC, including Coverity SAST.",
            evidence_type=EvidenceType.PRODUCTION_OWNERSHIP,
        ),
        EvidenceItem(
            id="exampleco-black-duck-sca",
            source_section="Professional Experience",
            origin=EvidenceOrigin.WORK_HISTORY,
            employer="ExampleCo",
            role="Senior Security Engineer",
            date_range=DateRange(start=date(2023, 6, 1)),
            cv_text="Led the integration of application security capabilities into the Secure SDLC, including Black Duck SCA.",
            evidence_type=EvidenceType.PRODUCTION_OWNERSHIP,
        ),
        EvidenceItem(
            id="skills-threat-modeling",
            source_section="Skills",
            origin=EvidenceOrigin.SKILLS,
            cv_text="Threat Modeling",
            evidence_type=EvidenceType.SKILLS_ONLY,
        ),
        EvidenceItem(
            id="skills-secure-code-review",
            source_section="Skills",
            origin=EvidenceOrigin.SKILLS,
            cv_text="Secure Code Review",
            evidence_type=EvidenceType.SKILLS_ONLY,
        ),
        EvidenceItem(
            id="skills-aws-fundamentals",
            source_section="Skills",
            origin=EvidenceOrigin.SKILLS,
            cv_text="AWS Fundamentals",
            evidence_type=EvidenceType.FUNDAMENTALS,
        ),
        EvidenceItem(
            id="skills-container-security-fundamentals",
            source_section="Skills",
            origin=EvidenceOrigin.SKILLS,
            cv_text="Container Security Fundamentals",
            evidence_type=EvidenceType.FUNDAMENTALS,
        ),
        EvidenceItem(
            id="exampleco-python-automation",
            source_section="Professional Experience",
            origin=EvidenceOrigin.WORK_HISTORY,
            employer="ExampleCo",
            role="Senior Security Engineer",
            date_range=DateRange(start=date(2023, 6, 1)),
            cv_text="Designed and built Python/API-driven security automation for vulnerability triage, remediation coordination, malware scanning, training workflows, and security operations.",
            evidence_type=EvidenceType.PRODUCTION_OWNERSHIP,
        ),
        EvidenceItem(
            id="historical-web-application-scanning",
            source_section="Professional Experience",
            origin=EvidenceOrigin.WORK_HISTORY,
            employer="Example Services",
            role="Security Analyst",
            date_range=DateRange(start=date(2016, 5, 1), end=date(2019, 3, 1)),
            cv_text="Supported web application scanning and remediation for several sample customer teams.",
            evidence_type=EvidenceType.HISTORICAL_EXPOSURE,
        ),
    ]
    return CandidateProfile(
        schema_version="1.0",
        source_cv_version_id=2,
        summary="Synthetic security engineer profile with application security and program experience.",
        total_professional_experience_years=8,
        current_role="Senior Security Engineer",
        seniority="senior",
        education=[Education(degree="MSc Computer Security", institution="Blekinge Institute of Technology")],
        certifications=[Certification(name="CISM", issuer="ISACA", date_obtained=date(2024, 6, 7))],
        languages=[Language(language="English", proficiency="fluent"), Language(language="German", proficiency="basic")],
        roles=[EmploymentHistory(employer="ExampleCo", title="Senior Security Engineer", evidence_refs=["exampleco-vulnerability-management"])],
        capabilities=[
            Capability(normalized_name="vulnerability management", category="security management", evidence_level=4, evidence_type=EvidenceType.PRODUCTION_OWNERSHIP, professional_experience=True, ownership=True, current_or_recent=True, date_range=DateRange(start=date(2023, 6, 1)), evidence_refs=["exampleco-vulnerability-management"]),
            Capability(normalized_name="SAST", category="application security", evidence_level=4, evidence_type=EvidenceType.PRODUCTION_OWNERSHIP, professional_experience=True, ownership=True, current_or_recent=True, date_range=DateRange(start=date(2023, 6, 1)), tools=["Coverity"], evidence_refs=["exampleco-coverity-sast"]),
            Capability(normalized_name="SCA", category="application security", evidence_level=4, evidence_type=EvidenceType.PRODUCTION_OWNERSHIP, professional_experience=True, ownership=True, current_or_recent=True, date_range=DateRange(start=date(2023, 6, 1)), tools=["Black Duck"], evidence_refs=["exampleco-black-duck-sca"]),
            Capability(normalized_name="threat modeling", category="application security", evidence_level=1, evidence_type=EvidenceType.SKILLS_ONLY, evidence_refs=["skills-threat-modeling"]),
            Capability(normalized_name="secure code review", category="application security", evidence_level=1, evidence_type=EvidenceType.SKILLS_ONLY, evidence_refs=["skills-secure-code-review"]),
            Capability(normalized_name="AWS", category="cloud platform", evidence_level=1, evidence_type=EvidenceType.FUNDAMENTALS, evidence_refs=["skills-aws-fundamentals"], notes="Fundamentals only; not production AWS security engineering."),
            Capability(normalized_name="container security", category="cloud platform", evidence_level=1, evidence_type=EvidenceType.FUNDAMENTALS, evidence_refs=["skills-container-security-fundamentals"], notes="Fundamentals only; does not imply production Kubernetes experience."),
            Capability(normalized_name="security automation", category="engineering", evidence_level=4, evidence_type=EvidenceType.PRODUCTION_OWNERSHIP, professional_experience=True, ownership=True, current_or_recent=True, date_range=DateRange(start=date(2023, 6, 1)), tools=["Python", "API integration"], evidence_refs=["exampleco-python-automation"], notes="Security automation evidence does not imply full-time software-engineering depth."),
            Capability(normalized_name="web application scanning", category="application security", evidence_level=3, evidence_type=EvidenceType.HISTORICAL_EXPOSURE, professional_experience=True, current_or_recent=False, date_range=DateRange(start=date(2016, 5, 1), end=date(2019, 3, 1)), evidence_refs=["historical-web-application-scanning"]),
        ],
        tools_platforms=[ToolPlatform(normalized_name="Coverity", evidence_level=4, professional_experience=True, evidence_refs=["exampleco-coverity-sast"]), ToolPlatform(normalized_name="Black Duck", evidence_level=4, professional_experience=True, evidence_refs=["exampleco-black-duck-sca"]), ToolPlatform(normalized_name="AWS", evidence_level=1, evidence_refs=["skills-aws-fundamentals"])],
        evidence_provenance=evidence,
    )


def representative_profile_json() -> dict[str, Any]:
    """Return the representative fixture as ordinary JSON-compatible data."""

    return representative_profile().model_dump(mode="json", exclude_none=True)
