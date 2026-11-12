from matching.job_metadata import manual_metadata_issues, metadata_issues, metadata_is_sane
from matching.holistic_matcher import VerifiedJob, evaluation_fingerprint
from matching.candidate_profile import representative_profile
from ui.dashboard_data import DashboardJob, dashboard_decision, filter_dashboard_jobs, group_archive_jobs, merge_dashboard_rows
from ui.manual_job import manual_metadata


def test_generic_page_headings_and_geographic_company_tokens_are_rejected():
    assert "title_is_page_heading" in metadata_issues("Pliant", "ABOUT US")
    assert "title_is_page_heading" in metadata_issues("Pliant", "THE ROLE")
    assert "company_is_geographic_or_navigation_token" in metadata_issues("US", "Security Engineer")
    assert "company_is_geographic_or_navigation_token" in metadata_issues("Remote", "Security Engineer")
    assert "company_is_geographic_or_navigation_token" in metadata_issues("Unknown company", "Security Engineer")
    assert "company_is_geographic_or_navigation_token" not in manual_metadata_issues("Unknown company", "Security Engineer")


def test_short_real_company_names_and_titles_with_generic_words_are_preserved():
    assert metadata_is_sane("AI", "Head of Careers")
    assert metadata_is_sane("OK", "Director, Who We Are")
    assert metadata_is_sane("US Foods", "Security Engineer")
    assert metadata_is_sane("Crown Holdings, Inc.", "Security Engineer")
    assert metadata_is_sane("OVS S.p.A.", "Security Engineer")


def test_manual_jd_fallback_does_not_promote_headings_to_metadata():
    pliant_jd = """ABOUT US

Pliant is a modular B2B payments platform headquartered in Berlin.

About the Role

We are looking for a hands-on Security Engineer to build secure foundations.
"""
    assert manual_metadata(pliant_jd) == ("Manual listing", "Pliant")
    assert manual_metadata("About the Role\n\nWe are hiring someone.") == (
        "Manual listing", "Unknown company"
    )
    assert manual_metadata(pliant_jd, title="  Security Engineer  ", company=" Pliant ") == (
        "Security Engineer", "Pliant"
    )


def test_unresolved_discovered_metadata_blocks_actionability_but_not_liveness():
    job = DashboardJob(
        id=1, source="aggregator", company="US", title="ABOUT US", location="Europe",
        remote_scope="Remote", source_url="https://example.test/1", application_url=None,
        availability_status="active", verification_status="verified", review_status="new",
        posted_at=None, first_seen_at=None, last_seen_at=None, fit_score=None,
        fit_assessment_id=None, description="Full JD", description_kind="full",
        role_eligibility="target_match", location_eligibility="eligible",
        language_eligibility="eligible", metadata_quality_issues=tuple(metadata_issues("US", "ABOUT US")),
    )
    assert job.metadata_unresolved
    assert not job.actionable
    assert not job.ready_to_rate
    assert job.availability_status == "active"
    assert filter_dashboard_jobs([job], review_status="Unaddressed") == []


def test_explicit_location_rejection_resolves_review_priority_without_clearing_metadata_issue():
    job = DashboardJob(
        id=8, source="aggregator", company="Harmonic Security Inc.",
        title="Senior Software Security Engineer (£98k-£115k + Equity)",
        location="London", remote_scope=None, source_url="https://example.test/8",
        application_url=None, availability_status="active", verification_status="verified",
        review_status="new", posted_at=None, first_seen_at=None, last_seen_at=None,
        fit_score=None, fit_assessment_id=None, role_eligibility="target_match",
        location_eligibility="ineligible", location_reason="Location manually rejected by the user.",
        verified_location_status="rejected", metadata_quality_issues=("title_metadata_needs_review",),
    )

    assert job.pending_category is None
    assert dashboard_decision(job).primary_reason_code == "location_incompatible"
    assert group_archive_jobs([job])[0][0] == "Preference mismatches"
    assert job.metadata_unresolved

    approved = DashboardJob(
        **{**job.__dict__, "location_eligibility": "eligible", "verified_location_status": "accepted"}
    )
    assert approved.pending_category == "Metadata unresolved"


def test_correct_metadata_restores_discovered_actionability_without_search_profile_changes():
    base = dict(
        id=2, source="aggregator", location="Europe", remote_scope="Remote",
        source_url="https://example.test/2", application_url=None,
        availability_status="active", verification_status="verified", review_status="new",
        posted_at=None, first_seen_at=None, last_seen_at=None, fit_score=None,
        fit_assessment_id=None, description="Full JD", description_kind="full",
        role_eligibility="target_match", location_eligibility="eligible",
        language_eligibility="eligible",
    )
    unresolved = DashboardJob(**base, company="US", title="ABOUT US", metadata_quality_issues=("title_is_page_heading",))
    corrected = DashboardJob(**base, company="Pliant", title="Security Engineer")
    assert not unresolved.actionable
    assert corrected.actionable
    assert corrected.ready_to_rate
    assert corrected.role_eligibility == unresolved.role_eligibility


def test_manual_fallback_values_remain_usable():
    manual = DashboardJob(
        id=3, source="manual", company="Unknown company", title="Manual listing",
        location=None, remote_scope=None, source_url=None, application_url=None,
        availability_status="active", verification_status=None, review_status="new",
        posted_at=None, first_seen_at=None, last_seen_at=None, fit_score=None,
        fit_assessment_id=None, description="A user supplied full JD", description_kind="full",
        is_manual=True,
    )
    assert not manual.metadata_unresolved
    assert manual.actionable
    assert manual.ready_to_rate


def test_manual_fallback_does_not_hide_a_bad_inferred_company():
    manual = DashboardJob(
        id=4, source="manual", company="the Role", title="Manual listing",
        location=None, remote_scope=None, source_url=None, application_url="https://example.test/job",
        availability_status="active", verification_status=None, review_status="new",
        posted_at=None, first_seen_at=None, last_seen_at=None, fit_score=55,
        fit_assessment_id=31, description="A user supplied full JD", description_kind="full",
        is_manual=True, metadata_quality_issues=tuple(manual_metadata_issues("the Role", "Manual listing")),
    )
    assert manual.metadata_unresolved
    assert not manual.actionable
    assert not manual.ready_to_rate
    assert manual.fit_score == 55


def test_merge_flags_malformed_manual_company_but_allows_intentional_fallbacks():
    bad, good = merge_dashboard_rows(
        [
            {"id": 20, "source": "manual", "company": "US", "title": "ABOUT US", "availability_status": "active", "description": "full", "description_kind": "full"},
            {"id": 21, "source": "manual", "company": "Unknown company", "title": "Manual listing", "availability_status": "active", "description": "full", "description_kind": "full"},
        ], [], [],
    )
    assert bad.metadata_unresolved
    assert not bad.actionable
    assert not good.metadata_unresolved
    assert good.actionable


def test_manual_intentional_fallback_can_have_one_known_field():
    assert manual_metadata_issues("Pliant", "Manual listing") == []
    assert manual_metadata_issues("Unknown company", "Security Engineer") == []


def test_title_repair_changes_fit_fingerprint_but_company_repair_does_not():
    profile = representative_profile()
    common = {
        "description": "The exact same complete job description.",
        "source_url": "https://jobs.ashbyhq.com/pliant/a0b4660b-2bc6-4e40-addf-cf64072bf3ce",
    }
    before = VerifiedJob(title="ABOUT US", company="US", **common)
    after = VerifiedJob(title="Security Engineer *EU/UK remote* (m/f/d)", company="Pliant", **common)
    assert evaluation_fingerprint(candidate_profile=profile, job=before) != evaluation_fingerprint(
        candidate_profile=profile, job=after
    )
    company_only = VerifiedJob(
        title=before.title,
        company="Pliant",
        description=before.description,
        source_url=before.source_url,
    )
    assert evaluation_fingerprint(candidate_profile=profile, job=before) == evaluation_fingerprint(
        candidate_profile=profile, job=company_only
    )
