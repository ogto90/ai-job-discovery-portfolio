from matching.candidate_profile import representative_profile
from matching.holistic_match_planning import (
    MatchPlanAction,
    VerifiedDiscoveredJob,
    plan_holistic_matches,
)
from matching.search_profile import SearchProfile


PROFILE = representative_profile()
PROFILE_ID = 7
SEARCH = SearchProfile(
    name="security",
    target_titles=["Application Security"],
    role_families=["Security Engineer"],
    positive_concepts=["application security"],
    remote_only=True,
    discovery_modes=["targeted", "broad"],
    excluded_title_patterns=["Analyst", "SOC"],
    eligibility_constraints={"remote_scope": "Austria/EU/EEA/EMEA/Europe"},
)


def job(job_id=8, description="Application Security Engineer with application security experience.", title="Application Security Engineer", **kwargs):
    remote_scope = kwargs.pop("remote_scope", "Remote Europe")
    company = kwargs.pop("company", "Solidgate")
    source_url = kwargs.pop("source_url", f"https://example.test/jobs/{job_id}")
    return VerifiedDiscoveredJob(
        job_id=job_id,
        title=title,
        company=company,
        description=description,
        source_url=source_url,
        remote_scope=remote_scope,
        **kwargs,
    )


def test_cached_solidgate_is_reused_and_does_not_call_ai():
    calls = []

    def lookup(user_id, fingerprint):
        calls.append((user_id, fingerprint))
        return {"id": 14}

    batch = plan_holistic_matches(
        user_id="user-1", candidate_profile_id=PROFILE_ID,
        candidate_profile=PROFILE, search_profile=SEARCH,
        jobs=[job()], cache_lookup=lookup,
    )
    assert batch.plans[0].action is MatchPlanAction.REUSE
    assert batch.plans[0].existing_assessment_id == 14
    assert batch.summary.model_dump() == {"jobs_received": 1, "skipped_before_matching": 0, "cached_reused": 1, "needs_ai": 0}
    assert len(calls) == 1


def test_saved_legacy_fingerprint_is_not_reused_after_evidence_changes():
    legacy_fingerprint = plan_holistic_matches(
        user_id="user-1", candidate_profile_id=PROFILE_ID,
        candidate_profile=PROFILE, search_profile=SEARCH,
        jobs=[job()], cache_lookup=lambda *_: None,
    ).plans[0].evaluation_fingerprint

    def lookup(user_id, fingerprint):
        assert user_id == "user-1"
        assert fingerprint != legacy_fingerprint
        # Cache lookup is exact-keyed; the old assessment remains historical.
        return {"id": 14} if fingerprint == legacy_fingerprint else None

    batch = plan_holistic_matches(
        user_id="user-1", candidate_profile_id=PROFILE_ID,
        candidate_profile=PROFILE.model_copy(update={"summary": "New documented evidence."}),
        search_profile=SEARCH,
        jobs=[job()],
        cache_lookup=lookup,
    )
    assert batch.plans[0].action is MatchPlanAction.EVALUATE
    assert batch.plans[0].existing_assessment_id is None


def test_new_and_changed_inputs_need_ai():
    def no_cache(_, __):
        return None

    base = plan_holistic_matches(
        user_id="user-1", candidate_profile_id=7, candidate_profile=PROFILE,
        search_profile=SEARCH, jobs=[job()], cache_lookup=no_cache,
    ).plans[0]
    changed_jd = plan_holistic_matches(
        user_id="user-1", candidate_profile_id=7, candidate_profile=PROFILE,
        search_profile=SEARCH, jobs=[job(description="Different description")], cache_lookup=no_cache,
    ).plans[0]
    changed_profile = plan_holistic_matches(
        user_id="user-1", candidate_profile_id=8,
        candidate_profile=PROFILE.model_copy(update={"summary": "Changed documented profile."}),
        search_profile=SEARCH, jobs=[job()], cache_lookup=no_cache,
    ).plans[0]
    changed_context = plan_holistic_matches(
        user_id="user-1", candidate_profile_id=7, candidate_profile=PROFILE,
        search_profile=SEARCH.model_copy(update={"remote_only": False}),
        jobs=[job()], cache_lookup=no_cache,
    ).plans[0]
    changed_model = plan_holistic_matches(
        user_id="user-1", candidate_profile_id=7, candidate_profile=PROFILE,
        search_profile=SEARCH, jobs=[job()], cache_lookup=no_cache, model="gpt-6-sol",
    ).plans[0]
    changed_version = plan_holistic_matches(
        user_id="user-1", candidate_profile_id=7, candidate_profile=PROFILE,
        search_profile=SEARCH, jobs=[job()], cache_lookup=no_cache, matcher_version="holistic_match_v2",
    ).plans[0]
    assert all(plan.action is MatchPlanAction.EVALUATE for plan in [base, changed_jd, changed_profile, changed_context, changed_model, changed_version])
    assert len({base.evaluation_fingerprint, changed_jd.evaluation_fingerprint, changed_profile.evaluation_fingerprint, changed_model.evaluation_fingerprint, changed_version.evaluation_fingerprint}) == 5
    assert changed_context.evaluation_fingerprint == base.evaluation_fingerprint


def test_lifecycle_and_light_filters_skip_before_cache():
    calls = []

    def lookup(*args):
        calls.append(args)
        return None

    jobs = [
        job(1, application_status="applied"),
        job(2, application_status="rejected"),
        job(3, application_status="ignored"),
        job(4, availability_status="expired"),
        job(5, verification_status="pending"),
        job(6, title="SOC Analyst"),
        job(7, remote_scope="On-site",),
        job(8, availability_status="validation_failed"),
        job(9, description="Remote within the United States only. " + "Build secure systems with our team. " * 8, remote_scope="Worldwide"),
    ]
    batch = plan_holistic_matches(
        user_id="user-1", candidate_profile_id=7, candidate_profile=PROFILE,
        search_profile=SEARCH, jobs=jobs, cache_lookup=lookup,
    )
    assert all(plan.action is MatchPlanAction.SKIP for plan in batch.plans)
    assert batch.summary.model_dump() == {"jobs_received": 9, "skipped_before_matching": 9, "cached_reused": 0, "needs_ai": 0}
    assert calls == []


def test_rediscovery_date_is_not_part_of_fingerprint():
    seen = []

    def lookup(_, fingerprint):
        seen.append(fingerprint)
        return {"id": 14}

    first = plan_holistic_matches(user_id="u", candidate_profile_id=7, candidate_profile=PROFILE, search_profile=SEARCH, jobs=[job()], cache_lookup=lookup)
    second = plan_holistic_matches(user_id="u", candidate_profile_id=7, candidate_profile=PROFILE, search_profile=SEARCH, jobs=[job()], cache_lookup=lookup)
    assert first.plans[0].action is MatchPlanAction.REUSE
    assert second.plans[0].action is MatchPlanAction.REUSE
    assert seen[0] == seen[1]


def test_cache_reuse_tracks_title_but_ignores_company_url_search_and_review_context():
    observed = []

    def initially_empty(_, fingerprint):
        observed.append(fingerprint)
        return None

    base = job(title="Security Engineer")
    plan_holistic_matches(
        user_id="u", candidate_profile_id=7, candidate_profile=PROFILE,
        search_profile=SEARCH, jobs=[base], cache_lookup=initially_empty,
    )
    cached_fingerprint = observed[-1]

    def cached(_, fingerprint):
        observed.append(fingerprint)
        return {"id": 22} if fingerprint == cached_fingerprint else None

    presentation_change = plan_holistic_matches(
        user_id="u", candidate_profile_id=7, candidate_profile=PROFILE,
        search_profile=SEARCH.model_copy(update={"remote_only": False}),
        jobs=[job(title="Security Engineer", company="Different Co", source_url="https://new.example/role")],
        cache_lookup=cached,
    )
    title_change = plan_holistic_matches(
        user_id="u", candidate_profile_id=7, candidate_profile=PROFILE,
        search_profile=SEARCH, jobs=[job(title="Senior Security Engineer")],
        cache_lookup=cached,
    )

    assert presentation_change.plans[0].action is MatchPlanAction.REUSE
    assert title_change.plans[0].action is MatchPlanAction.EVALUATE
    assert observed[0] == observed[1]
    assert observed[2] != observed[1]


def test_application_and_lifecycle_state_are_not_fit_fingerprint_inputs():
    from matching.holistic_matcher import evaluation_fingerprint

    base = job().as_verified_job()
    changed_context = job(
        company="Different Co",
        source_url="https://another.example/job",
        application_status="applied",
        availability_status="validation_failed",
        verification_status="pending",
    ).as_verified_job()
    assert evaluation_fingerprint(candidate_profile=PROFILE, job=base) == evaluation_fingerprint(
        candidate_profile=PROFILE, job=changed_context
    )


def test_batch_summary_reports_reuse_evaluate_and_skip():
    def lookup(_, fingerprint):
        return {"id": 14} if fingerprint else None

    # A selective lookup makes the second job require AI while the first is cached.
    first_job = job(1)
    first_plan = plan_holistic_matches(user_id="u", candidate_profile_id=7, candidate_profile=PROFILE, search_profile=SEARCH, jobs=[first_job], cache_lookup=lookup)
    cached_fingerprint = first_plan.plans[0].evaluation_fingerprint

    def selective(_, fingerprint):
        return {"id": 14} if fingerprint == cached_fingerprint else None

    batch = plan_holistic_matches(
        user_id="u", candidate_profile_id=7, candidate_profile=PROFILE,
        search_profile=SEARCH, jobs=[job(1), job(2, description="New role description"), job(3, application_status="ignored")],
        cache_lookup=selective,
    )
    assert batch.summary.model_dump() == {"jobs_received": 3, "skipped_before_matching": 1, "cached_reused": 1, "needs_ai": 1}
