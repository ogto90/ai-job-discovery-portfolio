import json
from pathlib import Path

from matching.job_eligibility import (
    ROLE_EXCLUDED,
    ROLE_TARGET_MATCH,
    ROLE_UNRELATED,
    assess_discovered_job,
    classify_role,
)
from matching.job_eligibility import assess_discovered_job


def profile(**definition):
    return {"definition": definition}


CYBER = profile(
    target_titles=["Security Engineer", "Application Security", "Product Security", "AppSec", "DevSecOps"],
    excluded_title_patterns=["Analyst", "SOC"],
)
SOFTWARE = profile(target_titles=["Software Engineer", "Backend Engineer", "Platform Engineer"])
SALES = profile(target_titles=["Account Executive", "Sales", "Business Development"])
ANALYST = profile(target_titles=["Security Analyst", "Risk Analyst"])


def test_profession_neutral_role_matching_and_profile_scoped_exclusions():
    assert classify_role("Senior Security Engineer", CYBER) == ROLE_TARGET_MATCH
    assert classify_role("Application Security Engineer", CYBER) == ROLE_TARGET_MATCH
    assert classify_role("Senior Software Engineer", CYBER) == ROLE_UNRELATED
    assert classify_role("Security Analyst", CYBER) == ROLE_EXCLUDED
    assert classify_role("Accountant Analyst", CYBER) == ROLE_EXCLUDED
    assert classify_role("SOC Engineer", CYBER) == ROLE_EXCLUDED

    for title in ("Senior Software Engineer", "Backend Engineer", "Platform Engineer"):
        assert classify_role(title, SOFTWARE) == ROLE_TARGET_MATCH
    assert classify_role("Senior Security Engineer", SOFTWARE) == ROLE_UNRELATED

    assert classify_role("Account Executive, Enterprise Expansion", SALES) == ROLE_TARGET_MATCH
    assert classify_role("Business Development Manager", SALES) == ROLE_TARGET_MATCH
    assert classify_role("Senior Software Engineer", SALES) == ROLE_UNRELATED

    assert classify_role("Security Analyst", ANALYST) == ROLE_TARGET_MATCH
    assert classify_role("Business Analyst", ANALYST) == ROLE_UNRELATED


def test_same_platform_role_is_profile_relative():
    assert classify_role("Platform Engineer", CYBER) == ROLE_UNRELATED
    assert classify_role("Platform Engineer", SOFTWARE) == ROLE_TARGET_MATCH


def test_adjacent_role_is_profile_configured_and_full_jd_resolves_only_from_its_terms():
    p = profile(target_titles=["Software Engineer"], target_adjacent_terms=["Security Enhancements"])
    assert classify_role("Software Engineer, Security Enhancements", p) == "target_adjacent"
    full = "This Software Engineer role builds secure software engineering controls. " * 15
    assert classify_role("Software Engineer, Security Enhancements", p, full, full_description=True) == ROLE_TARGET_MATCH
    assert classify_role("Software Engineer, Security Enhancements", SOFTWARE) == ROLE_TARGET_MATCH

    from matching.job_eligibility import assess_discovered_job

    assert assess_discovered_job(
        title="Software Engineer, Security Enhancements", location=None, remote_scope=None,
        description=full, description_kind="snippet", profile=p,
    ).role == "target_adjacent"


def test_geography_is_profile_driven_for_same_us_only_remote_listing():
    jd = "Remote within the United States only. " + "Work with the product team. " * 20
    europe = profile(work_models=["remote"], allowed_regions=["Europe"])
    us = profile(work_models=["remote"], allowed_countries=["United States"])
    eu_result = assess_discovered_job(title="Platform Engineer", location="Remote US", remote_scope="Remote US", description=jd, profile=europe)
    us_result = assess_discovered_job(title="Platform Engineer", location="Remote US", remote_scope="Remote US", description=jd, profile=us)
    assert eu_result.location == "ineligible"
    assert us_result.location == "eligible"


def test_remote_only_profile_does_not_accept_a_known_region_without_remote_evidence():
    p = profile(
        remote_only=True,
        work_models=["remote"],
        allowed_regions=["Europe", "worldwide"],
        eligibility_constraints={"remote_scope": "Europe/worldwide"},
    )
    for location in ("Solna, Stockholm County, Sweden", "Rome, Latium, Italy", "Erkrath, Germany"):
        result = assess_discovered_job(title="Security Lead", location=location, remote_scope=None, description="", profile=p)
        assert result.location == "eligible"


def test_manual_location_decision_resolves_only_unclear_location():
    p = profile(
        target_titles=["Security Engineer"], remote_only=True,
        work_models=["remote"], allowed_regions=["Europe"],
    )
    args = dict(
        title="Security Engineer", location="Vienna", remote_scope=None,
        description="", profile=p,
    )
    base = assess_discovered_job(**args)
    approved = assess_discovered_job(**args, verified_location_status="accepted")
    rejected = assess_discovered_job(**args, verified_location_status="rejected")
    assert base.location == "eligible"
    assert approved.location == "eligible"
    assert rejected.location == "ineligible"
    assert approved.work_model == base.work_model == "eligible"


def test_user_approved_location_overrides_geography_but_not_work_model():
    p = profile(remote_only=True, work_models=["remote"], allowed_regions=["Europe"])
    geography_override = assess_discovered_job(
        title="Security Engineer", location="Belgrade, Serbia", remote_scope="Remote",
        description="", profile=p, verified_location_status="accepted",
    )
    assert geography_override.location == "eligible"
    assert geography_override.work_model == "eligible"
    onsite = assess_discovered_job(
        title="Security Engineer", location="Vienna, Austria", remote_scope="On-site",
        description="", profile=p, verified_location_status="accepted",
    )
    assert onsite.location == "eligible"
    assert onsite.work_model == "eligible"
    onsite = assess_discovered_job(title="Security Lead", location="Rome, Italy", remote_scope="On-site", description="", profile=p)
    assert onsite.location == "eligible"


def test_per_listing_override_only_bypasses_the_selected_preference():
    p = profile(
        target_titles=["Security Engineer"], remote_only=True,
        work_models=["remote"], allowed_regions=["Europe"],
    )
    args = dict(
        title="Security Engineer", location="United States", remote_scope="On-site",
        description="", profile=p,
    )
    baseline = assess_discovered_job(**args)
    accepted = assess_discovered_job(**args, preference_overrides=["location"])
    assert baseline.location == "ineligible"
    assert baseline.work_model == "eligible"
    assert accepted.location == "eligible"
    assert accepted.work_model == "eligible"
    assert p["definition"]["allowed_regions"] == ["Europe"]


def test_worldwide_remote_profile_is_profile_relative_and_understands_state_locations():
    global_remote = profile(remote_only=True, work_models=["remote"], allowed_regions=["Europe", "worldwide"])
    us_remote = assess_discovered_job(title="Security Engineer", location="Austin, TX", remote_scope="Remote", description="", profile=global_remote)
    assert us_remote.location == "ineligible"

    us_only = profile(remote_only=True, work_models=["remote"], allowed_countries=["United States"])
    eu_remote = assess_discovered_job(title="Security Engineer", location="Rome, Italy", remote_scope="Remote", description="", profile=us_only)
    assert eu_remote.location == "ineligible"


def test_exact_us_only_jd_scope_overrides_worldwide_aggregator_location():
    p = profile(remote_only=True, work_models=["remote"], allowed_regions=["Europe", "worldwide"])
    result = assess_discovered_job(
        title="Security Engineer", location="Anywhere in the World", remote_scope="Worldwide",
        description="Remote within the United States only.", profile=p,
    )
    assert result.location == "ineligible"


def test_full_description_detection_uses_content_not_declared_kind_or_character_count():
    from matching.job_description import classify_job_description, is_usable_full_job_description

    compact = "Responsibilities: Design security controls, lead reviews, implement safeguards, and support engineering teams. Requirements: Own vulnerability workflows and collaborate across product groups. " * 3
    teaser = "Join our team to help build innovative products and improve security across the company. " * 5
    boilerplate = """<div>Responsibilities: Design security controls, lead reviews, implement safeguards, and support engineering teams.</div>
    <footer>Privacy policy. Terms of service. Cookie preferences. All rights reserved. Browse all jobs. Sign in.</footer>"""
    assert is_usable_full_job_description(compact)
    assert classify_job_description(compact, "snippet") == "full"
    assert classify_job_description(teaser, "full") == "snippet"
    assert classify_job_description(boilerplate, "full") == "snippet"
    assert classify_job_description("<script>lots of hidden content</script>", "full") == "missing"

    flattened = (
        "Responsibilities: Lead application security reviews, design practical controls, "
        "implement improvements, support product teams, assess vulnerabilities, and respond "
        "to incidents across customer-facing services. Qualifications: Bring professional "
        "security experience, clear communication, and the ability to collaborate with "
        "engineering, product, and operations teams to deliver measurable risk reduction. "
        "Equal opportunity employer. Privacy policy."
    )
    assert classify_job_description(flattened, "missing") == "full"


def test_work_model_and_language_are_informational_not_eligibility_gates():
    remote_europe = profile(work_models=["remote"], allowed_regions=["Europe"])
    good = assess_discovered_job(title="Security Engineer", location="Remote Europe", remote_scope="Full Remote", description="English required. " + "Build products with the team. " * 10, profile=remote_europe)
    assert good.location == "eligible"
    assert good.language == "eligible"
    assert good.work_model == "eligible"

    unclear = assess_discovered_job(title="Security Engineer", location="Vienna", remote_scope=None, description="", profile=remote_europe)
    assert unclear.location == "eligible"
    assert unclear.actionable is False

    onsite = assess_discovered_job(title="Security Engineer", location="Vienna", remote_scope="On-site", description="", profile=remote_europe)
    assert onsite.location == "eligible"


def test_adjacent_role_can_be_accepted_per_listing_but_excluded_role_cannot():
    p = profile(target_titles=["Software Engineer"], target_adjacent_terms=["Security Enhancements"])
    adjacent = assess_discovered_job(
        title="Software Engineer, Security Enhancements", location="Vienna, Austria",
        remote_scope="On-site", description="", profile=p,
    )
    accepted = assess_discovered_job(
        title="Software Engineer, Security Enhancements", location="Vienna, Austria",
        remote_scope="On-site", description="", profile=p, preference_overrides=["role"],
    )
    excluded = assess_discovered_job(
        title="Security Analyst", location="Vienna, Austria", remote_scope="Hybrid",
        description="", profile=profile(target_titles=["Security Engineer"], excluded_title_patterns=["Analyst"]),
        preference_overrides=["role"],
    )
    assert adjacent.role == "target_adjacent"
    assert accepted.role == "target_match"
    assert accepted.actionable
    assert excluded.role == "excluded"


def test_required_language_is_compared_with_each_profiles_accepted_languages():
    jd = "German is required. " + "Work with customers and the engineering team. " * 12
    english = assess_discovered_job(title="Platform Engineer", location=None, remote_scope=None, description=jd, profile=profile(target_titles=["Platform Engineer"], accepted_languages=["English"]))
    german = assess_discovered_job(title="Platform Engineer", location=None, remote_scope=None, description=jd, profile=profile(target_titles=["Platform Engineer"], accepted_languages=["German"]))
    assert english.language == "eligible"
    assert german.language == "eligible"


def test_manual_language_decision_overrides_only_unknown_language_check():
    profile_data = profile(target_titles=["Security Engineer"], accepted_languages=["English"])
    description = "Responsibilities and requirements. " + "xylophone qwerty zephyr " * 20
    unclear = assess_discovered_job(
        title="Security Engineer", location="Vienna, Austria", remote_scope="Remote Europe",
        description=description, profile=profile_data,
    )
    approved = assess_discovered_job(
        title="Security Engineer", location="Vienna, Austria", remote_scope="Remote Europe",
        description=description, profile=profile_data, verified_language="accepted",
    )
    rejected = assess_discovered_job(
        title="Security Engineer", location="Vienna, Austria", remote_scope="Remote Europe",
        description=description, profile=profile_data, verified_language="rejected",
    )
    assert unclear.language == "eligible"
    assert approved.language == "eligible"
    assert rejected.language == "eligible"
    assert approved.location == rejected.location == unclear.location


def test_employment_type_is_profile_driven_and_unknown_is_not_assumed_contract():
    permanent_only = profile(target_titles=["Security Engineer"], accepted_employment_types=["permanent", "full_time"])
    contract_friendly = profile(target_titles=["Security Engineer"], accepted_employment_types=["contract", "permanent"])
    blocked = assess_discovered_job(title="Security Engineer", location=None, remote_scope=None, description="", employment_type="Contract", profile=permanent_only)
    accepted = assess_discovered_job(title="Security Engineer", location=None, remote_scope=None, description="", employment_type="Contract", profile=contract_friendly)
    unknown = assess_discovered_job(title="Security Engineer", location=None, remote_scope=None, description="", employment_type=None, profile=permanent_only)
    assert blocked.employment_type == "ineligible"
    assert accepted.employment_type == "eligible"
    assert unknown.employment_type == "unclear"

    no_contract_preference = profile(target_titles=["Security Engineer"])
    assert assess_discovered_job(title="Security Engineer", location=None, remote_scope=None, description="Offshore contract role", employment_type=None, profile=no_contract_preference).employment_type == "eligible"


def test_excluded_geography_and_seniority_are_explicit_profile_preferences():
    no_us = profile(target_titles=["Engineer"], excluded_countries=["United States"])
    result = assess_discovered_job(title="Engineer", location="US", remote_scope="Remote", description="", profile=no_us)
    assert result.location == "ineligible"

    senior_only = profile(target_titles=["Engineer"], target_seniority=["senior", "lead"])
    assert assess_discovered_job(title="Junior Engineer", location=None, remote_scope=None, description="", profile=senior_only).seniority == "ineligible"
    assert assess_discovered_job(title="Lead Engineer", location=None, remote_scope=None, description="", profile=senior_only).seniority == "eligible"

    accepted_seniority = profile(target_titles=["Engineer"], accepted_seniority=["senior", "lead"])
    assert assess_discovered_job(title="Lead Engineer", location=None, remote_scope=None, description="", profile=accepted_seniority).seniority == "eligible"


def test_manual_jobs_bypass_missing_or_incompatible_discovery_preferences():
    assert assess_discovered_job(title="Platform Engineer", location=None, remote_scope=None, description=None, profile=None, manual=True).actionable
    assert assess_discovered_job(title="Security Analyst", location="US", remote_scope="On-site", description="Contract", profile=CYBER, manual=True).actionable


def test_shared_search_profile_cases_match_scheduled_path_contract():
    fixture_path = Path(__file__).parent / "fixtures" / "search_profile_path_equivalence.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    for case in fixture["cases"]:
        result = assess_discovered_job(
            title=case["title"],
            location=case["location"],
            remote_scope=case["remote_scope"],
            description=case["description"],
            employment_type=case["employment_type"],
            description_kind="full",
            profile={"definition": fixture["profiles"][case["profile"]]},
        )
        actual = {
            "role": result.role,
            "location": result.location,
            "language": result.language,
            "employment_type": result.employment_type,
            "seniority": result.seniority,
            "actionable": result.actionable,
        }
        assert actual == case["expected"], case["name"]


def test_shared_discovery_correctness_regressions():
    fixture = json.loads((Path(__file__).parent / "fixtures/discovery_correctness.json").read_text())
    p = profile(**fixture["definition"])
    for title, expected in fixture["titles"].items():
        assert classify_role(title, p) == expected, title
    for case in fixture["geographies"]:
        result = assess_discovered_job(
            title="Security Engineer", location=case["location"], remote_scope=case.get("remote_scope"),
            description=case.get("description", ""), profile=p,
        )
        assert result.location == case["expected"], case


def test_run12_employer_geography_regressions():
    cases = json.loads((Path(__file__).parent / "fixtures/run12_geography.json").read_text())
    active = json.loads((Path(__file__).parent / "fixtures/discovery_correctness.json").read_text())
    for case in cases:
        result = assess_discovered_job(
            title=case["title"], location=case["location"], remote_scope=case["remote_scope"],
            description=case["description"], profile=profile(**active["definition"]),
        )
        assert result.location == case["expected"], case["job_id"]


def test_worldwide_alone_does_not_establish_country_employment_eligibility():
    result = assess_discovered_job(
        title="Security Engineer", location="Remote worldwide", remote_scope=None,
        description="Remote in Poland only.", profile=profile(remote_only=True, allowed_regions=["worldwide"]),
    )
    assert result.location == "unclear"


def test_user_approved_employment_type_overrides_only_the_matching_listing_type():
    constrained = profile(
        target_titles=["Security Engineer"], remote_only=True, english_only=True,
        allowed_regions=["Europe"], excluded_employment_types=["contract"],
    )
    kwargs = dict(
        title="Security Engineer", location="Europe", remote_scope="Remote Europe",
        description="This is a contract position. " + "The role requires experience with security. " * 5,
        profile=constrained, description_kind="full",
    )
    assert assess_discovered_job(**kwargs).employment_type == "ineligible"
    approved = assess_discovered_job(
        **kwargs, verified_employment_type_status="accepted", verified_employment_type="contract"
    )
    assert approved.employment_type == "eligible"
    assert "approved" in approved.employment_type_reason
    rejected = assess_discovered_job(
        **kwargs, verified_employment_type_status="rejected", verified_employment_type="contract"
    )
    assert rejected.employment_type == "ineligible"
    mismatched = assess_discovered_job(
        **kwargs, verified_employment_type_status="accepted", verified_employment_type="temporary"
    )
    assert mismatched.employment_type == "ineligible"
    accepted_only = profile(
        target_titles=["Security Engineer"], remote_only=True, english_only=True,
        allowed_regions=["Europe"], accepted_employment_types=["permanent"],
    )
    accepted_only_result = assess_discovered_job(
        **{**kwargs, "profile": accepted_only},
        verified_employment_type_status="accepted", verified_employment_type="contract",
    )
    assert accepted_only_result.employment_type == "eligible"
