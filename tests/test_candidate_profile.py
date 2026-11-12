import json

import pytest
from pydantic import ValidationError

from matching.candidate_profile import (
    Capability,
    CandidateProfile,
    EvidenceLevel,
    EvidenceType,
    representative_profile,
)


def test_representative_profile_is_valid():
    profile = representative_profile()
    assert profile.source_cv_version_id == 2
    assert len(profile.capabilities) >= 8


def test_invalid_evidence_level_is_rejected():
    with pytest.raises(ValidationError):
        Capability(normalized_name="x", category="security", evidence_level=5, evidence_type="skills_only")


def test_fundamentals_cannot_claim_production_ownership():
    with pytest.raises(ValidationError, match="weak evidence"):
        Capability(normalized_name="AWS", category="cloud", evidence_level=1, evidence_type="fundamentals", professional_experience=True, evidence_refs=["aws"])


def test_skills_only_cannot_be_level_four():
    with pytest.raises(ValidationError, match="cap at level 1"):
        Capability(normalized_name="Threat Modeling", category="appsec", evidence_level=4, evidence_type="skills_only", evidence_refs=["threat"])


def test_aws_and_container_fundamentals_remain_nonproduction():
    profile = representative_profile()
    selected = {c.normalized_name: c for c in profile.capabilities}
    assert selected["AWS"].evidence_level == 1
    assert selected["AWS"].production_experience is False
    assert selected["container security"].evidence_level == 1
    assert selected["container security"].production_experience is False


def test_vulnerability_management_represents_level_four_ownership():
    capability = next(c for c in representative_profile().capabilities if c.normalized_name == "vulnerability management")
    assert capability.evidence_level == EvidenceLevel.OWNED_PRODUCTION
    assert capability.production_experience and capability.ownership


def test_multiple_evidence_items_can_support_one_capability():
    profile = representative_profile()
    profile.capabilities[0].evidence_refs.extend(["exampleco-python-automation"])
    assert len(profile.capabilities[0].evidence_refs) == 2


def test_historical_and_current_evidence_coexist():
    profile = representative_profile()
    current = next(c for c in profile.capabilities if c.normalized_name == "SAST")
    historical = next(c for c in profile.capabilities if c.normalized_name == "web application scanning")
    assert current.current_or_recent is True
    assert historical.current_or_recent is False
    assert historical.evidence_level == EvidenceLevel.DIRECT_PRODUCTION


def test_deterministic_json_and_round_trip():
    profile = representative_profile()
    first = profile.to_deterministic_json()
    second = profile.to_deterministic_json()
    assert first == second
    restored = CandidateProfile.model_validate_json(first)
    assert restored.to_deterministic_json() == first
    assert json.loads(first)["schema_version"] == "1.0"


def test_unresolved_evidence_reference_is_rejected():
    data = representative_profile().model_dump()
    data["capabilities"][0]["evidence_refs"] = ["missing-ref"]
    with pytest.raises(ValidationError, match="unknown evidence reference"):
        CandidateProfile.model_validate(data)
