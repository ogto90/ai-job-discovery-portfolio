"""Cybersecurity semantic normalization kept outside the generic profile core."""

from __future__ import annotations

import re

from ..cv_normalizer import ExtractedCandidateProfile, ExtractedCapability, ExtractedEvidence
from ..candidate_profile import EvidenceOrigin


class CybersecurityDomainRules:
    """Small, conservative semantic additions for cybersecurity CVs."""

    _ALIASES = (
        (
            "Python/API automation",
            "security engineering",
            re.compile(r"python/api[- ]driven security automation", re.IGNORECASE),
        ),
        (
            "Web application scanning",
            "application security",
            re.compile(r"web application scanning", re.IGNORECASE),
        ),
    )
    _ATOMIC_TERMS = {
        "sast": re.compile(r"\bsast\b", re.IGNORECASE),
        "sca": re.compile(r"\bsca\b", re.IGNORECASE),
        "dast": re.compile(r"\bdast\b", re.IGNORECASE),
        "threat modeling": re.compile(r"threat modeling", re.IGNORECASE),
        "secure code review": re.compile(r"secure code review", re.IGNORECASE),
    }

    def augment(self, extracted: ExtractedCandidateProfile) -> ExtractedCandidateProfile:
        capabilities = list(extracted.capabilities)
        existing = {item.normalized_name.strip().casefold(): index for index, item in enumerate(capabilities)}
        evidence = {item.id: item for item in extracted.evidence_provenance}

        for name, category, pattern in self._ALIASES:
            refs = [
                item.id
                for item in evidence.values()
                if item.origin == EvidenceOrigin.WORK_HISTORY and pattern.search(item.cv_text)
            ]
            if not refs:
                continue
            key = name.casefold()
            if key in existing:
                index = existing[key]
                current = capabilities[index]
                capabilities[index] = current.model_copy(
                    update={"evidence_refs": list(dict.fromkeys(current.evidence_refs + refs))}
                )
            else:
                capabilities.append(
                    ExtractedCapability(
                        normalized_name=name,
                        category=category,
                        evidence_refs=refs,
                        notes="Atomic capability preserved from explicit work-history evidence.",
                    )
                )
                existing[key] = len(capabilities) - 1
        return extracted.model_copy(update={"capabilities": capabilities})

    def relevant_items(
        self, capability: ExtractedCapability, items: list[ExtractedEvidence]
    ) -> list[ExtractedEvidence]:
        """Prevent broad scanning evidence from inflating named AppSec capabilities."""

        pattern = self._ATOMIC_TERMS.get(capability.normalized_name.strip().casefold())
        if pattern is None:
            return items
        relevant = [item for item in items if pattern.search(item.cv_text)]
        return relevant or [item for item in items if item.origin != EvidenceOrigin.WORK_HISTORY]


CYBERSECURITY_DOMAIN = CybersecurityDomainRules()
