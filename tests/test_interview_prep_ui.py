from pathlib import Path
from datetime import date, time

from streamlit.testing.v1 import AppTest

import ui.dashboard as dashboard


FIXTURE = Path(__file__).parent / "fixtures" / "interview_prep_app.py"
APPLICATIONS_FIXTURE = Path(__file__).parent / "fixtures" / "interview_prep_applications.py"
PHASE2_FIXTURE = Path(__file__).parent / "fixtures" / "interview_prep_phase2_app.py"


def test_create_reopen_edit_and_multiple_rounds_in_streamlit():
    at = AppTest.from_file(str(FIXTURE), default_timeout=10).run()
    assert not at.exception
    assert any("Nebius" in item.value for item in at.subheader)
    assert any("actually submitted" in item.value for item in at.warning)
    cv = next(item for item in at.selectbox if item.label == "CV sent with this application")
    cv.select(31).run()
    confirm = next(item for item in at.checkbox if item.label.startswith("I confirm"))
    confirm.check().run()
    kind = next(item for item in at.selectbox if item.label == "Interview type")
    kind.select("technical")
    next(item for item in at.button if item.label == "Create preparation").click().run()
    assert not at.exception
    client = at.session_state["client"]
    assert len(client.tables["interview_preparations"]) == 1
    first = client.tables["interview_preparations"][0]
    assert first["interview_type"] == "technical"
    assert first["submitted_cv_version_id"] == 31
    assert at.session_state["interview_prep_record_id"] == first["id"]
    at.run()
    assert any("Submitted CV" in str(item.value) for item in at.markdown)
    next(item for item in at.checkbox if item.label == "Scheduled").check().run()
    next(item for item in at.date_input if item.label == "Interview date").set_value(date(2026, 11, 5))
    next(item for item in at.time_input if item.label.startswith("Interview time")).set_value(time(14, 30))
    next(item for item in at.text_area if item.label == "Notes").set_value("Architecture discussion")
    next(item for item in at.button if item.label == "Save changes").click().run()
    assert client.tables["interview_preparations"][0]["interview_notes"] == "Architecture discussion"
    assert client.tables["interview_preparations"][0]["interview_datetime"].startswith("2026-11-05T14:30")
    next(item for item in at.button if item.label == "New interview round").click().run()
    at.run()
    next(item for item in at.button if item.label == "Create preparation").click().run()
    assert len(client.tables["interview_preparations"]) == 2
    assert client.tables["interview_preparations"][0]["id"] != client.tables["interview_preparations"][1]["id"]
    assert not at.exception


def test_missing_cv_and_other_optional_sources_show_draft_state():
    at = AppTest.from_file(str(FIXTURE), default_timeout=10).run()
    client = at.session_state["client"]
    client.tables["cv_versions"].clear()
    client.tables["candidate_profiles"].clear()
    client.tables["job_match_assessments"].clear()
    client.tables["jobs"][0]["description"] = None
    at.run()
    assert any("No associated CV artifact" in item.value for item in at.warning)
    next(item for item in at.button if item.label == "Create preparation").click().run()
    assert client.tables["interview_preparations"][0]["status"] == "draft"
    assert client.tables["interview_preparations"][0]["submitted_cv_version_id"] is None
    assert not at.exception


def test_application_action_opens_correct_job_context(monkeypatch):
    state = {"interview_prep_record_id": "prior", "interview_prep_request_key": "prior"}
    monkeypatch.setattr(dashboard.st, "session_state", state)
    dashboard._open_interview_prep(20)
    assert state == {"interview_prep_job_id": 20}


def test_interview_prep_opens_from_existing_application_card():
    at = AppTest.from_file(str(APPLICATIONS_FIXTURE), default_timeout=10).run()
    assert not at.exception
    assert any(item.label == "Interview Prep" for item in at.button)
    next(item for item in at.button if item.label == "Interview Prep").click().run()
    assert not at.exception
    assert at.session_state["interview_prep_job_id"] == 20
    assert any("Nebius" in item.value for item in at.subheader)


def test_pack_requires_explicit_consent_and_generates_only_on_button(monkeypatch):
    import ui.interview_prep as panel

    calls = []
    monkeypatch.setattr(panel, "get_saved_pack", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(panel, "generate_preparation_pack", lambda *args, **kwargs: calls.append((args, kwargs)))
    at = AppTest.from_file(str(FIXTURE), default_timeout=10).run()
    client = at.session_state["client"]
    at.session_state["interview_prep_request_key"] = "33333333-3333-4333-8333-333333333333"
    next(item for item in at.button if item.label == "Create preparation").click().run()
    at.run()
    assert not at.exception
    assert any(item.label == "Generate preparation pack" and item.disabled for item in at.button)
    assert calls == []
    next(item for item in at.checkbox if item.label.startswith("I understand generation sends")).check().run()
    assert calls == []
    next(item for item in at.button if item.label == "Generate preparation pack").click().run()
    assert not at.exception
    assert len(calls) == 1
    assert client.tables["applications"][0]["status"] == "applied"


def test_saved_pack_is_displayed_on_reopen_without_generation(monkeypatch):
    import ui.interview_prep as panel

    fake_pack = {
        "generation_status": "ready", "source_fingerprint": "old-fingerprint", "generated_at": "2026-10-27T12:00:00Z",
        "model": "test-model", "api_usage": {"total_tokens": 42}, "research_sources": [],
        "pack_json": {
            "generation_disclosures": ["Synthetic provenance disclosure"],
            "company_intelligence": {"facts": [], "research_limitations": []},
            "job_requirement_analysis": {}, "personal_experience_mapping": [],
            "tailored_interview_questions": [], "knowledge_gap_preparation": [],
            "questions_for_interviewers": [], "final_interview_briefing": {},
        },
    }
    monkeypatch.setattr(panel, "get_saved_pack", lambda *_args, **_kwargs: fake_pack)
    generate_calls = []
    monkeypatch.setattr(panel, "generate_preparation_pack", lambda *a, **kw: generate_calls.append(1))
    at = AppTest.from_file(str(FIXTURE), default_timeout=10).run()
    next(item for item in at.button if item.label == "Create preparation").click().run()
    at.run()
    assert not at.exception
    assert any("Synthetic provenance disclosure" in item.value for item in at.warning)
    assert any(item.label == "Regenerate preparation pack" for item in at.button)
    assert generate_calls == []


def test_repeated_company_sources_are_shown_once_in_collapsible_list(monkeypatch):
    import ui.interview_prep as panel

    source_id = "src_duplicate_source"
    fake_pack = {
        "generation_status": "ready", "research_sources": [{
            "id": source_id, "title": "Company security page", "url": "https://example.test/security",
        }],
        "pack_json": {
            "generation_disclosures": [],
            "company_intelligence": {"facts": [
                {"evidence_category": "verified_company_source", "claim": "Fact one", "source_ids": [source_id]},
                {"evidence_category": "verified_company_source", "claim": "Fact two", "source_ids": [source_id]},
            ], "research_limitations": []},
            "job_requirement_analysis": {}, "personal_experience_mapping": [],
            "tailored_interview_questions": [], "knowledge_gap_preparation": [],
            "questions_for_interviewers": [], "final_interview_briefing": {},
        },
    }
    monkeypatch.setattr(panel, "get_saved_pack", lambda *_args, **_kwargs: fake_pack)
    link_keys = []
    original_link_button = panel.st.link_button

    def track_link_button(label, url, *, key=None, **kwargs):
        link_keys.append(key)
        return original_link_button(label, url, key=key, **kwargs)

    monkeypatch.setattr(panel.st, "link_button", track_link_button)
    at = AppTest.from_file(str(FIXTURE), default_timeout=10).run()
    next(item for item in at.button if item.label == "Create preparation").click().run()
    at.run()
    assert not at.exception
    prep_id = at.session_state["interview_prep_record_id"]
    assert link_keys == [f"pack-company-sources-{prep_id}-source-1"]
    assert sum("Sources: 1" in item.value for item in at.caption) == 2


def test_synthetic_pack_pipeline_runs_through_streamlit_and_persists():
    at = AppTest.from_file(str(PHASE2_FIXTURE), default_timeout=10).run()
    next(item for item in at.selectbox if item.label == "CV sent with this application").select(31).run()
    next(item for item in at.checkbox if item.label.startswith("I confirm this is the CV")).check().run()
    next(item for item in at.button if item.label == "Create preparation").click().run()
    at.run()
    next(item for item in at.checkbox if item.label.startswith("I understand generation sends")).check().run()
    next(item for item in at.button if item.label == "Generate preparation pack").click().run()
    at.run()
    assert not at.exception
    client = at.session_state["client"]
    records = client.tables["interview_preparation_packs"]
    assert len(records) == 1
    saved = records[0]
    assert saved["generation_status"] == "ready"
    assert saved["pack_json"]["job_requirement_analysis"]
    assert saved["pack_json"]["tailored_interview_questions"]
    assert saved["pack_json"]["final_interview_briefing"]
    assert saved["api_usage"]["total_tokens"] == 65
    assert client.tables["applications"][0]["status"] == "applied"
    assert any("ExampleCo builds cloud infrastructure" in str(item.value) for item in at.markdown)
