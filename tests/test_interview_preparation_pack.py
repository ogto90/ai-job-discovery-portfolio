from __future__ import annotations

from copy import deepcopy
import json
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest
from types import SimpleNamespace
from pydantic import ValidationError

from matching.interview_preparation import create_interview_preparation
from matching.interview_preparation_pack import (
    CompanyFact, CompanyIntelligence, FinalBriefing, InterviewerQuestion, InterviewQuestion,
    JobAnalysis, PreparationPack, Requirement, ExperienceMap, StudyTopic,
    CandidateTalkingPoint, PackGenerationError, is_safe_citation_url, _source_identifier, current_source_fingerprint,
    OpenAIResponsesAdapter, generate_preparation_pack, get_saved_pack, source_fingerprint,
)
from tests.test_interview_preparation import FakeClient, USER


class StreamManager:
    def __init__(self, response):
        self.response = response

    def __enter__(self):
        return SimpleNamespace(get_final_response=lambda: self.response)

    def __exit__(self, *_args):
        return False


def _profile(cv_id=31):
    return {
        "schema_version": "2.0", "source_cv_version_id": cv_id,
        "summary": "Security engineer with verified vulnerability management work.",
        "total_professional_experience_years": 8, "current_role": "Security Engineer", "seniority": "Senior",
        "education": [], "certifications": [], "languages": [], "roles": [], "tools_platforms": [],
        "capabilities": [],
        "evidence_provenance": [{"id": "vuln_ops", "source_section": "Experience", "origin": "work_history",
                                 "employer": "SyntheticCo", "role": "Security Engineer", "date_range": None,
                                 "cv_text": "Led vulnerability triage and remediation coordination.",
                                 "evidence_type": "production_hands_on"}],
    }


def _pack(evidence="vuln_ops", source=None):
    source = source or _source_identifier("https://example.test/company", "Official company page")
    req = Requirement(requirement="Vulnerability management", category="technical", evidence="Named in the frozen JD")
    question = InterviewQuestion(question="How would you prioritize a critical vulnerability?", category="scenario",
        difficulty="advanced", why_it_matters="Central role responsibility", evidence=[source], candidate_evidence=[evidence],
        talking_points=["Use verified triage experience"], answer_structure="Context, action, outcome", follow_up="What if the fix is delayed?")
    return PreparationPack(
        company_intelligence=CompanyIntelligence(facts=[CompanyFact(claim="ExampleCo builds cloud infrastructure.",
            evidence_category="verified_company_source", source_ids=[source])]),
        job_requirement_analysis=JobAnalysis(responsibilities=[req], required_competencies=[req], preferred_competencies=[],
            seniority_and_ownership=["Senior ownership"], technical_focus=["Cloud security"], business_context=[], likely_themes=["Risk triage"]),
        personal_experience_mapping=[ExperienceMap(requirement="Vulnerability management", assessment="strong",
            candidate_evidence=[evidence], talking_point="Describe verified triage work without adding unsupported metrics.")],
        tailored_interview_questions=[question.model_copy(update={"question": f"Scenario {i}: prioritize this risk?"}) for i in range(5)],
        knowledge_gap_preparation=[StudyTopic(topic="Cloud threat modeling", priority="high", relevance="JD calls for architecture",
            explanation="Assess trust boundaries and attack paths.", should_understand=["Boundaries"],
            practice_question="Model the service boundary", resource_source_ids=[source])],
        questions_for_interviewers=[InterviewerQuestion(question=f"How does the team handle risk {i}?", why_useful="Clarifies ownership", stage="Technical") for i in range(3)],
        final_interview_briefing=FinalBriefing(company_facts=[CompanyFact(claim="ExampleCo builds cloud infrastructure.",
            evidence_category="verified_company_source", source_ids=[source])], role_requirements=["Vulnerability management"],
            talking_points=[CandidateTalkingPoint(statement="Explain triage approach", evidence_ids=[evidence])],
            examples=[CandidateTalkingPoint(statement="Verified vulnerability work", evidence_ids=[evidence])], knowledge_gaps=["Threat modeling"],
            questions_to_prepare=["Prioritization"], questions_to_ask=["Team ownership"], uncertainties=[]),
    )


class Adapter:
    model = "test-model"

    def __init__(self, *, error=False):
        self.error = error
        self.research_inputs = []
        self.generation_prompts = []

    def research(self, company, title):
        self.research_inputs.append((company, title))
        title, url = "Official company page", "https://example.test/company"
        return "Synthetic public research", [{"id": _source_identifier(url, title), "title": title,
            "url": url, "retrieved_at": "2026-10-27T00:00:00Z"}], {
                "input_tokens": 10, "output_tokens": 5, "total_tokens": 15}

    def generate(self, prompt, cv_artifact):
        self.generation_prompts.append(prompt)
        assert cv_artifact and cv_artifact["bytes"] == b"Submitted tailored CV"
        if self.error:
            raise PackGenerationError("timeout", "timeout")
        return _pack(), {"input_tokens": 20, "output_tokens": 30, "total_tokens": 50}


class PackClient(FakeClient):
    def __init__(self):
        super().__init__()
        self.tables["candidate_profiles"][0]["profile_json"] = _profile()
        self.tables["job_match_assessments"][0].update({"strengths": ["vulnerability triage"], "gaps": ["cloud threat modeling"]})
        self.tables["interview_preparation_packs"] = []
        self.claimed = set()
        self.source_requests = []

    def get_json(self, path):
        parsed = urlsplit(path)
        table = parsed.path.rsplit("/", 1)[-1]
        if table == "interview_preparation_packs":
            params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            return [deepcopy(r) for r in self.tables[table] if r["preparation_id"] == params.get("preparation_id", "")[3:]]
        if table == "job_match_assessments":
            self.source_requests.append(path)
        return super().get_json(path)

    def json_request(self, method, path, payload=None, *, prefer=None):
        function = urlsplit(path).path.rsplit("/", 1)[-1]
        if function == "claim_interview_preparation_pack_generation":
            key = payload["p_preparation_id"]
            if key in self.claimed:
                return {"claimed": False, "status": "running"}
            self.claimed.add(key)
            row = next((r for r in self.tables["interview_preparation_packs"] if r["preparation_id"] == key), None)
            if row is None:
                row = {"preparation_id": key, "pack_json": None, "generation_status": "idle"}
                self.tables["interview_preparation_packs"].append(row)
            row.update(generation_status="running", attempt_key=payload["p_attempt_key"], attempt_fingerprint=payload["p_source_fingerprint"])
            return {"claimed": True}
        if function == "complete_interview_preparation_pack_generation":
            row = next(r for r in self.tables["interview_preparation_packs"] if r["preparation_id"] == payload["p_preparation_id"])
            if row.get("attempt_key") != payload["p_attempt_key"]:
                return {"saved": False}
            row.update(generation_status="ready", pack_json=payload["p_pack_json"],
                schema_version=payload["p_schema_version"], source_fingerprint=payload["p_source_fingerprint"],
                model=payload["p_model"], research_sources=payload["p_research_sources"],
                research_timestamp=payload["p_research_timestamp"], generated_at=payload["p_generated_at"], api_usage=payload["p_api_usage"])
            self.claimed.discard(payload["p_preparation_id"])
            return {"saved": True}
        if function == "fail_interview_preparation_pack_generation":
            row = next(r for r in self.tables["interview_preparation_packs"] if r["preparation_id"] == payload["p_preparation_id"])
            row.update(generation_status="failed", failure_code=payload["p_failure_code"])
            self.claimed.discard(payload["p_preparation_id"])
            return {"failed": True}
        return super().json_request(method, path, payload, prefer=prefer)


def _create(client):
    return create_interview_preparation(client, user_id=USER, application_id=10,
        idempotency_key=str(uuid4()), interview_type="technical", selected_cv_version_id=31, cv_confirmed=True)


def test_frozen_context_exact_fit_citations_and_saved_pack_reopen():
    client = PackClient()
    prep = _create(client)
    fingerprint = source_fingerprint(prep, client.tables["job_match_assessments"][0])
    client.tables["jobs"][0]["description"] = "MUTABLE LATEST JD MUST NOT BE USED"
    client.tables["job_match_assessments"].append({"id": 99, "user_id": USER, "job_id": 20, "fit_score": 10,
        "strengths": ["wrong"], "gaps": ["wrong"], "created_at": "2026-12-01"})
    adapter = Adapter()
    result = generate_preparation_pack(client, user_id=USER, preparation_id=prep["id"], consent_confirmed=True, adapter=adapter)
    assert result["generation_status"] == "ready"
    assert result["api_usage"]["total_tokens"] == 65
    assert result["source_fingerprint"] == fingerprint
    assert current_source_fingerprint(client, prep) == fingerprint
    assert "Original JD" in adapter.generation_prompts[0]
    assert "MUTABLE LATEST JD" not in adapter.generation_prompts[0]
    assert "vulnerability triage" in adapter.generation_prompts[0]
    assert "wrong" not in adapter.generation_prompts[0]
    assert "31" in adapter.generation_prompts[0]
    assert "Submitted tailored CV" not in adapter.research_inputs[0]
    assert len(adapter.research_inputs) == 1
    saved = get_saved_pack(client, user_id=USER, preparation_id=prep["id"])
    assert saved["pack_json"]["tailored_interview_questions"]
    assert saved["research_sources"][0]["url"] == "https://example.test/company"
    assert client.tables["applications"][0]["status"] == "applied"


def test_failed_regeneration_retains_last_successful_pack_and_claim_blocks_duplicate():
    client = PackClient()
    prep = _create(client)
    original = generate_preparation_pack(client, user_id=USER, preparation_id=prep["id"], consent_confirmed=True, adapter=Adapter())
    prior = deepcopy(original["pack_json"])
    with pytest.raises(PackGenerationError, match="timeout"):
        generate_preparation_pack(client, user_id=USER, preparation_id=prep["id"], consent_confirmed=True, adapter=Adapter(error=True))
    saved = get_saved_pack(client, user_id=USER, preparation_id=prep["id"])
    assert saved["generation_status"] == "failed"
    assert saved["pack_json"] == prior
    client.claimed.add(prep["id"])
    adapter = Adapter()
    with pytest.raises(PackGenerationError, match="already being generated"):
        generate_preparation_pack(client, user_id=USER, preparation_id=prep["id"], consent_confirmed=True, adapter=adapter)
    assert not adapter.research_inputs


def test_source_fingerprint_changes_with_interview_stage_and_notes():
    client = PackClient()
    prep = _create(client)
    before = source_fingerprint(prep)
    updated = {**prep, "interview_type": "behavioral", "interview_notes": "Focus on conflict"}
    assert source_fingerprint(updated) != before


def test_generation_service_requires_explicit_private_context_consent():
    client = PackClient()
    prep = _create(client)
    adapter = Adapter()
    with pytest.raises(ValueError, match="Confirm"):
        generate_preparation_pack(client, user_id=USER, preparation_id=prep["id"], adapter=adapter)
    assert adapter.research_inputs == []


def test_research_failure_can_produce_disclosed_jd_grounded_pack():
    class ResearchUnavailable(Adapter):
        def research(self, company, title):
            raise TimeoutError("research timed out")

        def generate(self, prompt, cv_artifact):
            pack, usage = super().generate(prompt, cv_artifact)
            pack.company_intelligence.facts = []
            pack.company_intelligence.research_limitations = ["Research unavailable"]
            pack.final_interview_briefing.company_facts = []
            for question in pack.tailored_interview_questions:
                question.evidence = ["Frozen job description"]
            for topic in pack.knowledge_gap_preparation:
                topic.resource_source_ids = []
            return pack, usage

    client = PackClient()
    prep = _create(client)
    result = generate_preparation_pack(client, user_id=USER, preparation_id=prep["id"],
                                       consent_confirmed=True, adapter=ResearchUnavailable())
    assert result["generation_status"] == "ready"
    assert any("Company research was unavailable" in note for note in result["pack_json"]["generation_disclosures"])
    assert result["pack_json"]["company_intelligence"]["facts"] == []


def test_interview_stages_produce_independent_stage_specific_packs():
    class StageAdapter(Adapter):
        def generate(self, prompt, cv_artifact):
            import json
            data = json.loads(prompt)
            pack, usage = super().generate(prompt, cv_artifact)
            stage = data["interview_type"]
            pack.tailored_interview_questions[0].question = f"{stage} stage: discuss a relevant security decision"
            return pack, usage

    client = PackClient()
    technical = _create(client)
    recruiter = create_interview_preparation(client, user_id=USER, application_id=10,
        idempotency_key=str(uuid4()), interview_type="recruiter", selected_cv_version_id=31, cv_confirmed=True)
    adapter = StageAdapter()
    first = generate_preparation_pack(client, user_id=USER, preparation_id=technical["id"],
                                      consent_confirmed=True, adapter=adapter)
    second = generate_preparation_pack(client, user_id=USER, preparation_id=recruiter["id"],
                                       consent_confirmed=True, adapter=adapter)
    assert first["pack_json"]["tailored_interview_questions"][0]["question"].startswith("technical stage")
    assert second["pack_json"]["tailored_interview_questions"][0]["question"].startswith("recruiter stage")
    assert len(client.tables["interview_preparation_packs"]) == 2


def test_invalid_candidate_and_source_references_are_rejected():
    client = PackClient()
    prep = _create(client)
    adapter = Adapter()
    original = adapter.generate
    def invalid(prompt, cv):
        pack, usage = original(prompt, cv)
        pack.personal_experience_mapping[0].candidate_evidence = ["invented"]
        return pack, usage
    adapter.generate = invalid
    with pytest.raises(PackGenerationError, match="unknown candidate evidence"):
        generate_preparation_pack(client, user_id=USER, preparation_id=prep["id"], consent_confirmed=True, adapter=adapter)
    assert client.tables["interview_preparation_packs"][0]["pack_json"] is None


@pytest.mark.parametrize("url", ["javascript:alert(1)", "data:text/html,bad", "https://user:pass@example.com/x", "http://example.com"])
def test_unsafe_company_urls_are_rejected(url):
    assert not is_safe_citation_url(url)


def test_https_company_url_is_safe():
    assert is_safe_citation_url("https://example.com/security")


def test_responses_adapter_uses_bounded_web_search_and_structured_output_without_live_calls():
    class Responses:
        def __init__(self):
            self.requests = []

        def create(self, **kwargs):
            self.requests.append(("research", kwargs))
            return SimpleNamespace(model_dump=lambda **_: {
                "model": "supported-test", "output_text": "Synthetic research",
                "output": [{"type": "web_search_call", "results": [{
                    "title": "Official source", "url": "https://example.test/official"}]}],
                "usage": {"input_tokens": 2, "output_tokens": 3, "total_tokens": 5},
            })

        def stream(self, **kwargs):
            self.requests.append(("generation", kwargs))
            return StreamManager(SimpleNamespace(status="completed", output_parsed=_pack(), model_dump=lambda **_: {
                "model": "supported-test", "usage": {"input_tokens": 4, "output_tokens": 5, "total_tokens": 9}}))

    class Client:
        def __init__(self):
            self.responses = Responses()

    client = Client()
    adapter = OpenAIResponsesAdapter(client, model="supported-test")
    research, sources, research_usage = adapter.research("Synthetic Corp", "Security Engineer")
    assert research == "Synthetic research"
    assert len(sources) == 1 and sources[0]["id"] == _source_identifier(sources[0]["url"], sources[0]["title"])
    name, request = client.responses.requests[0]
    assert name == "research" and request["tools"] == [{"type": "web_search"}]
    assert request["max_tool_calls"] == 3 and request["include"] == ["web_search_call.results"]
    assert "private CV text" not in request["input"]
    output, usage = adapter.generate("synthetic private prompt", {"type": "application/pdf", "bytes": b"PDF"})
    assert isinstance(output, PreparationPack)
    assert usage["total_tokens"] == 9
    _, generation_request = client.responses.requests[1]
    assert generation_request["text_format"] is PreparationPack
    assert "tools" not in generation_request
    assert "private CV text" not in json.dumps(generation_request["input"])


def test_responses_adapter_rejects_incomplete_structured_output():
    class Responses:
        def stream(self, **_kwargs):
            return StreamManager(SimpleNamespace(status="incomplete", output_parsed=None, model_dump=lambda **_: {}))

    adapter = OpenAIResponsesAdapter(SimpleNamespace(responses=Responses()), model="synthetic")
    with pytest.raises(PackGenerationError, match="incomplete"):
        adapter.generate("synthetic prompt", None)


def test_responses_adapter_rejects_oversized_structured_fields():
    oversized = _pack().model_dump(mode="python")
    oversized["tailored_interview_questions"][0]["question"] = "x" * 1001

    class Responses:
        def stream(self, **_kwargs):
            return StreamManager(SimpleNamespace(
                status="completed", output_parsed=oversized,
                model_dump=lambda **_: {},
            ))

    adapter = OpenAIResponsesAdapter(SimpleNamespace(responses=Responses()), model="synthetic")
    with pytest.raises(ValidationError):
        adapter.generate("synthetic prompt", None)


def test_structured_adapter_streams_response_and_uses_long_timeout():
    requests = []

    class Responses:
        def stream(self, **kwargs):
            requests.append(kwargs)
            response = SimpleNamespace(status="completed", output_parsed=_pack(), model_dump=lambda **_: {
                "model": "synthetic", "usage": {"total_tokens": 4}})
            return StreamManager(response)

    adapter = OpenAIResponsesAdapter(SimpleNamespace(responses=Responses()), model="synthetic")
    pack, usage = adapter.generate("synthetic prompt", None)
    assert isinstance(pack, PreparationPack)
    assert usage["total_tokens"] == 4
    assert requests[0]["timeout"] == 180
