from datetime import date

from matching.candidate_profile import DateRange, EvidenceOrigin, EvidenceType, representative_profile
from matching.cv_normalizer import (
    ExtractedCapability,
    ExtractedEvidence,
    augment_explicit_skill_capabilities,
    extracted_from_profile,
    normalize_extracted_profile,
)
from matching.domains.cybersecurity import CYBERSECURITY_DOMAIN


def _profile_with_capability(*, evidence_type, origin, text, date_range=None):
    extracted = extracted_from_profile(representative_profile())
    extracted.evidence_provenance = [
        ExtractedEvidence(
            id="test-evidence",
            source_section="Skills" if origin == EvidenceOrigin.SKILLS else "Professional Experience",
            origin=origin,
            date_range=date_range,
            cv_text=text,
            evidence_type=evidence_type,
        )
    ]
    extracted.capabilities = [
        ExtractedCapability(
            normalized_name="test capability",
            category="security",
            evidence_refs=["test-evidence"],
        )
    ]
    extracted.tools_platforms = []
    extracted.roles = []
    return normalize_extracted_profile(extracted, 2).capabilities[0]


def test_fundamentals_and_skills_are_level_one_nonproduction():
    aws = _profile_with_capability(
        evidence_type=EvidenceType.FUNDAMENTALS,
        origin=EvidenceOrigin.SKILLS,
        text="AWS Fundamentals",
    )
    threat_modeling = _profile_with_capability(
        evidence_type=EvidenceType.SKILLS_ONLY,
        origin=EvidenceOrigin.SKILLS,
        text="Threat Modeling",
    )
    assert aws.evidence_level == 1 and not aws.production_experience and not aws.ownership
    assert threat_modeling.evidence_level == 1 and not threat_modeling.production_experience


def test_explicit_current_ownership_is_level_four():
    capability = _profile_with_capability(
        evidence_type=EvidenceType.PRODUCTION_OWNERSHIP,
        origin=EvidenceOrigin.WORK_HISTORY,
        text="Own the end-to-end vulnerability management program.",
    )
    assert capability.evidence_level == 4
    assert capability.production_experience is True
    assert capability.ownership is True


def test_present_tense_lead_is_explicit_ownership():
    capability = _profile_with_capability(
        evidence_type=EvidenceType.PRODUCTION_OWNERSHIP,
        origin=EvidenceOrigin.WORK_HISTORY,
        text="Lead technical security incident response across Engineering and IT.",
    )
    assert capability.evidence_level == 4
    assert capability.production_experience is True
    assert capability.ownership is True


def test_historical_production_remains_direct_but_not_current():
    capability = _profile_with_capability(
        evidence_type=EvidenceType.PRODUCTION_HANDS_ON,
        origin=EvidenceOrigin.WORK_HISTORY,
        text="Performed web application scanning for production customers.",
        date_range=DateRange(start=date(2016, 1, 1), end=date(2019, 1, 1)),
    )
    assert capability.evidence_level == 3
    assert capability.production_experience is True
    assert capability.current_or_recent is False


def test_skills_reference_does_not_override_stronger_work_history():
    extracted = extracted_from_profile(representative_profile())
    extracted.evidence_provenance.extend(
        [
            ExtractedEvidence(
                id="weak-sast",
                source_section="Skills",
                origin=EvidenceOrigin.SKILLS,
                cv_text="SAST",
                evidence_type=EvidenceType.SKILLS_ONLY,
            ),
            ExtractedEvidence(
                id="strong-sast",
                source_section="Professional Experience",
                origin=EvidenceOrigin.WORK_HISTORY,
                cv_text="Implemented SAST in the production secure SDLC.",
                evidence_type=EvidenceType.PRODUCTION_HANDS_ON,
            ),
        ]
    )
    extracted.capabilities = [
        ExtractedCapability(
            normalized_name="SAST",
            category="application security",
            evidence_refs=["weak-sast", "strong-sast"],
        )
    ]
    capability = normalize_extracted_profile(extracted, 2).capabilities[0]
    assert capability.evidence_level == 3
    assert capability.production_experience is True
    assert set(capability.evidence_refs) == {"weak-sast", "strong-sast"}


def test_unsupported_ownership_is_downgraded():
    capability = _profile_with_capability(
        evidence_type=EvidenceType.PRODUCTION_OWNERSHIP,
        origin=EvidenceOrigin.WORK_HISTORY,
        text="Worked with vulnerability management tools.",
    )
    assert capability.evidence_level == 3
    assert capability.evidence_type == EvidenceType.PRODUCTION_HANDS_ON
    assert capability.production_experience is True
    assert capability.ownership is False


def test_explicit_skills_are_retained_as_level_one_atomic_capabilities():
    extracted = extracted_from_profile(representative_profile())
    extracted = augment_explicit_skill_capabilities(
        extracted,
        r"\skillrow{Application \& Product Security}{Threat Modeling, Secure Code Review, SAST, SCA, DAST}",
    )
    profile = normalize_extracted_profile(extracted, 2, domain_rules=CYBERSECURITY_DOMAIN)
    capabilities = {item.normalized_name.casefold(): item for item in profile.capabilities}

    assert capabilities["threat modeling"].evidence_level == 1
    assert capabilities["threat modeling"].production_experience is False
    assert capabilities["secure code review"].evidence_level == 1
    assert capabilities["dast"].evidence_level == 1


def test_atomic_sast_sca_merge_with_broader_appsec_without_collapse():
    extracted = extracted_from_profile(representative_profile())
    extracted.capabilities.append(
        ExtractedCapability(
            normalized_name="Application Security and Secure SDLC",
            category="application security",
            evidence_refs=["exampleco-coverity-sast"],
        )
    )
    extracted = augment_explicit_skill_capabilities(
        extracted,
        r"\skillrow{Application \& Product Security}{SAST, SCA}",
    )
    profile = normalize_extracted_profile(extracted, 2, domain_rules=CYBERSECURITY_DOMAIN)
    capabilities = {item.normalized_name.casefold(): item for item in profile.capabilities}

    assert "application security and secure sdlc" in capabilities
    assert capabilities["sast"].evidence_level == 4
    assert capabilities["sca"].evidence_level == 4
    assert len(capabilities["sast"].evidence_refs) == 2
    assert len(capabilities["sca"].evidence_refs) == 2


def test_explicit_cv_skill_entries_are_available_to_normalization():
    extracted = augment_explicit_skill_capabilities(
        extracted_from_profile(representative_profile()),
        r"\skillrow{Application \& Product Security}{Threat Modeling, Secure Code Review, SAST, SCA, DAST}",
    )
    names = {item.normalized_name.casefold() for item in extracted.capabilities}
    assert {"threat modeling", "secure code review", "sast", "sca", "dast"} <= names


def test_named_work_history_capabilities_are_atomic():
    extracted = extracted_from_profile(representative_profile())
    extracted = augment_explicit_skill_capabilities(extracted, "")
    profile = normalize_extracted_profile(extracted, 2, domain_rules=CYBERSECURITY_DOMAIN)
    capabilities = {item.normalized_name.casefold(): item for item in profile.capabilities}

    extracted = CYBERSECURITY_DOMAIN.augment(extracted)
    profile = normalize_extracted_profile(extracted, 2, domain_rules=CYBERSECURITY_DOMAIN)
    capabilities = {item.normalized_name.casefold(): item for item in profile.capabilities}
    assert capabilities["python/api automation"].evidence_level >= 3
    assert capabilities["python/api automation"].production_experience is True
    assert capabilities["web application scanning"].evidence_level == 3
    assert capabilities["web application scanning"].current_or_recent is False


def test_dast_does_not_inherit_generic_web_scanning_evidence():
    extracted = extracted_from_profile(representative_profile())
    extracted.capabilities.append(
        ExtractedCapability(
            normalized_name="DAST",
            category="application security",
            evidence_refs=["historical-web-application-scanning"],
        )
    )
    profile = normalize_extracted_profile(extracted, 2, domain_rules=CYBERSECURITY_DOMAIN)
    assert not any(item.normalized_name == "DAST" for item in profile.capabilities)

    extracted.evidence_provenance.append(
        ExtractedEvidence(
            id="skills-dast",
            source_section="Skills",
            origin=EvidenceOrigin.SKILLS,
            cv_text="DAST",
            evidence_type=EvidenceType.SKILLS_ONLY,
        )
    )
    extracted.capabilities[-1] = ExtractedCapability(
        normalized_name="DAST", category="application security", evidence_refs=["skills-dast"]
    )
    profile = normalize_extracted_profile(extracted, 2, domain_rules=CYBERSECURITY_DOMAIN)
    dast = next(item for item in profile.capabilities if item.normalized_name == "DAST")
    assert dast.evidence_level == 1
