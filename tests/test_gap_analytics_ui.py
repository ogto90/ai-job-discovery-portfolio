from types import SimpleNamespace
from contextlib import nullcontext

from ui import dashboard
from matching.gap_recommendations import GapImprovementPlan


def test_gap_analytics_shows_only_gap_percentage_and_explanation(monkeypatch):
    rendered = []
    errors = []
    buttons = []
    monkeypatch.setattr(dashboard.st, "session_state", {})
    monkeypatch.setattr(dashboard.st, "subheader", lambda value: rendered.append(("heading", value)))
    monkeypatch.setattr(dashboard.st, "markdown", lambda value, **kwargs: rendered.append(("html", value)))
    monkeypatch.setattr(dashboard.st, "button", lambda value, **kwargs: buttons.append(value) or False)
    monkeypatch.setattr(dashboard.st, "info", lambda value: errors.append(value))
    monkeypatch.setattr(dashboard.st, "error", lambda value: errors.append(value))
    monkeypatch.setattr(dashboard.st, "caption", lambda value: rendered.append(("caption", value)))
    monkeypatch.setattr(
        dashboard.st, "expander",
        lambda label, **kwargs: rendered.append(("expander", label)) or nullcontext(),
    )
    monkeypatch.setattr(dashboard, "load_candidate_profile_options", lambda *args, **kwargs: [SimpleNamespace(id=7, label="Current")])
    monkeypatch.setattr(dashboard, "load_gap_assessments", lambda *args, **kwargs: [])
    monkeypatch.setattr(dashboard, "load_gap_mappings", lambda *args, **kwargs: [])
    dashboard._load_gap_analytics_data_cached.clear()
    monkeypatch.setattr(dashboard, "calculate_gap_analytics", lambda *args: {
        "pending_gaps": 0,
        "top_categories": [SimpleNamespace(
            category="Cloud & infrastructure security",
            percentage=61.3,
            description="Limited production cloud evidence.",
            examples=(),
        )],
    })

    dashboard._render_gap_analytics(object(), user_id="test-user")

    assert errors == []
    assert rendered[0] == ("heading", "Top recurring gaps")
    assert buttons == ["Analyze gaps"]
    assert "Cloud & infrastructure security · 61.3%" in [item[1] for item in rendered if item[0] == "expander"]
    html = next(item[1] for item in rendered if item[0] == "html")
    assert "61.3%" in html
    assert "Limited production cloud evidence." in [item[1] for item in rendered if item[0] == "caption"]
    assert 'role="progressbar"' in html
    assert "View source gaps" not in html


def test_gap_analytics_snapshot_is_cached_per_revision(monkeypatch):
    calls = []
    monkeypatch.setattr(dashboard, "load_candidate_profile_options", lambda *args, **kwargs: calls.append("profiles") or [SimpleNamespace(id=7, label="Current")])
    monkeypatch.setattr(dashboard, "load_gap_assessments", lambda *args, **kwargs: calls.append("assessments") or [])
    monkeypatch.setattr(dashboard, "load_gap_mappings", lambda *args, **kwargs: calls.append("mappings") or [])
    dashboard._load_gap_analytics_data_cached.clear()
    client = object()

    first = dashboard._load_gap_analytics_data_cached(client, "cache-user", "project", 993)
    second = dashboard._load_gap_analytics_data_cached(client, "cache-user", "project", 993)

    assert first == second
    assert calls == ["profiles", "assessments", "mappings"]


def test_analyze_new_gaps_runs_immediately_with_one_click(monkeypatch):
    state = {}
    calls = []
    monkeypatch.setattr(dashboard.st, "session_state", state)
    monkeypatch.setattr(dashboard.st, "subheader", lambda *args: None)
    monkeypatch.setattr(dashboard.st, "markdown", lambda *args, **kwargs: None)
    monkeypatch.setattr(dashboard.st, "info", lambda *args: None)
    monkeypatch.setattr(dashboard.st, "error", lambda *args: None)
    monkeypatch.setattr(dashboard.st, "button", lambda label, **kwargs: label == "Analyze gaps")
    monkeypatch.setattr(dashboard.st, "spinner", lambda *args: nullcontext())
    monkeypatch.setattr(dashboard.st, "rerun", lambda **_kwargs: None)
    monkeypatch.setattr(dashboard, "load_candidate_profile_options", lambda *args, **kwargs: [SimpleNamespace(id=7, label="Current", is_current=True)])
    monkeypatch.setattr(dashboard, "load_gap_assessments", lambda *args, **kwargs: [])
    monkeypatch.setattr(dashboard, "load_gap_mappings", lambda *args, **kwargs: [])
    dashboard._load_gap_analytics_data_cached.clear()
    monkeypatch.setattr(dashboard, "calculate_gap_analytics", lambda *args: {"pending_gaps": 2, "top_categories": []})
    monkeypatch.setattr(dashboard, "analyze_unmapped_gaps", lambda *args, **kwargs: calls.append(True) or {"analyzed": 2})
    monkeypatch.setattr(dashboard, "load_gap_mappings", lambda *args, **kwargs: [])
    monkeypatch.setattr(dashboard, "candidate_improvement_evidence", lambda *_args: {})
    monkeypatch.setattr(dashboard, "CandidateProfile", SimpleNamespace(model_validate=lambda value: value))
    client = SimpleNamespace(get_json=lambda *_args: [{"user_id": "test-user", "profile_json": {}}])

    dashboard._render_gap_analytics(client, user_id="test-user")

    assert calls == [True]
    assert state["gap_analysis_flash"] == {"analyzed": 2, "plans": 0}
    assert "busy_job_id" not in state


def test_analyze_gaps_builds_and_caches_plans_for_each_expanded_gap(monkeypatch):
    state = {}
    rendered = []
    generation_calls = []
    monkeypatch.setattr(dashboard.st, "session_state", state)
    monkeypatch.setattr(dashboard.st, "subheader", lambda *args: None)
    monkeypatch.setattr(dashboard.st, "markdown", lambda value, **kwargs: rendered.append(value))
    monkeypatch.setattr(dashboard.st, "caption", lambda *_args: None)
    monkeypatch.setattr(dashboard.st, "error", lambda value: rendered.append(value))
    monkeypatch.setattr(dashboard.st, "info", lambda *_args: None)
    monkeypatch.setattr(dashboard.st, "expander", lambda *args, **kwargs: nullcontext())
    monkeypatch.setattr(dashboard.st, "spinner", lambda *args: nullcontext())
    monkeypatch.setattr(dashboard.st, "rerun", lambda **_kwargs: None)
    monkeypatch.setattr(dashboard.st, "button", lambda label, **_kwargs: label == "Analyze gaps")
    monkeypatch.setattr(dashboard, "load_candidate_profile_options", lambda *args, **kwargs: [SimpleNamespace(id=7, label="Current", is_current=True)])
    monkeypatch.setattr(dashboard, "load_gap_assessments", lambda *args, **kwargs: [])
    monkeypatch.setattr(dashboard, "load_gap_mappings", lambda *args, **kwargs: [])
    dashboard._load_gap_analytics_data_cached.clear()
    analytics = {
        "pending_gaps": 0,
        "top_categories": [SimpleNamespace(
            normalized_key="cloud_security", category="Cloud security", percentage=50, description="Limited production cloud evidence.",
            examples=(SimpleNamespace(title="Cloud Security Engineer", text="Limited cloud control ownership."),),
        )],
    }
    monkeypatch.setattr(dashboard, "calculate_gap_analytics", lambda *args: analytics)

    def generate(**kwargs):
        generation_calls.append(kwargs)
        return {"cloud_security": GapImprovementPlan(
            overview="Build evidence through one focused project.",
            hands_on_experience=["Deploy and secure a small cloud workload."],
            learning=["Practice IAM policy review."], certifications=[], evidence_to_build=["Document threat and control decisions."],
        )}

    monkeypatch.setattr(dashboard, "recommend_gap_improvement_plans", generate)
    monkeypatch.setattr(dashboard, "candidate_improvement_evidence", lambda profile: {"current_role": "Engineer"})
    monkeypatch.setattr(dashboard, "CandidateProfile", SimpleNamespace(model_validate=lambda value: value))
    client = SimpleNamespace(get_json=lambda *_args: [{"user_id": "test-user", "profile_json": {}}])
    dashboard._render_gap_analytics(client, user_id="test-user")

    assert len(generation_calls) == 1
    assert generation_calls[0]["candidate_evidence"] == {"current_role": "Engineer"}
    assert generation_calls[0]["categories"][0]["examples"] == [{
        "title": "Cloud Security Engineer", "text": "Limited cloud control ownership.",
    }]
    assert len(state["gap_improvement_plans"]) == 1
    assert "Create improvement plan" not in rendered
