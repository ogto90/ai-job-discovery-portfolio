import json
from types import SimpleNamespace

from matching.gap_recommendations import (
    GAP_IMPROVEMENT_PROMPT,
    GapImprovementPlanBatch,
    GapImprovementPlan,
    recommend_gap_improvement_plans,
)


class FakeResponses:
    def __init__(self, parsed):
        self.parsed = parsed
        self.kwargs = None

    def parse(self, **kwargs):
        self.kwargs = kwargs
        return SimpleNamespace(output_parsed=self.parsed)


def test_recommendations_use_one_structured_request_for_profile_and_all_gaps():
    responses = FakeResponses(GapImprovementPlanBatch(plans=[{
        "normalized_key": "cloud_security",
        "plan": {
            "overview": "Build hands-on evidence through a scoped cloud security project.",
            "hands_on_experience": ["Implement least-privilege controls in a test cloud account."],
            "learning": ["Practice cloud IAM threat modeling."],
            "certifications": [],
            "evidence_to_build": ["Keep a short architecture and control rationale."],
        },
    }]))
    client = SimpleNamespace(responses=responses)

    result = recommend_gap_improvement_plans(
        categories=[{
            "normalized_key": "cloud_security",
            "category": "Cloud security",
            "description": "Limited production cloud ownership.",
            "percentage": 61.3,
            "examples": [{"title": "Cloud Security Engineer", "text": "Hands-on cloud controls."}],
        }],
        candidate_evidence={"capabilities": [{"name": "IAM", "evidence_level": 1}]},
        ai_client=client,
        model="offline-test-model",
    )

    assert result["cloud_security"].certifications == []
    assert responses.kwargs["model"] == "offline-test-model"
    assert responses.kwargs["text_format"] is GapImprovementPlanBatch
    user_input = json.loads(responses.kwargs["input"][1]["content"])
    assert user_input["candidate_profile_evidence"] == {"capabilities": [{"name": "IAM", "evidence_level": 1}]}
    assert user_input["recurring_gaps"][0]["source_gaps"] == [{
        "role": "Cloud Security Engineer", "fit_gap": "Hands-on cloud controls.",
    }]
    assert "Recommend future actions, not fabricated CV statements" in GAP_IMPROVEMENT_PROMPT
    assert "certificate substitutes for production" in GAP_IMPROVEMENT_PROMPT


def test_recommendations_cap_examples_and_require_complete_unique_output():
    plan = {
        "overview": "Use a practical learning and project sequence.",
    }
    responses = FakeResponses(GapImprovementPlanBatch(plans=[{
        "normalized_key": "cloud_security", "plan": plan,
    }]))
    client = SimpleNamespace(responses=responses)
    recommend_gap_improvement_plans(
        categories=[{
            "normalized_key": "cloud_security", "category": "Security", "description": "A gap",
            "examples": [{"title": str(index), "text": "gap"} for index in range(12)],
        }],
        candidate_evidence={},
        ai_client=client,
    )
    assert len(json.loads(responses.kwargs["input"][1]["content"])["recurring_gaps"][0]["source_gaps"]) == 8

    client.responses = FakeResponses(None)
    try:
        recommend_gap_improvement_plans(
            categories=[{"normalized_key": "cloud_security", "category": "Security", "description": "A gap"}],
            candidate_evidence={}, ai_client=client,
        )
    except ValueError as exc:
        assert "no structured output" in str(exc)
    else:
        raise AssertionError("missing structured output should be rejected")

    client.responses = FakeResponses(GapImprovementPlanBatch(plans=[{
        "normalized_key": "cloud_security", "plan": plan,
    }]))
    try:
        recommend_gap_improvement_plans(
            categories=[
                {"normalized_key": "cloud_security", "category": "Security", "description": "A gap"},
                {"normalized_key": "identity", "category": "Identity", "description": "Another gap"},
            ],
            candidate_evidence={}, ai_client=client,
        )
    except ValueError as exc:
        assert "every displayed" in str(exc)
    else:
        raise AssertionError("omitted plans should be rejected")
