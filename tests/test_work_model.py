import json
from pathlib import Path

import pytest

from matching.job_eligibility import assess_discovered_job
from matching.work_model import classify_work_model


CASES = json.loads((Path(__file__).parent / "fixtures" / "work_model_cases.json").read_text())
PROFILE = {"definition": {"remote_only": True, "work_models": ["remote"], "allowed_regions": ["Austria", "Europe", "worldwide"]}}


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_work_model_case(case):
    assert classify_work_model(
        title=case.get("title", ""), location=case.get("location", ""),
        remote_scope=case.get("remote_scope", ""), description=case.get("description", ""),
        structured_work_model=case.get("structured_work_model", ""),
    ) == case["expected"]
    result = assess_discovered_job(
        title=case.get("title", "Security Engineer"), location=case.get("location", "Vienna, Austria"),
        remote_scope=case.get("structured_work_model") or case.get("remote_scope"),
        description=case.get("description", ""), profile=PROFILE,
    )
    assert result.work_model == "eligible"


def test_manual_remote_confirmation_resolves_unclear_model_without_bypassing_other_preferences():
    profile = {
        "definition": {
            "target_titles": ["Senior Product Security Engineer"],
            "work_models": ["remote"],
            "allowed_regions": ["Austria", "Europe", "EEA", "EU"],
            "accepted_languages": ["English"],
            "eligibility_constraints": {"remote_scope": "Austria/EU/EEA/Europe"},
        }
    }
    description = "Senior Product Security Engineer. English required. " + "Build product security practices. " * 12
    unresolved = assess_discovered_job(
        title="Senior Product Security Engineer", location="Vienna, Austria",
        remote_scope=None, description=description, profile=profile,
    )
    confirmed = assess_discovered_job(
        title="Senior Product Security Engineer", location="Vienna, Austria",
        remote_scope=None, description=description, profile=profile,
        verified_work_model="remote",
    )

    assert unresolved.work_model == "eligible"
    assert unresolved.actionable
    assert confirmed.work_model == "eligible"
    assert confirmed.location == "eligible"
    assert confirmed.actionable


def test_manual_work_model_confirmation_does_not_override_profile_mismatch():
    remote_profile = {"definition": {"work_models": ["remote"]}}
    onsite = assess_discovered_job(
        title="Security Engineer", location="Vienna, Austria", remote_scope=None,
        description="", profile=remote_profile, verified_work_model="onsite",
    )
    assert onsite.work_model == "eligible"
    assert not onsite.actionable
