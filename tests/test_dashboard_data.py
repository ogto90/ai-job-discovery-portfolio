from dataclasses import replace
import hashlib

from ui.dashboard_data import DashboardJob, application_view_jobs, can_archive_job, can_rate_job, can_select_job, filter_dashboard_jobs, group_application_jobs, group_archive_jobs, group_dashboard_jobs, job_pdf_filename, merge_dashboard_rows, paginate_job_groups, sort_dashboard_jobs


def test_job_pdf_filename_uses_company_and_title_without_redundant_suffix():
    assert job_pdf_filename("A/B Corp", "Security Engineer") == "A-B Corp - Security Engineer.pdf"
    assert job_pdf_filename(None, None) == "resume.pdf"


def test_paginate_job_groups_pages_across_group_boundaries():
    groups = [("Archived", [job(i) for i in range(1, 4)]), ("Not actionable", [job(i) for i in range(4, 7)])]

    first, total, first_item, last_item = paginate_job_groups(groups, page=1, page_size=4)
    second, _, second_first, second_last = paginate_job_groups(groups, page=2, page_size=4)

    assert [(label, [item.id for item in rows]) for label, rows in first] == [
        ("Archived", [1, 2, 3]), ("Not actionable", [4])
    ]
    assert [(label, [item.id for item in rows]) for label, rows in second] == [("Not actionable", [5, 6])]
    assert (total, first_item, last_item) == (6, 1, 4)
    assert (second_first, second_last) == (5, 6)


def job(job_id, *, score=None, last_seen="2026-10-01T00:00:00+00:00", status="new"):
    return DashboardJob(
        id=job_id,
        source="test",
        company=f"Company {job_id}",
        title=f"Security Role {job_id}",
        location="Europe",
        remote_scope="Remote Europe",
        source_url=f"https://example.test/{job_id}",
        application_url=None,
        availability_status="active",
        verification_status="verified",
        review_status=status,
        posted_at=None,
        first_seen_at="2026-09-01T00:00:00+00:00",
        last_seen_at=last_seen,
        fit_score=score,
        fit_assessment_id=10 if score is not None else None,
        role_eligibility="target_match",
        location_eligibility="eligible",
        language_eligibility="eligible",
    )


def test_merge_uses_latest_fit_and_application_and_ignores_legacy_assessments():
    rows = merge_dashboard_rows(
        [{"id": 1, "company": "Acme", "title": "Security Lead", "availability_status": "active"}],
        [
            {"job_id": 1, "status": "seen", "updated_at": "2026-10-01T00:00:00Z", "created_at": "2026-09-01T00:00:00Z"},
            {"job_id": 1, "status": "applied", "updated_at": "2026-10-02T00:00:00Z", "created_at": "2026-09-01T00:00:00Z"},
        ],
        [
            {"id": 1, "job_id": 1, "fit_score": 99, "matcher_version": "holistic_match_v1", "created_at": "2026-10-04T00:00:00Z"},
            {"id": 2, "job_id": 1, "fit_score": 78, "matcher_version": "holistic_fit_v1", "created_at": "2026-10-03T00:00:00Z"},
        ],
    )
    assert rows[0].fit_score == 78
    assert rows[0].review_status == "applied"


def test_merge_preserves_fit_explanation_bullets():
    rows = merge_dashboard_rows(
        [{"id": 1, "company": "Acme", "title": "Security Lead", "availability_status": "active"}],
        [],
        [{
            "id": 3,
            "job_id": 1,
            "fit_score": 78,
            "matcher_version": "holistic_fit_v1",
            "strengths": ["Owned vulnerability management"],
            "gaps": ["Limited AWS production evidence"],
            "created_at": "2026-10-04T00:00:00Z",
        }],
    )
    assert rows[0].fit_strengths == ("Owned vulnerability management",)
    assert rows[0].fit_gaps == ("Limited AWS production evidence",)


def test_per_listing_preference_override_is_applied_and_retained_on_card():
    profile = {"definition": {
        "target_titles": ["Security Engineer"], "remote_only": True,
        "work_models": ["remote"], "allowed_regions": ["Europe"],
    }}
    source = [{
        "id": 44, "source": "test", "company": "Acme", "title": "Security Engineer",
        "location": "United States", "remote_scope": "On-site",
        "availability_status": "active",
    }]
    row = merge_dashboard_rows(
        source, [], [], search_profile=profile,
        preference_overrides=[{
            "job_id": 44, "overridden_preferences": ["location"],
            "is_active": True, "accepted_at": "2026-10-31T12:00:00Z",
            "updated_at": "2026-10-31T12:00:00Z",
        }],
    )[0]
    assert row.preference_override_fields == ("location",)
    assert row.location_eligibility == "eligible"
    assert row.work_model_eligibility == "eligible"
    assert profile["definition"]["allowed_regions"] == ["Europe"]


def test_language_and_work_model_never_block_actionability_and_role_override_is_scoped():
    profile = {"definition": {
        "target_titles": ["Software Engineer"],
        "target_adjacent_terms": ["Security Enhancements"],
        "accepted_languages": ["English"], "work_models": ["remote"],
    }}
    row = {
        "id": 45, "source": "test", "company": "Acme",
        "title": "Software Engineer, Security Enhancements",
        "location": "Vienna, Austria", "remote_scope": "On-site",
        "description": "German is required. " + "Build products with the team. " * 12,
        "description_kind": "full", "availability_status": "active",
    }
    baseline = merge_dashboard_rows([row], [], [], search_profile=profile)[0]
    accepted = merge_dashboard_rows(
        [row], [], [], search_profile=profile,
        preference_overrides=[{
            "job_id": 45, "overridden_preferences": ["role"], "is_active": True,
            "updated_at": "2026-11-02T10:00:00Z",
        }],
    )[0]
    assert baseline.role_eligibility == "target_adjacent"
    assert baseline.language_eligibility == baseline.work_model_eligibility == "eligible"
    assert not baseline.actionable
    assert accepted.role_eligibility == "target_match"
    assert accepted.actionable


def test_location_preference_acceptance_restores_a_previously_rejected_listing():
    row = {
        "id": 46, "source": "test", "company": "Acme", "title": "Security Engineer",
        "location": "United States", "remote_scope": "Remote United States",
        "description": (
            "Responsibilities: Design security controls, lead reviews, implement safeguards, "
            "support engineering teams, investigate vulnerabilities, coordinate remediation, "
            "and communicate technical risk. Requirements: Bring relevant security experience, "
            "clear communication, and the ability to partner with product and engineering teams. "
        ) * 3,
        "description_kind": "full", "availability_status": "active",
    }
    profile = {"definition": {"target_titles": ["Security Engineer"], "allowed_regions": ["Europe"]}}
    rejected = merge_dashboard_rows(
        [row], [], [], search_profile=profile,
        location_verifications=[{"job_id": 46, "location_status": "rejected", "verified_at": "2026-10-01T00:00:00Z"}],
    )[0]
    accepted = merge_dashboard_rows(
        [row], [], [], search_profile=profile,
        location_verifications=[{"job_id": 46, "location_status": "rejected", "verified_at": "2026-10-01T00:00:00Z"}],
        preference_overrides=[{"job_id": 46, "overridden_preferences": ["location"], "is_active": True}],
    )[0]
    assert rejected.decision.primary_reason_code == "location_incompatible"
    assert accepted.location_eligibility == "eligible"
    assert accepted.actionable
    assert accepted.ready_to_rate


def test_application_status_takes_precedence_over_newer_archive_review():
    rows = merge_dashboard_rows(
        [{"id": 1, "company": "Acme", "title": "Security Lead", "availability_status": "active"}],
        [{"job_id": 1, "status": "applied", "updated_at": "2026-10-01T00:00:00Z"}],
        [],
        [{"job_id": 1, "status": "ignored", "updated_at": "2026-10-04T00:00:00Z"}],
    )
    assert rows[0].review_status == "applied"
    assert filter_dashboard_jobs(rows)[0:] == []
    assert filter_dashboard_jobs(rows, review_status="Archive") == []
    assert group_dashboard_jobs(rows) == []
    assert group_archive_jobs(rows) == []
    assert [row.review_status for row in application_view_jobs(rows)] == ["applied"]


def test_bulk_archive_eligibility_matches_actionable_and_pending_cards():
    assert can_archive_job(job(1))
    assert can_archive_job(replace(job(2), availability_status="unknown"))
    assert not can_archive_job(replace(job(3), review_status="ignored"))
    assert can_archive_job(replace(job(4), review_status="applied"))
    assert can_archive_job(replace(job(5), role_eligibility="unrelated"))


def test_general_selection_supports_ignore_and_rate_when_each_is_applicable():
    ready = replace(job(1), description="Full JD", description_kind="full")
    ignored_state = replace(job(2), review_status="ignored")
    pending = replace(job(3), availability_status="unknown")
    assert can_rate_job(ready)
    assert can_select_job(ready)
    assert not can_rate_job(pending)
    assert can_select_job(pending)
    assert not can_select_job(ignored_state)
    rated = replace(ready, fit_score=74, fit_assessment_id=9)
    assert can_select_job(rated)
    assert not can_rate_job(rated)


def test_dashboard_applies_only_matching_user_contract_decision_for_same_jd():
    description = "This is a contract position. " + "The security engineer will work with the team and build secure systems. " * 8
    profile = {"definition": {
        "target_titles": ["Security Engineer"], "remote_only": True,
        "english_only": True, "allowed_regions": ["Europe"],
        "excluded_employment_types": ["contract"],
    }}
    verification = {
        "job_id": 44, "employment_type": "contract", "decision": "accepted",
        "jd_sha256": hashlib.sha256(description.encode("utf-8")).hexdigest(),
        "verified_at": "2026-10-10T00:00:00Z",
    }
    source = [{
        "id": 44, "source": "test", "company": "Acme", "title": "Security Engineer",
        "location": "Europe", "remote_scope": "Remote Europe", "description": description,
        "description_kind": "full", "availability_status": "active",
    }]
    approved = merge_dashboard_rows(
        source, [], [], search_profile=profile, employment_type_verifications=[verification]
    )[0]
    stale = merge_dashboard_rows(
        [{**source[0], "description": description + " Updated details."}], [], [],
        search_profile=profile, employment_type_verifications=[verification],
    )[0]
    assert approved.employment_type_decision == "accepted"
    assert approved.employment_type_eligibility == "eligible"
    assert stale.employment_type_decision is None
    assert stale.employment_type_eligibility == "ineligible"


def test_unaddressed_keeps_new_and_seen_but_excludes_user_actions_and_closed_jobs():
    rows = [
        job(1, status="new"),
        job(2, status="interested"),
        job(3, status="applied"),
        job(4, status="ignored"),
        job(5, status="rejected"),
        replace(job(6, status="new"), availability_status="expired"),
    ]
    assert [row.id for row in filter_dashboard_jobs(rows)] == [1, 2]
    assert [row.id for row in filter_dashboard_jobs(rows, review_status="Applied")] == [3]
    assert [row.id for row in filter_dashboard_jobs(rows, review_status="Archive")] == [4, 6]
    assert [row.id for row in filter_dashboard_jobs(rows, review_status="Rejected / Closed")] == [5]


def test_needs_attention_keeps_unclear_items_but_sends_known_mismatches_to_archive():
    actionable = job(21)
    pending = replace(job(22), location_eligibility="unclear", location_reason="Location needs review.")
    mismatch = replace(job(23), location_eligibility="ineligible", location_reason="Location conflicts.")
    already_handled = replace(job(24, status="rejected"), location_eligibility="ineligible")
    attention = filter_dashboard_jobs(
        [actionable, pending, mismatch, already_handled], review_status="Needs attention"
    )
    assert [row.id for row in attention] == [21, 22]
    archived = filter_dashboard_jobs(
        [actionable, pending, mismatch, already_handled], review_status="Archive"
    )
    assert [row.id for row in archived] == [23]


def test_unaddressed_shows_live_jobs_needing_a_jd_but_hides_unverified_jobs():
    live_missing = replace(job(7, status="new"), description=None, description_kind="missing")
    verification_pending = replace(live_missing, id=8, availability_status="unknown")
    assert [row.id for row in filter_dashboard_jobs([live_missing, verification_pending])] == [7]


def test_unaddressed_hides_validation_failed_jobs_until_live_verification():
    failed_validation = replace(job(9, status="new"), availability_status="validation_failed")
    assert filter_dashboard_jobs([failed_validation]) == []


def test_manual_live_confirmation_moves_full_jd_to_ready_to_rate():
    confirmed = replace(
        job(9, status="new"),
        availability_status="validation_failed",
        user_verification_status="confirmed_live",
        description="Full job description " * 40,
        description_kind="full",
    )
    assert confirmed.live_for_user
    assert confirmed.ready_to_rate
    assert confirmed.pending_category is None
    assert [row.id for row in filter_dashboard_jobs([confirmed])] == [9]


def test_merge_loads_user_scoped_manual_verification():
    merged = merge_dashboard_rows(
        [{
            "id": 91, "source": "himalayas-search", "company": "Acme",
            "title": "Security Engineer", "location": "Europe",
            "remote_scope": "Remote Europe", "source_url": "https://example.test/91",
            "description": "A full security job description. " * 30,
            "description_kind": "full", "availability_status": "validation_failed",
        }],
        [],
        [],
        search_profile={"definition": {
            "target_titles": ["Security Engineer"], "role_families": ["Security Engineer"],
            "remote_only": True, "english_only": True,
            "eligibility_constraints": {"remote_scope": "Austria/EU/EEA/EMEA/Europe/worldwide"},
        }},
        user_verifications=[{
            "job_id": 91, "verification_status": "confirmed_live",
            "verification_reason": None, "checked_at": "2026-10-06T10:00:00Z",
        }],
    )
    assert len(merged) == 1
    assert merged[0].user_verification_status == "confirmed_live"
    assert merged[0].live_for_user


def test_user_language_decision_changes_only_language_eligibility():
    job_row = {
        "id": 92, "source": "ashby", "company": "Example", "title": "Security Engineer",
        "location": "Vienna, Austria", "remote_scope": "Remote Europe",
        "source_url": "https://example.test/92", "description": "Responsibilities and requirements. " + "xylophone qwerty zephyr " * 20,
        "description_kind": "full", "availability_status": "active",
    }
    search_profile = {"definition": {
        "target_titles": ["Security Engineer"], "work_models": ["remote"],
        "allowed_regions": ["Europe"], "accepted_languages": ["English"],
    }}
    base = merge_dashboard_rows([job_row], [], [], search_profile=search_profile)[0]
    approved = merge_dashboard_rows(
        [job_row], [], [], search_profile=search_profile,
        language_verifications=[{"job_id": 92, "language_status": "accepted", "verified_at": "2026-10-09T10:00:00Z"}],
    )[0]
    rejected = merge_dashboard_rows(
        [job_row], [], [], search_profile=search_profile,
        language_verifications=[{"job_id": 92, "language_status": "rejected", "verified_at": "2026-10-09T10:00:00Z"}],
    )[0]
    assert base.language_eligibility == "eligible"
    assert approved.language_eligibility == "eligible"
    assert rejected.language_eligibility == "eligible"
    assert approved.location_eligibility == base.location_eligibility


def test_user_location_decision_resolves_only_location_and_is_user_scoped():
    row = {
        "id": 93, "source": "linkedin", "company": "Example", "title": "Security Engineer",
        "location": "Vienna", "remote_scope": None, "source_url": "https://example.test/93",
        "description": "", "description_kind": "missing", "availability_status": "active",
    }
    profile = {"definition": {
        "target_titles": ["Security Engineer"], "work_models": ["remote"],
        "allowed_regions": ["Europe"], "remote_only": True,
    }}
    base = merge_dashboard_rows([row], [], [], search_profile=profile)[0]
    accepted = merge_dashboard_rows(
        [row], [], [], search_profile=profile,
        location_verifications=[{"job_id": 93, "location_status": "accepted", "verified_at": "2026-10-09T10:00:00Z"}],
    )[0]
    rejected = merge_dashboard_rows(
        [row], [], [], search_profile=profile,
        location_verifications=[{"job_id": 93, "location_status": "rejected", "verified_at": "2026-10-09T10:00:00Z"}],
    )[0]
    assert base.location_eligibility == "eligible"
    assert accepted.location_eligibility == "eligible"
    assert accepted.verified_location_status == "accepted"
    assert accepted.location_checked_at == "2026-10-09T10:00:00Z"
    assert accepted.work_model_eligibility == base.work_model_eligibility
    assert rejected.location_eligibility == "ineligible"


def test_manual_work_model_confirmation_rechecks_profile_and_makes_compatible_job_rateable():
    full_description = """English required. Responsibilities:
    Build secure product architecture and advise engineering groups during early feature planning.
    Assess application risks, threat scenarios, and control gaps across customer-facing services.
    Partner with developers to improve code safety and prevent recurring security defects.
    Design practical security reviews that fit modern delivery workflows and release schedules.
    Investigate vulnerability reports, coordinate remediation, and verify fixes with service owners.
    Establish clear product security standards, reusable guidance, and measurable engineering practices.
    Review authentication, authorization, data protection, and cryptographic design decisions.
    Help teams integrate automated checks into build pipelines without slowing routine delivery.
    Communicate technical findings to product leaders and recommend proportionate mitigation options.
    Track risk trends, identify systemic weaknesses, and prioritize improvements across portfolios.
    Support incident investigations involving application behavior, customer data, or exposed credentials.
    Explain security tradeoffs clearly while balancing usability, resilience, and delivery constraints.
    Collaborate across distributed teams to strengthen secure development habits and shared ownership."""
    merged = merge_dashboard_rows(
        [{
            "id": 92, "source": "ashby", "company": "Staffbase",
            "title": "Senior Product Security Engineer", "location": "Vienna, Austria",
            "remote_scope": None, "source_url": "https://example.test/staffbase/92",
            "description": full_description,
            "description_kind": "full", "availability_status": "active",
        }],
        [], [],
        search_profile={"definition": {
            "target_titles": ["Senior Product Security Engineer"],
            "work_models": ["remote"], "allowed_regions": ["Austria", "Europe"],
            "accepted_languages": ["English"],
            "eligibility_constraints": {"remote_scope": "Austria/Europe"},
        }},
        work_model_verifications=[{
            "job_id": 92, "work_model": "remote", "verified_at": "2026-10-08T10:00:00Z",
        }],
    )
    assert len(merged) == 1
    assert merged[0].verified_work_model == "remote"
    assert merged[0].work_model_eligibility == "eligible"
    assert merged[0].actionable
    assert merged[0].ready_to_rate


def test_manual_failed_verification_reason_remains_visible_in_pending():
    failed = replace(
        job(10, status="new"),
        availability_status="validation_failed",
        user_verification_status="unable_to_verify",
        user_verification_reason="The page is blocked or inaccessible",
    )
    assert not failed.live_for_user
    assert failed.pending_category == "Verification needed"
    assert "The page is blocked or inaccessible" in failed.pending_reason
    assert filter_dashboard_jobs([failed]) == []
    assert [row.id for row in filter_dashboard_jobs([failed], review_status="Pending / unresolved")] == [10]


def test_unaddressed_requires_role_live_remote_and_language_eligibility_but_keeps_manual_jobs():
    rows = [
        job(11),
        replace(job(12), role_eligibility="unrelated"),
        replace(job(13), role_eligibility="target_adjacent"),
        replace(job(14), location_eligibility="unclear"),
        replace(job(15), location_eligibility="ineligible"),
        replace(job(16), language_eligibility="ineligible"),
        replace(job(17), availability_status="validation_failed"),
        replace(job(18), is_manual=True, role_eligibility="unrelated", location_eligibility="unclear"),
    ]
    assert [row.id for row in filter_dashboard_jobs(rows)] == [11, 16, 18]


def test_existing_rows_receive_derived_search_profile_eligibility_without_mutating_row_lifecycle():
    row = merge_dashboard_rows(
        [{
            "id": 19, "source": "discovered", "company": "Chainguard",
            "title": "Senior Software Engineer", "availability_status": "active",
            "location": "Remote Europe", "remote_scope": "Full Remote",
        }],
        [],
        [],
        search_profile={"definition": {"remote_only": True, "english_only": True, "eligibility_constraints": {"remote_scope": "Austria/EU/EEA/EMEA/Europe/worldwide"}}},
    )[0]
    assert row.availability_status == "active"
    assert row.role_eligibility == "unclear"
    assert row.actionable is False


def test_location_eligibility_prefers_restrictive_jd_and_unknown_remote_is_not_eligible():
    from matching.job_eligibility import assess_discovered_job

    profile = {"definition": {"remote_only": True, "english_only": True, "allowed_regions": ["Europe", "EEA", "EU", "EMEA"], "eligibility_constraints": {"remote_scope": "Austria/EU/EEA/EMEA/Europe"}}}
    restricted = assess_discovered_job(
        title="Security Engineer", location="Anywhere in the World", remote_scope="Worldwide",
        description="This role is remote within the United States only. " + "Work with our team on security. " * 8,
        profile=profile,
    )
    assert restricted.location == "ineligible"
    missing = assess_discovered_job(title="Security Engineer", location="Vienna", remote_scope=None, description="", profile=profile)
    assert missing.location == "eligible"


def test_manual_jobs_bypass_discovery_eligibility():
    from matching.job_eligibility import assess_discovered_job

    decision = assess_discovered_job(title="Platform Engineer", location=None, remote_scope=None, description=None, profile=None, manual=True)
    assert decision.actionable is True


def test_missing_fit_is_not_scored_yet_and_legacy_fields_are_not_needed():
    rows = merge_dashboard_rows(
        [{"id": 1, "company": "Acme", "title": "Security Lead", "availability_status": "active"}],
        [],
        [],
    )
    assert rows[0].fit_score is None
    assert rows[0].direct_url is None
    assert rows[0].description_kind == "missing"


def test_dashboard_preserves_full_description_state_for_manual_rating():
    full_description = (
        "Responsibilities: Lead application security reviews, design practical controls, implement improvements, "
        "support product teams, assess vulnerabilities, respond to incidents, and maintain risk registers. "
        "Qualifications: Collaborate with engineering teams, communicate clearly, own delivery, and establish "
        "sustainable security practices across products and business functions."
    )
    rows = merge_dashboard_rows(
        [{
            "id": 2,
            "company": "Acme",
            "title": "Security Lead",
            "availability_status": "active",
            "description": full_description,
            "description_kind": "full",
        }],
        [],
        [],
    )
    assert rows[0].description == full_description
    assert rows[0].description_kind == "full"


def test_merge_recognizes_valid_full_jd_tagged_as_partial_and_rejects_fake_full_tag():
    valid = "Responsibilities: Lead security reviews, design controls, implement improvements, support teams, and assess risk. Qualifications: Communicate clearly, collaborate broadly, and own delivery. " * 3
    rows = merge_dashboard_rows(
        [
            {"id": 44, "company": "Compact", "title": "Security Engineer", "availability_status": "active", "description": valid, "description_kind": "snippet"},
            {"id": 45, "company": "Teaser", "title": "Security Engineer", "availability_status": "active", "description": "Join our team to help build innovative products and improve security across the company. " * 8, "description_kind": "full"},
        ], [], [], search_profile={"definition": {"target_titles": ["Security Engineer"]}},
    )
    assert {row.id: row.description_kind for row in rows} == {44: "full", 45: "snippet"}


def test_expired_tailored_artifact_is_not_available_on_dashboard():
    rows = merge_dashboard_rows(
        [{"id": 12, "company": "Acme", "title": "Security Lead", "availability_status": "active"}],
        [],
        [],
        tailored_versions=[{
            "id": 22,
            "job_id": 12,
            "storage_bucket": "cv-artifacts",
            "tex_file_path": "user/tailored/12/cv.tex",
            "pdf_file_path": "user/tailored/12/cv.pdf",
            "expires_at": "2020-01-01T00:00:00Z",
            "created_at": "2019-01-01T00:00:00Z",
        }],
    )
    assert rows[0].tailored_artifact_available is False


def test_sort_puts_scored_highest_then_newest_and_keeps_unscored():
    ordered = sort_dashboard_jobs([
        job(1, score=None, last_seen="2026-10-03T00:00:00+00:00"),
        job(2, score=70, last_seen="2026-10-01T00:00:00+00:00"),
        job(3, score=90, last_seen="2026-09-01T00:00:00+00:00"),
    ])
    assert [row.id for row in ordered] == [3, 2, 1]


def test_rating_groups_are_descending_and_unscored_is_separate():
    groups = group_dashboard_jobs([
        job(1, score=95),
        job(2, score=82),
        job(3, score=49),
        job(4, score=70),
        job(5, score=None),
    ])
    assert [(label, [row.id for row in rows]) for label, rows in groups] == [
        ("90–100", [1]),
        ("80–89", [2]),
        ("70–79", [4]),
        ("Under 50", [3]),
        ("JD required", [5]),
    ]


def test_ignored_jobs_have_a_separate_group_not_a_jd_required_group():
    groups = group_dashboard_jobs([
        replace(job(1, score=None), review_status="ignored"),
        job(2, score=None),
    ])
    assert [(label, [row.id for row in rows]) for label, rows in groups] == [("JD required", [2])]


def test_filters_are_local_and_keep_unscored_for_minimum_fit():
    rows = [job(1, score=78), job(2, score=55), job(3, score=None)]
    filtered = filter_dashboard_jobs(rows, minimum_fit=70)
    assert [row.id for row in filtered] == [1, 3]
    assert [row.id for row in filter_dashboard_jobs(rows, score_state="Unscored")] == [3]
    assert [row.id for row in filter_dashboard_jobs(rows, search="company 2")] == [2]


def test_definitively_irrelevant_unhandled_jobs_are_hidden_but_review_history_remains():
    unrelated = replace(job(10), role_eligibility="unrelated")
    excluded = replace(job(11), role_eligibility="excluded")
    applied = replace(unrelated, id=12, review_status="applied")
    ignored = replace(excluded, id=13, review_status="ignored")
    rows = [unrelated, excluded, applied, ignored]

    assert filter_dashboard_jobs(rows, review_status="All") == []
    assert filter_dashboard_jobs(rows, review_status="Unaddressed") == []
    assert filter_dashboard_jobs(rows, review_status="Applied") == [applied]
    assert filter_dashboard_jobs(rows, review_status="Applications") == [applied]
    assert filter_dashboard_jobs(rows, review_status="Archive") == [unrelated, excluded, ignored]
    assert [row.id for row in filter_dashboard_jobs(rows, review_status="Archive", archive_category_filter="Archived")] == [13]
    assert [row.id for row in filter_dashboard_jobs(rows, review_status="Archive", archive_category_filter="Not actionable")] == [10, 11]


def test_applications_are_separate_from_jobs_and_grouped_by_workflow_stage():
    rows = [
        job(1, status="new"),
        job(2, status="applied"),
        job(3, status="interview"),
        job(4, status="offer"),
        job(5, status="rejected"),
    ]
    assert {row.id for row in filter_dashboard_jobs(rows, review_status="All")} == {1}
    visible = filter_dashboard_jobs(rows, review_status="Applications")
    assert {row.id for row in visible} == {2, 3, 4, 5}
    assert [(label, [row.id for row in group]) for label, group in group_application_jobs(visible)] == [
        ("Applied", [2]),
        ("Interview", [3]),
        ("Offer", [4]),
        ("Closed applications", [5]),
    ]


def test_application_view_uses_application_status_even_when_review_is_archived():
    archived_review = replace(job(1, status="archived"), application_status="applied")
    not_an_application = job(2, status="new")
    application_rows = application_view_jobs([archived_review, not_an_application])
    assert [(row.id, row.review_status) for row in application_rows] == [(1, "applied")]
    assert [row.id for row in filter_dashboard_jobs(application_rows, review_status="Active applications")] == [1]
    assert filter_dashboard_jobs([archived_review], review_status="Archive") == []


def test_fit_state_filter_separates_jd_required_ready_and_real_rating_failure():
    rows = [
        job(1, score=78),
        replace(job(2, score=None), description_kind="missing"),
        replace(job(3, score=None), description="A complete verified job description.", description_kind="full"),
        replace(job(4, score=None), description="A complete verified job description.", description_kind="full", fit_fingerprint="a" * 64, fit_attempt_failed=True),
    ]
    assert [row.id for row in filter_dashboard_jobs(rows, score_state="JD required")] == [2]
    assert [row.id for row in filter_dashboard_jobs(rows, score_state="Ready to rate")] == [3]
    assert [row.id for row in filter_dashboard_jobs(rows, score_state="Rating failed")] == [4]


def test_jd_required_requires_live_actionable_unhandled_job():
    eligible_missing = job(31, score=None)
    rows = [
        eligible_missing,
        replace(job(32, score=None), location_eligibility="ineligible"),
        replace(job(33, score=None), location_eligibility="unclear"),
        replace(job(34, score=None), role_eligibility="unrelated"),
        replace(job(35, score=None), role_eligibility="excluded"),
        replace(job(36, score=None), availability_status="validation_failed"),
        replace(job(37, score=None), availability_status="unknown"),
        replace(job(38, score=None), availability_status="expired"),
        replace(job(39, score=None), review_status="applied"),
        replace(job(40, score=None), review_status="ignored"),
        replace(job(41, score=None), language_eligibility="unclear"),
        replace(job(42, score=None), employment_type_eligibility="ineligible"),
    ]
    assert [row.id for row in filter_dashboard_jobs(rows, review_status="All", score_state="JD required")] == [31, 41]
    groups = dict(group_dashboard_jobs(rows))
    assert [row.id for row in groups["JD required"]] == [31, 41]
    assert {row.id for row in groups["Pending / unresolved"]} == {33, 36, 37}
    archive_groups = dict(group_archive_jobs(filter_dashboard_jobs(rows, review_status="Archive")))
    assert {row.id for row in archive_groups["Preference mismatches"]} == {32, 42}
    assert {row.id for row in archive_groups["Not actionable"]} >= {34, 35, 38}
    assert "Not actionable" not in groups
    application_groups = dict(group_application_jobs(filter_dashboard_jobs(rows, review_status="Applications")))
    assert [row.id for row in application_groups["Applied"]] == [39]


def test_preference_mismatches_are_reviewable_only_in_archive_secondary_cohort():
    hybrid = replace(job(51, score=None), work_model_eligibility="ineligible", work_model_reason="Remote work required; this role is hybrid.")
    location = replace(job(52, score=None), location_eligibility="ineligible", location_reason="Candidates must be based in Poland.")
    language = replace(job(53, score=None), language_eligibility="ineligible", language_reason="German required.")
    unknown = replace(job(54, score=None), work_model_eligibility="unclear", work_model_reason="Work model not stated.")
    rows = [hybrid, location, language, unknown]

    assert {row.id for row in filter_dashboard_jobs(rows, review_status="Unaddressed")} == {51, 53, 54}
    assert [row.id for row in filter_dashboard_jobs(rows, review_status="Archive", archive_category_filter="Preference mismatches")] == [52]
    assert {row.id for row in filter_dashboard_jobs(rows, review_status="Pending / unresolved")} == set()
    assert hybrid.decision.state == "jd_required"
    assert location.decision.primary_reason_detail == "Candidates must be based in Poland."
    assert language.decision.primary_reason_code == "full_jd_required"
    assert all(can_archive_job(row) for row in rows)


def test_full_but_unscored_actionable_job_is_not_jd_required():
    full = replace(job(43, score=None), description="A complete verified job description.", description_kind="full")
    assert full.ready_to_rate
    assert not full.rating_failed
    assert not full.jd_required
    assert filter_dashboard_jobs([full], score_state="JD required") == []
    assert [row.id for row in filter_dashboard_jobs([full], score_state="Ready to rate")] == [43]
    assert filter_dashboard_jobs([full], score_state="Rating failed") == []


def test_pending_classification_excludes_expired_unrelated_excluded_ineligible_and_handled_jobs():
    from ui.dashboard_data import pending_category

    rows = [
        replace(job(1), availability_status="expired"),
        replace(job(2), role_eligibility="unrelated"),
        replace(job(3), role_eligibility="excluded"),
        replace(job(4), location_eligibility="ineligible"),
        replace(job(5), language_eligibility="ineligible"),
        replace(job(6), review_status="ignored"),
        replace(job(7), review_status="applied"),
    ]
    assert [pending_category(row) for row in rows] == [None] * len(rows)


def test_pending_reasons_distinguish_verification_and_eligibility_evidence():
    from ui.dashboard_data import can_retry_pending_evidence, pending_category, pending_reason

    verification = replace(job(1), availability_status="validation_failed")
    location = replace(job(2), location_eligibility="unclear")
    language = replace(job(3), language_eligibility="unclear")
    assert pending_category(verification) == "Verification needed"
    assert "exact requisition" in pending_reason(verification)
    assert pending_category(location) == "Location unclear"
    location = replace(location, location="Berlin, Germany", remote_scope=None)
    assert "geographic eligibility is unclear" in pending_reason(location)
    assert pending_category(language) is None
    assert can_retry_pending_evidence(verification)
    assert can_retry_pending_evidence(location)
    assert filter_dashboard_jobs([location], review_status="Unaddressed") == []


def test_pending_filter_is_a_separate_profile_relative_view():
    rows = [
        replace(job(1), availability_status="unknown"),
        replace(job(2), location_eligibility="unclear"),
        replace(job(3), availability_status="expired"),
        job(4),
    ]
    assert {row.id for row in filter_dashboard_jobs(rows, review_status="Pending / unresolved")} == {1, 2}
    assert [row.id for row in filter_dashboard_jobs(rows, review_status="Pending / unresolved", pending_category_filter="Location unclear")] == [2]


def test_primary_reason_precedence_and_pending_boundary_are_centralized():
    from ui.dashboard_data import dashboard_decision

    expired_unclear = replace(job(201), availability_status="expired", location_eligibility="unclear")
    unrelated_unclear = replace(job(202), role_eligibility="unrelated", location_eligibility="unclear")
    excluded_unverified = replace(job(203), role_eligibility="excluded", availability_status="validation_failed")
    target_unverified = replace(job(204), availability_status="validation_failed")
    target_location_unknown = replace(job(205), location_eligibility="unclear")
    assert (dashboard_decision(expired_unclear).state, dashboard_decision(expired_unclear).primary_reason_code) == ("not_actionable", "listing_closed")
    assert (dashboard_decision(unrelated_unclear).state, dashboard_decision(unrelated_unclear).primary_reason_code) == ("not_actionable", "outside_target_roles")
    assert (dashboard_decision(excluded_unverified).state, dashboard_decision(excluded_unverified).primary_reason_code) == ("not_actionable", "profile_exclusion")
    assert (dashboard_decision(target_unverified).state, dashboard_decision(target_unverified).primary_reason_code) == ("pending", "verification_needed")
    assert (dashboard_decision(target_location_unknown).state, dashboard_decision(target_location_unknown).primary_reason_code) == ("pending", "location_unclear")


def test_definite_profile_mismatches_are_not_pending_or_retryable():
    from ui.dashboard_data import can_retry_pending_evidence, dashboard_decision

    cases = [
        (replace(job(212), location_eligibility="ineligible", location_reason="Listing is outside configured locations."), "location_incompatible"),
        (replace(job(214), employment_type_eligibility="ineligible", employment_type_reason="Contract is excluded."), "employment_type_incompatible"),
    ]
    for item, expected_reason in cases:
        decision = dashboard_decision(item)
        assert decision.state == "not_actionable"
        assert decision.primary_reason_code == expected_reason
        assert can_retry_pending_evidence(item) is (item.id in {212, 214})
        assert decision.primary_reason_detail
    assert dashboard_decision(cases[1][0]).primary_reason_label == "Contract role excluded"


def test_unrelated_roles_do_not_get_verification_or_retry_actions():
    from ui.dashboard_data import can_retry_pending_evidence, dashboard_decision

    item = replace(job(215), role_eligibility="unrelated", availability_status="validation_failed")
    decision = dashboard_decision(item)
    assert decision.state == "not_actionable"
    assert decision.primary_reason_label == "Outside your target roles"
    assert not can_retry_pending_evidence(item)


def test_decision_is_profile_relative():
    first = merge_dashboard_rows(
        [{"id": 216, "company": "Acme", "title": "Platform Engineer", "availability_status": "active", "location": "Remote Europe", "remote_scope": "Remote"}],
        [], [], search_profile={"definition": {"target_titles": ["Security Engineer"], "remote_only": False, "english_only": False}},
    )[0]
    second = merge_dashboard_rows(
        [{"id": 216, "company": "Acme", "title": "Platform Engineer", "availability_status": "active", "location": "Remote Europe", "remote_scope": "Remote"}],
        [], [], search_profile={"definition": {"target_titles": ["Platform Engineer"], "remote_only": False, "english_only": False}},
    )[0]
    assert first.decision.primary_reason_code == "outside_target_roles"
    assert first.decision.state == "not_actionable"
    assert second.decision.state == "jd_required"


def test_dashboard_group_counts_equal_exact_rows_returned_by_each_view():
    rows = [
        job(221, score=78),
        replace(job(222), location_eligibility="unclear"),
        replace(job(223), availability_status="expired", location_eligibility="unclear"),
        replace(job(224), review_status="ignored"),
        replace(job(225), description="", description_kind="missing"),
    ]
    for view in ("Unaddressed", "Pending / unresolved", "Archive", "All"):
        filtered = filter_dashboard_jobs(rows, review_status=view)
        grouper = group_archive_jobs if view == "Archive" else group_dashboard_jobs
        grouped = [item for _, group in grouper(filtered) for item in group]
        assert len(grouped) == len(filtered)
        assert {item.id for item in grouped} == {item.id for item in filtered}


def test_not_actionable_reason_has_specific_card_copy_and_secondary_reasons():
    item = replace(
        job(230), availability_status="expired", location_eligibility="unclear",
        location_reason="Listing location not established.",
    )
    decision = item.decision
    assert decision.primary_reason_label == "Listing expired / closed"
    assert "confirmed expired" in decision.primary_reason_detail
    assert any("location" in reason.lower() for reason in decision.secondary_reasons)
    assert "configured preference cannot yet be resolved" not in decision.primary_reason_detail


def test_work_model_unclear_is_distinct_from_location_unclear():
    from ui.dashboard_data import dashboard_decision

    work_model = replace(job(231), work_model_eligibility="unclear", location_eligibility="unclear")
    location = replace(job(232), work_model_eligibility="eligible", location_eligibility="unclear")
    assert dashboard_decision(work_model).primary_reason_label == "Location unclear"
    assert dashboard_decision(location).primary_reason_label == "Location unclear"


def test_not_actionable_render_is_read_only(monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace
    import ui.dashboard as dashboard

    class Client:
        def __getattr__(self, name):
            raise AssertionError(f"Not actionable rendering must not call client.{name}")

    class Column:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    fake_streamlit = SimpleNamespace(
        session_state={},
        container=lambda **kwargs: nullcontext(),
        columns=lambda spec: [Column() for _ in spec],
        markdown=lambda *args, **kwargs: None,
        subheader=lambda *args, **kwargs: None,
        caption=lambda *args, **kwargs: None,
        link_button=lambda *args, **kwargs: None,
        button=lambda *args, **kwargs: False,
        expander=lambda *args, **kwargs: nullcontext(),
        warning=lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(dashboard, "st", fake_streamlit)
    item = replace(job(233), availability_status="expired", location_eligibility="unclear")
    dashboard._render_job(item, Client(), user_id="user", cv_version_id=1, active_profile_id=None, storage_bucket="private")


def test_manual_full_jd_without_assessment_is_ready_to_rate():
    manual = replace(
        job(44, score=None), is_manual=True, description="Complete manual JD", description_kind="full",
        role_eligibility="unrelated", location_eligibility="ineligible", language_eligibility="unclear",
    )
    assert manual.ready_to_rate
    assert not manual.rating_failed


def test_successful_current_assessment_is_rated_and_stale_fingerprint_is_not_reused():
    jd = ("Responsibilities: Lead security reviews, design practical controls, implement improvements, support product teams, and assess risks. "
          "Qualifications: Collaborate clearly, maintain sustainable security practices, respond to incidents, and establish effective safeguards. ") * 3
    jobs = [{"id": 45, "company": "Acme", "title": "Security Lead", "availability_status": "active", "description": jd, "description_kind": "full"}]
    fingerprint = "b" * 64
    assessment = {"id": 8, "job_id": 45, "fit_score": 80, "evaluation_fingerprint": fingerprint, "matcher_version": "holistic_fit_v1", "created_at": "2026-10-01T00:00:00Z"}
    profile = {"definition": {"target_titles": ["Security Lead"], "remote_only": False, "english_only": False}}
    current = merge_dashboard_rows(jobs, [], [assessment], search_profile=profile, current_fit_fingerprints={45: fingerprint})[0]
    stale = merge_dashboard_rows(jobs, [], [assessment], search_profile=profile, current_fit_fingerprints={45: "c" * 64})[0]
    current_after_stale = merge_dashboard_rows(
        jobs, [], [
            assessment,
            {**assessment, "id": 9, "fit_score": 20, "evaluation_fingerprint": "c" * 64, "created_at": "2026-10-02T00:00:00Z"},
        ], search_profile=profile, current_fit_fingerprints={45: fingerprint},
    )[0]
    assert current.fit_score == 80
    assert current.scored
    assert stale.fit_score is None
    assert stale.historical_fit_score == 80
    assert stale.displayed_fit_score == 80
    assert stale.ready_to_rate
    assert not stale.rating_failed
    assert stale.existing_fit_assessment_status == "stale"
    assert [row.id for row in filter_dashboard_jobs([stale], review_status="All", score_state="Scored")] == [45]
    assert current_after_stale.fit_score == 80
    assert current_after_stale.existing_fit_assessment_status == "current"


def test_identical_current_fit_fingerprint_is_reused_across_distinct_job_ids():
    jd = (
        "Responsibilities: Lead security reviews, design practical controls, implement improvements, "
        "support product teams, and assess risks. Qualifications: Collaborate clearly, maintain "
        "sustainable security practices, respond to incidents, and establish effective safeguards. "
    ) * 3
    jobs = [
        {"id": job_id, "company": company, "title": "Security Engineer",
         "availability_status": "active", "description": jd, "description_kind": "full",
         "location": "Remote Europe", "remote_scope": "Remote Europe"}
        for job_id, company in ((45, "Acme"), (46, "Example Security"))
    ]
    fingerprint = "b" * 64
    assessment = {
        "id": 8,
        "job_id": 45,
        "fit_score": 80,
        "evaluation_fingerprint": fingerprint,
        "matcher_version": "holistic_fit_v1",
        "created_at": "2026-10-01T00:00:00Z",
    }
    profile = {"definition": {"target_titles": ["Security Engineer"], "remote_only": False, "english_only": False}}

    rows = merge_dashboard_rows(
        jobs,
        [],
        [assessment],
        search_profile=profile,
        current_fit_fingerprints={45: fingerprint, 46: fingerprint},
    )

    assert [row.fit_score for row in rows] == [80, 80]
    assert [row.fit_assessment_id for row in rows] == [8, 8]
    assert all(row.existing_fit_assessment_status == "current" for row in rows)


def test_user_title_override_drives_display_eligibility_and_stales_old_fit_without_mutating_source():
    from matching.candidate_profile import representative_profile
    from matching.holistic_matcher import VerifiedJob, evaluation_fingerprint

    jd = ("Responsibilities: Lead security reviews, design practical controls, implement improvements, support product teams, and assess risks. "
          "Qualifications: Collaborate clearly, maintain sustainable security practices, respond to incidents, and establish effective safeguards. ") * 3
    source = {"id": 451, "company": "Swapcard", "title": "Our Mission", "availability_status": "active", "description": jd, "description_kind": "full", "location": "Remote Europe", "remote_scope": "Remote Europe"}
    profile = representative_profile()
    original_job = VerifiedJob(title="Our Mission", company="Swapcard", description=jd, source_url="https://example.test/451")
    old_fingerprint = evaluation_fingerprint(candidate_profile=profile, job=original_job)
    corrected_job = original_job.model_copy(update={"title": "Security Lead"})
    new_fingerprint = evaluation_fingerprint(candidate_profile=profile, job=corrected_job)
    assessment = {"id": 41, "job_id": 451, "fit_score": 77, "evaluation_fingerprint": old_fingerprint, "matcher_version": "holistic_fit_v1", "created_at": "2026-10-01T00:00:00Z"}
    search_profile = {"definition": {"target_titles": ["Security Lead"], "remote_only": False, "english_only": False}}
    corrected = merge_dashboard_rows(
        [source], [], [assessment], search_profile=search_profile,
        current_fit_fingerprints={451: new_fingerprint},
        metadata_overrides={451: {"title_override": "Security Lead"}},
    )[0]
    assert (corrected.company, corrected.title) == ("Swapcard", "Security Lead")
    assert corrected.source_title == "Our Mission"
    assert corrected.metadata_quality_issues == ()
    assert corrected.source_metadata_quality_issues
    assert corrected.fit_score is None
    assert corrected.historical_fit_score == 77
    assert corrected.ready_to_rate
    assert corrected.existing_fit_assessment_status == "stale"
    assert source["title"] == "Our Mission"

    reset = merge_dashboard_rows(
        [source], [], [assessment], search_profile=search_profile,
        current_fit_fingerprints={451: old_fingerprint},
    )[0]
    assert reset.title == "Our Mission"
    assert reset.fit_score == 77
    assert reset.historical_fit_score is None


def test_prior_profile_rating_stays_visible_but_job_remains_rateable_for_new_profile():
    old_profile_assessment = {
        "id": 21,
        "job_id": 51,
        "candidate_profile_id": 7,
        "fit_score": 76,
        "evaluation_fingerprint": "a" * 64,
        "matcher_version": "holistic_fit_v1",
        "created_at": "2026-10-01T00:00:00Z",
    }
    complete_jd = (
        "Responsibilities: Lead security reviews, design practical controls, implement improvements, support product teams, and assess risks. "
        "Qualifications: Collaborate clearly, maintain sustainable security practices, respond to incidents, and establish effective safeguards. "
    ) * 3
    rows = merge_dashboard_rows(
        [{"id": 51, "source": "manual", "company": "Maze", "title": "Senior Security Engineer", "availability_status": "active", "description": complete_jd, "description_kind": "full"}],
        [],
        [old_profile_assessment],
        current_fit_fingerprints={51: "b" * 64},
    )
    maze = rows[0]
    assert maze.fit_score is None
    assert maze.historical_fit_score == 76
    assert maze.ready_to_rate
    assert not maze.scored
    assert maze.existing_fit_assessment_status == "stale"


def test_identical_fit_fingerprint_from_prior_profile_is_still_current():
    assessment = {
        "id": 22,
        "job_id": 52,
        "candidate_profile_id": 7,
        "fit_score": 82,
        "evaluation_fingerprint": "c" * 64,
        "matcher_version": "holistic_fit_v1",
        "created_at": "2026-10-01T00:00:00Z",
    }
    row = merge_dashboard_rows(
        [{"id": 52, "company": "Example", "title": "Security Engineer", "availability_status": "active"}],
        [], [assessment], current_fit_fingerprints={52: "c" * 64},
    )[0]
    assert row.fit_score == 82
    assert row.historical_fit_score is None
    assert row.existing_fit_assessment_status == "current"


def test_company_override_resolves_metadata_quality_without_changing_current_fit():
    from matching.candidate_profile import representative_profile
    from matching.holistic_matcher import VerifiedJob, evaluation_fingerprint

    source = {"id": 452, "company": "Unknown company", "title": "Information Security Officer", "availability_status": "active", "description": "A complete security officer job description. " * 8, "description_kind": "full", "location": "Remote Europe", "remote_scope": "Remote"}
    profile = representative_profile()
    original_job = VerifiedJob(title=source["title"], company=source["company"], description=source["description"], source_url="https://example.test/452")
    fingerprint = evaluation_fingerprint(candidate_profile=profile, job=original_job)
    assessment = {"id": 42, "job_id": 452, "fit_score": 71, "evaluation_fingerprint": fingerprint, "matcher_version": "holistic_fit_v1", "created_at": "2026-10-02T00:00:00Z"}
    corrected = merge_dashboard_rows(
        [source], [], [assessment], current_fit_fingerprints={452: fingerprint},
        metadata_overrides={452: {"company_override": "Acme Corp"}},
    )[0]
    assert corrected.company == "Acme Corp"
    assert corrected.metadata_quality_issues == ()
    assert corrected.source_metadata_quality_issues
    assert corrected.fit_score == 71


def test_inline_metadata_controls_render_without_writes_for_discovered_manual_and_suspicious_cards(monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace
    import ui.dashboard as dashboard

    class Column:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    calls = []
    fake_st = SimpleNamespace(
        session_state={},
        columns=lambda spec: [Column() for _ in spec],
        container=lambda **kwargs: Column(),
        subheader=lambda value, **kwargs: calls.append(("title", value)),
        markdown=lambda value, **kwargs: calls.append(("text", value)),
        button=lambda label, **kwargs: calls.append(("button", label, kwargs.get("key"))) or False,
    )
    monkeypatch.setattr(dashboard, "st", fake_st)

    class NoWriteClient:
        def json_request(self, *args, **kwargs):
            raise AssertionError("Rendering metadata controls must not write")

    for item in (
        job(801),
        replace(job(802), is_manual=True),
        replace(job(803), company="Unknown company", title="Our Mission", metadata_quality_issues=("title_is_page_heading",)),
    ):
        dashboard._render_metadata_field_content(
            item, "title", item.title, client=NoWriteClient(), user_id="user",
            disabled=False,
        )
        dashboard._render_metadata_field_content(
            item, "company", item.company, client=NoWriteClient(), user_id="user",
            disabled=False,
        )
    assert len([call for call in calls if call[0] == "title"]) == 3
    assert len([call for call in calls if call[0] == "button" and call[1] == ":material/edit:"]) == 6
    assert not any(call[0] == "button" and call[1] == ":material/undo:" for call in calls)


def test_metadata_edit_only_opens_inline_editor_without_app_rerun_or_write(monkeypatch):
    from types import SimpleNamespace
    import ui.dashboard as dashboard

    class Column:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    reruns = []
    calls = []
    fake_st = SimpleNamespace(
        session_state={},
        columns=lambda spec: [Column() for _ in spec],
        container=lambda **kwargs: Column(),
        subheader=lambda value, **kwargs: calls.append(("title", value)),
        markdown=lambda value, **kwargs: calls.append(("text", value)),
        button=lambda label, **kwargs: label == ":material/edit:",
        rerun=lambda **kwargs: reruns.append(kwargs),
    )
    monkeypatch.setattr(dashboard, "st", fake_st)

    class NoWriteClient:
        def json_request(self, *args, **kwargs):
            raise AssertionError("Opening the editor must not write")

    item = job(804)
    dashboard._render_metadata_field_content(
        item, "title", item.title, client=NoWriteClient(), user_id="user",
        disabled=False,
    )
    assert fake_st.session_state["job_metadata_edit"] == (item.id, "title")
    assert fake_st.session_state["metadata-edit-value-804-title-1"] == item.title
    assert reruns == [{"scope": "fragment"}]


def test_failure_state_requires_exact_current_fingerprint():
    row = merge_dashboard_rows(
        [{"id": 46, "company": "Acme", "title": "Security Lead", "availability_status": "active", "description": "Responsibilities: Lead security reviews, design controls, implement improvements, support teams, and assess risks. Qualifications: Collaborate clearly, maintain sustainable security practices, respond to incidents, and establish effective safeguards. " * 3, "description_kind": "full"}],
        [], [], search_profile={"definition": {"target_titles": ["Security Lead"], "remote_only": False, "english_only": False}}, current_fit_fingerprints={46: "d" * 64},
        failed_fit_fingerprints={46: "e" * 64},
    )[0]
    assert row.ready_to_rate
    assert not row.rating_failed
    matched = merge_dashboard_rows(
        [{"id": 46, "company": "Acme", "title": "Security Lead", "availability_status": "active", "description": "Responsibilities: Lead security reviews, design controls, implement improvements, support teams, and assess risks. Qualifications: Collaborate clearly, maintain sustainable security practices, respond to incidents, and establish effective safeguards. " * 3, "description_kind": "full"}],
        [], [], search_profile={"definition": {"target_titles": ["Security Lead"], "remote_only": False, "english_only": False}}, current_fit_fingerprints={46: "d" * 64},
        failed_fit_fingerprints={46: "d" * 64},
    )[0]
    assert matched.rating_failed
    assert not matched.ready_to_rate


def test_group_dashboard_jobs_separates_ready_to_rate_from_failures():
    complete_jd = "Responsibilities: Lead security reviews, design practical controls, implement improvements, support product teams, and assess risks. Qualifications: Collaborate clearly, maintain sustainable security practices, respond to incidents, and establish effective safeguards. " * 3
    ready = replace(job(47), description=complete_jd, description_kind="full")
    failed = replace(ready, id=48, fit_fingerprint="a" * 64, fit_attempt_failed=True)
    groups = dict(group_dashboard_jobs([ready, failed]))
    assert [row.id for row in groups["Ready to rate"]] == [47]
    assert [row.id for row in groups["Rating failed"]] == [48]


def test_current_fit_does_not_hide_unresolved_metadata_from_review_state():
    malformed = replace(job(950, score=78), metadata_quality_issues=("title_is_page_heading",))
    groups = dict(group_dashboard_jobs([malformed]))
    assert malformed.decision.primary_reason_code == "metadata_unresolved"
    assert "Metadata unresolved" in groups
    assert not any(malformed in rows for name, rows in groups.items() if name in {"90–100", "80–89", "70–79", "60–69", "50–59", "Under 50"})


def test_source_repairs_preserve_overrides_and_fit_identity_tracks_effective_title_only():
    from matching.candidate_profile import representative_profile
    from matching.holistic_matcher import VerifiedJob, evaluation_fingerprint
    from matching.job_metadata_overrides import resolve_effective_job_metadata

    profile = representative_profile()
    description = "Exact unchanged full requisition description. " * 20
    unknown_company = VerifiedJob(title="Information Security Officer", company="Unknown company", description=description, source_url="https://example.test/coinspaid")
    corrected_company = unknown_company.model_copy(update={"company": "Coinspaid"})
    assert evaluation_fingerprint(candidate_profile=profile, job=unknown_company) == evaluation_fingerprint(
        candidate_profile=profile, job=corrected_company
    )

    wrong_title = VerifiedJob(title="Our Mission", company="Swapcard", description=description, source_url="https://example.test/swapcard")
    fixed_title = wrong_title.model_copy(update={"title": "Security Engineer - SecOps & Cloud"})
    assert evaluation_fingerprint(candidate_profile=profile, job=wrong_title) != evaluation_fingerprint(
        candidate_profile=profile, job=fixed_title
    )

    override = {"title_override": "Senior Security Engineer"}
    before = resolve_effective_job_metadata("Swapcard", "Our Mission", override)
    after = resolve_effective_job_metadata("Swapcard", "Security Engineer - SecOps & Cloud", override)
    assert before.title == after.title == "Senior Security Engineer"
    before_effective = VerifiedJob(title=before.title, company=before.company, description=description, source_url="https://example.test/swapcard")
    after_effective = VerifiedJob(title=after.title, company=after.company, description=description, source_url="https://example.test/swapcard")
    assert evaluation_fingerprint(candidate_profile=profile, job=before_effective) == evaluation_fingerprint(
        candidate_profile=profile, job=after_effective
    )
