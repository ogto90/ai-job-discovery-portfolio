"""Deterministic conversion from model-extracted CV facts to CandidateProfile."""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .candidate_profile import (
    CandidateProfile,
    Capability,
    Certification,
    DateRange,
    Education,
    EmploymentHistory,
    EvidenceItem,
    EvidenceLevel,
    EvidenceOrigin,
    EvidenceType,
    Language,
    ToolPlatform,
)


class ExtractedEvidence(BaseModel):
    """Evidence facts the model may extract; no derived strength fields."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    source_section: str = Field(min_length=1)
    origin: EvidenceOrigin
    employer: str | None = None
    role: str | None = None
    date_range: DateRange | None = None
    cv_text: str = Field(min_length=1)
    evidence_type: EvidenceType


class ExtractedCapability(BaseModel):
    """A semantic capability and its supporting evidence references."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    normalized_name: str = Field(min_length=1)
    category: str = Field(min_length=1)
    tools: list[str] = Field(default_factory=list)
    evidence_refs: list[str] = Field(default_factory=list)
    notes: str | None = None


class ExtractedTool(BaseModel):
    """A named tool with provenance; strength is derived locally."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    normalized_name: str = Field(min_length=1)
    evidence_refs: list[str] = Field(default_factory=list)
    notes: str | None = None


class ExtractedCandidateProfile(BaseModel):
    """OpenAI-facing schema. Strength and production flags are deliberately absent."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    schema_version: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    total_professional_experience_years: float | None = Field(default=None, ge=0)
    current_role: str = Field(min_length=1)
    seniority: str = Field(min_length=1)
    education: list[Education] = Field(default_factory=list)
    certifications: list[Certification] = Field(default_factory=list)
    languages: list[Language] = Field(default_factory=list)
    # Generate the evidence ledger before records that cite it.
    evidence_provenance: list[ExtractedEvidence] = Field(
        default_factory=list,
        description="CV evidence records with unique IDs. Every evidence_refs value must exactly match one of these IDs.",
    )
    roles: list[EmploymentHistory] = Field(default_factory=list)
    capabilities: list[ExtractedCapability] = Field(default_factory=list)
    tools_platforms: list[ExtractedTool] = Field(default_factory=list)


class DomainNormalizationRules(Protocol):
    """Optional semantic additions and evidence guards for one profession domain."""

    def augment(self, extracted: ExtractedCandidateProfile) -> ExtractedCandidateProfile:
        ...

    def relevant_items(
        self, capability: ExtractedCapability, items: list[ExtractedEvidence]
    ) -> list[ExtractedEvidence]:
        ...


_OWNERSHIP_RE = re.compile(
    r"\b(own|owned|lead|leads|leading|led|implemented|built|established|responsible for|end[- ]to[- ]end|created|developed|drove)\b",
    re.IGNORECASE,
)

_PRODUCTION_TYPES = {
    EvidenceType.PRODUCTION_OWNERSHIP,
    EvidenceType.PRODUCTION_HANDS_ON,
    EvidenceType.HISTORICAL_EXPOSURE,
}

_SKILLROW_RE = re.compile(r"\\skillrow\{([^{}]*)\}\{([^{}]*)\}")


def _capability_key(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip()).casefold()


def _skill_id(category: str, name: str, index: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", f"{category}-{name}".casefold()).strip("-")
    return f"skills-{slug or 'entry'}-{index}"


def augment_explicit_skill_capabilities(
    extracted: ExtractedCandidateProfile, latex_text: str
) -> ExtractedCandidateProfile:
    """Add every explicit CV Skills entry without assigning production strength."""

    capabilities = list(extracted.capabilities)
    evidence = list(extracted.evidence_provenance)
    existing_evidence = {
        (item.origin, item.cv_text.casefold()): item.id for item in evidence
    }
    existing_capabilities = {
        _capability_key(item.normalized_name): index
        for index, item in enumerate(capabilities)
    }
    skill_index = 0

    for category, raw_entries in _SKILLROW_RE.findall(latex_text):
        for raw_name in raw_entries.split(","):
            name = raw_name.replace(r"\&", "&").strip()
            if not name:
                continue
            evidence_key = (EvidenceOrigin.SKILLS, name.casefold())
            evidence_id = existing_evidence.get(evidence_key)
            if evidence_id is None:
                skill_index += 1
                evidence_id = _skill_id(category, name, skill_index)
                evidence.append(
                    ExtractedEvidence(
                        id=evidence_id,
                        source_section=f"Skills — {category}",
                        origin=EvidenceOrigin.SKILLS,
                        cv_text=name,
                        evidence_type=(
                            EvidenceType.FUNDAMENTALS
                            if "fundamental" in name.casefold()
                            else EvidenceType.SKILLS_ONLY
                        ),
                    )
                )
                existing_evidence[evidence_key] = evidence_id

            capability_key = _capability_key(name)
            if capability_key not in existing_capabilities:
                capabilities.append(
                    ExtractedCapability(
                        normalized_name=name,
                        category=category,
                        evidence_refs=[evidence_id],
                        notes="Explicitly listed in the CV Skills section; no production inference.",
                    )
                )
                existing_capabilities[capability_key] = len(capabilities) - 1
            else:
                capability_index = existing_capabilities[capability_key]
                existing = capabilities[capability_index]
                if evidence_id not in existing.evidence_refs:
                    capabilities[capability_index] = existing.model_copy(
                        update={"evidence_refs": [*existing.evidence_refs, evidence_id]}
                    )

    return extracted.model_copy(update={"capabilities": capabilities, "evidence_provenance": evidence})


def _merge_capabilities(capabilities: list[ExtractedCapability]) -> list[ExtractedCapability]:
    """Merge duplicate names while retaining every distinct evidence reference."""

    merged: dict[str, ExtractedCapability] = {}
    for capability in capabilities:
        key = _capability_key(capability.normalized_name)
        previous = merged.get(key)
        if previous is None:
            merged[key] = capability
            continue
        refs = list(dict.fromkeys(previous.evidence_refs + capability.evidence_refs))
        tools = list(dict.fromkeys(previous.tools + capability.tools))
        notes = "; ".join(dict.fromkeys(filter(None, [previous.notes, capability.notes]))) or None
        merged[key] = previous.model_copy(update={"evidence_refs": refs, "tools": tools, "notes": notes})
    return list(merged.values())


def _is_current_or_recent(item: ExtractedEvidence) -> bool:
    if item.origin != EvidenceOrigin.WORK_HISTORY:
        return False
    return item.date_range is None or item.date_range.end is None or item.date_range.end >= date.today() - timedelta(days=365)


def _normalize_evidence(item: ExtractedEvidence) -> tuple[EvidenceType, EvidenceLevel, bool, bool]:
    """Return final type, level, production, ownership for one evidence item."""

    work_history = item.origin == EvidenceOrigin.WORK_HISTORY
    explicit_ownership = work_history and bool(_OWNERSHIP_RE.search(item.cv_text))

    if item.evidence_type == EvidenceType.PRODUCTION_OWNERSHIP:
        if explicit_ownership:
            return EvidenceType.PRODUCTION_OWNERSHIP, EvidenceLevel.OWNED_PRODUCTION, True, True
        if work_history:
            return EvidenceType.PRODUCTION_HANDS_ON, EvidenceLevel.DIRECT_PRODUCTION, True, False
        return EvidenceType.SKILLS_ONLY, EvidenceLevel.WEAK, False, False

    if item.evidence_type == EvidenceType.PRODUCTION_HANDS_ON:
        if work_history:
            return EvidenceType.PRODUCTION_HANDS_ON, EvidenceLevel.DIRECT_PRODUCTION, True, False
        return EvidenceType.PRACTICAL_EXPOSURE, EvidenceLevel.EXPOSURE, False, False

    if item.evidence_type == EvidenceType.HISTORICAL_EXPOSURE:
        if work_history:
            return EvidenceType.HISTORICAL_EXPOSURE, EvidenceLevel.DIRECT_PRODUCTION, True, explicit_ownership
        return EvidenceType.PRACTICAL_EXPOSURE, EvidenceLevel.EXPOSURE, False, False

    if item.evidence_type in {EvidenceType.PRACTICAL_EXPOSURE, EvidenceType.EVALUATION_OR_POC}:
        return item.evidence_type, EvidenceLevel.EXPOSURE, False, False

    return item.evidence_type, EvidenceLevel.WEAK, False, False


def normalize_extracted_profile(
    extracted: ExtractedCandidateProfile,
    cv_version_id: int,
    *,
    domain_rules: DomainNormalizationRules | None = None,
) -> CandidateProfile:
    """Derive invariant final fields from all validated evidence items."""

    evidence = [EvidenceItem(**item.model_dump(mode="python")) for item in extracted.evidence_provenance]
    evidence_by_id = {item.id: item for item in extracted.evidence_provenance}
    if len(evidence_by_id) != len(evidence):
        raise ValueError("extracted evidence IDs must be unique")

    reference_errors = []
    reference_groups = [
        ("capabilities", extracted.capabilities),
        ("tools_platforms", extracted.tools_platforms),
        ("roles", extracted.roles),
        ("education", extracted.education),
        ("certifications", extracted.certifications),
    ]
    for group_name, records in reference_groups:
        for index, record in enumerate(records):
            for ref_index, ref in enumerate(record.evidence_refs):
                if ref not in evidence_by_id:
                    reference_errors.append(
                        {
                            "type": "value_error",
                            "loc": (group_name, index, "evidence_refs", ref_index),
                            "msg": "unknown evidence reference",
                            "input": ref,
                            "ctx": {"error": "unknown evidence reference"},
                        }
                    )
    if reference_errors:
        raise ValidationError.from_exception_data("CandidateProfile", reference_errors)

    capabilities: list[Capability] = []
    for extracted_capability in _merge_capabilities(extracted.capabilities):
        items = [evidence_by_id[ref] for ref in extracted_capability.evidence_refs if ref in evidence_by_id]
        if not items:
            raise ValueError(f"capability has no resolvable evidence: {extracted_capability.normalized_name}")

        if domain_rules is not None:
            items = domain_rules.relevant_items(extracted_capability, items)
        if not items:
            continue
        normalized = [_normalize_evidence(item) for item in items]
        strongest_index = max(range(len(normalized)), key=lambda index: normalized[index][1])
        evidence_type, level, production, ownership = normalized[strongest_index]
        strongest_item = items[strongest_index]
        notes = extracted_capability.notes
        if evidence_type == EvidenceType.HISTORICAL_EXPOSURE or (
            production and not _is_current_or_recent(strongest_item)
        ):
            notes = f"{notes} Historical evidence; not current/recent." if notes else "Historical evidence; not current/recent."

        capabilities.append(
            Capability(
                normalized_name=extracted_capability.normalized_name,
                category=extracted_capability.category,
                evidence_level=level,
                evidence_type=evidence_type,
                professional_experience=production,
                ownership=ownership,
                current_or_recent=_is_current_or_recent(strongest_item),
                date_range=strongest_item.date_range,
                tools=extracted_capability.tools,
                evidence_refs=[item.id for item in items],
                notes=notes,
            )
        )

    tools: list[ToolPlatform] = []
    for extracted_tool in extracted.tools_platforms:
        tool_items = [evidence_by_id[ref] for ref in extracted_tool.evidence_refs if ref in evidence_by_id]
        if not tool_items:
            raise ValueError(f"tool has no resolvable evidence: {extracted_tool.normalized_name}")
        tool_normalized = [_normalize_evidence(item) for item in tool_items]
        tool_index = max(range(len(tool_normalized)), key=lambda index: tool_normalized[index][1])
        _, tool_level, tool_production, _ = tool_normalized[tool_index]
        tools.append(
            ToolPlatform(
                normalized_name=extracted_tool.normalized_name,
                evidence_level=tool_level,
                professional_experience=tool_production,
                evidence_refs=extracted_tool.evidence_refs,
                notes=extracted_tool.notes,
            )
        )

    return CandidateProfile(
        schema_version=extracted.schema_version,
        source_cv_version_id=cv_version_id,
        summary=extracted.summary,
        total_professional_experience_years=extracted.total_professional_experience_years,
        current_role=extracted.current_role,
        seniority=extracted.seniority,
        education=extracted.education,
        certifications=extracted.certifications,
        languages=extracted.languages,
        roles=extracted.roles,
        capabilities=capabilities,
        tools_platforms=tools,
        evidence_provenance=evidence,
    )


def extracted_from_profile(profile: CandidateProfile) -> ExtractedCandidateProfile:
    """Convert the grounded fixture to the intermediate shape for unit tests."""

    return ExtractedCandidateProfile(
        schema_version=profile.schema_version,
        summary=profile.summary,
        total_professional_experience_years=profile.total_professional_experience_years,
        current_role=profile.current_role,
        seniority=profile.seniority,
        education=profile.education,
        certifications=profile.certifications,
        languages=profile.languages,
        roles=profile.roles,
        capabilities=[
            ExtractedCapability(
                normalized_name=item.normalized_name,
                category=item.category,
                tools=item.tools,
                evidence_refs=item.evidence_refs,
                notes=item.notes,
            )
            for item in profile.capabilities
        ],
        tools_platforms=[
            ExtractedTool(
                normalized_name=item.normalized_name,
                evidence_refs=item.evidence_refs,
                notes=item.notes,
            )
            for item in profile.tools_platforms
        ],
        evidence_provenance=[ExtractedEvidence(**item.model_dump(mode="python")) for item in profile.evidence_provenance],
    )


def load_extracted_candidate_profile(data: dict[str, Any]) -> ExtractedCandidateProfile:
    """Load current extraction JSON and adapt the prior cyber-only shape offline."""

    payload = dict(data)
    if "total_professional_experience_years" not in payload:
        payload["total_professional_experience_years"] = payload.pop(
            "total_security_experience_years", None
        )
    for legacy_field in (
        "leadership_evidence_refs",
        "engineering_coding_evidence_refs",
        "cloud_platform_evidence_refs",
        "governance_compliance_evidence_refs",
    ):
        payload.pop(legacy_field, None)
    return ExtractedCandidateProfile.model_validate(payload)
