"""Interview preparation panel embedded in Applications."""

from __future__ import annotations

from datetime import datetime, time
from uuid import uuid4
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import streamlit as st

from matching.candidate_profile_persistence import PersistenceError, SupabaseRestClient
from matching.interview_preparation import (
    INTERVIEW_TYPES,
    create_interview_preparation,
    get_interview_preparation,
    list_interview_preparations_for_application,
    resolve_application_context,
    update_interview_preparation,
)
from matching.interview_preparation_pack import (
    PackGenerationError,
    generate_preparation_pack,
    get_saved_pack,
    is_safe_citation_url,
    resolve_exact_fit_assessment,
    source_fingerprint,
)


VIENNA = ZoneInfo("Europe/Vienna")


def _cv_label(row: dict) -> str:
    kind = "Base" if row.get("is_base") else "Tailored"
    date = str(row.get("created_at") or "")[:10] or "date unknown"
    return f"{row.get('label') or 'Unnamed CV'} | {kind} | {date} | #{row['id']}"


def _source_directory(rows: list[dict]) -> tuple[dict[str, int], dict[int, dict]]:
    source_numbers: dict[str, int] = {}
    entries: dict[int, dict] = {}
    number_by_url: dict[str, int] = {}
    for item in rows:
        if not isinstance(item, dict) or not is_safe_citation_url(str(item.get("url", ""))):
            continue
        source_id = item.get("id")
        url = str(item["url"])
        number = number_by_url.get(url)
        if number is None:
            number = len(entries) + 1
            number_by_url[url] = number
            entries[number] = item
        if source_id:
            source_numbers[str(source_id)] = number
    return source_numbers, entries


def _render_citation_refs(source_ids: list[str], source_numbers: dict[str, int]) -> None:
    numbers = list(dict.fromkeys(source_numbers[source_id] for source_id in source_ids if source_id in source_numbers))
    if numbers:
        st.caption("Sources: " + ", ".join(str(number) for number in numbers))


def _render_source_list(source_ids: list[str], source_numbers: dict[str, int],
                        entries: dict[int, dict], *, key: str) -> None:
    numbers = sorted({source_numbers[source_id] for source_id in source_ids if source_id in source_numbers})
    if not numbers:
        return
    with st.expander(f"Sources ({len(numbers)})"):
        for number in numbers:
            item = entries[number]
            st.link_button(f"{number}. {item.get('title') or 'Open source'}", item["url"],
                           key=f"{key}-source-{number}")


def _reset_application_selection() -> None:
    st.session_state.pop("interview_prep_record_id", None)
    st.session_state.pop("interview_prep_request_key", None)


def _date_fields(prefix: str, stored: str | None, scheduled: bool) -> datetime | None:
    local = datetime.fromisoformat(stored.replace("Z", "+00:00")).astimezone(VIENNA) if stored else None
    if not scheduled:
        return None
    chosen_date = st.date_input("Interview date", value=local.date() if local else "today", key=f"{prefix}-date")
    chosen_time = st.time_input("Interview time (Europe/Vienna)", value=local.time().replace(tzinfo=None) if local else time(9, 0), key=f"{prefix}-time")
    proposed = datetime.combine(chosen_date, chosen_time, tzinfo=VIENNA)
    if proposed.replace(fold=0).utcoffset() != proposed.replace(fold=1).utcoffset():
        raise ValueError("This local time is ambiguous in Europe/Vienna. Choose another time.")
    # Reject nonexistent wall times during the spring DST transition.
    if proposed.astimezone(ZoneInfo("UTC")).astimezone(VIENNA).replace(tzinfo=None) != datetime.combine(chosen_date, chosen_time):
        raise ValueError("This local time does not exist in Europe/Vienna. Choose another time.")
    return proposed


def _fields(prefix: str, scheduled: bool, row: dict | None = None) -> tuple[str, datetime | None, str, str, str]:
    row = row or {}
    options = list(INTERVIEW_TYPES)
    interview_type = st.selectbox("Interview type", options,
                                  index=options.index(row["interview_type"]) if row.get("interview_type") in options else 0,
                                  format_func=INTERVIEW_TYPES.get, key=f"{prefix}-type")
    date = _date_fields(prefix, row.get("interview_datetime"), scheduled)
    name = st.text_input("Interviewer name", value=row.get("interviewer_name") or "", key=f"{prefix}-name")
    role = st.text_input("Interviewer role", value=row.get("interviewer_role") or "", key=f"{prefix}-role")
    notes = st.text_area("Notes", value=row.get("interview_notes") or "", key=f"{prefix}-notes", height=120)
    return interview_type, date, name, role, notes


def _render_saved(client: SupabaseRestClient, user_id: str, preparation_id: str) -> None:
    row = get_interview_preparation(client, user_id=user_id, preparation_id=preparation_id)
    source = row["source_context"]
    st.subheader(f"{source['company']} | {source['title']}")
    st.caption(f"Preparation #{row['id']} | {row['status'].title()}")
    cv = source.get("cv")
    st.write("Submitted CV:", _cv_label(cv) if cv else "Not identified")
    if cv and cv.get("artifact_status") != "saved":
        st.warning("The selected CV artifact was unavailable when this preparation was created.")
    st.write("Candidate profile:", f"Version #{row['candidate_profile_id']}" if row.get("candidate_profile_id") else "Not available")
    st.write("Fit evaluation:", f"Version #{row['fit_assessment_id']}" if row.get("fit_assessment_id") else "Not available")
    st.write("Job description:", "Saved with this preparation" if source.get("description") else "Not available")
    scheduled = st.checkbox("Scheduled", value=bool(row.get("interview_datetime")), key=f"interview-edit-{preparation_id}-scheduled")
    with st.form(f"interview-edit-{preparation_id}"):
        try:
            interview_type, date, name, role, notes = _fields(f"interview-edit-{preparation_id}", scheduled, row)
        except ValueError as exc:
            st.error(str(exc))
            return
        save = st.form_submit_button("Save changes")
    if save:
        try:
            update_interview_preparation(
                client, user_id=user_id, preparation_id=preparation_id,
                interview_type=interview_type, interview_datetime=date,
                interviewer_name=name, interviewer_role=role, interview_notes=notes,
            )
        except (ValueError, PersistenceError):
            st.error("Could not save interview details. Please retry.")
        else:
            st.success("Interview details saved.")
            st.rerun(scope="fragment")
    _render_pack(client, user_id, row)


def _render_pack(client: SupabaseRestClient, user_id: str, row: dict) -> None:
    preparation_id = row["id"]
    source = row.get("source_context") or {}
    cv = source.get("cv") or {}
    profile = source.get("candidate_profile") or {}
    profile_data = profile.get("profile_json") or {}
    profile_cv_id = profile_data.get("source_cv_version_id") if isinstance(profile_data, dict) else None
    cv_mismatch = bool(cv and (profile_cv_id is None or str(profile_cv_id) != str(cv.get("id"))))
    try:
        saved = get_saved_pack(client, user_id=user_id, preparation_id=preparation_id)
    except PersistenceError:
        st.error("Preparation pack storage is unavailable. Apply the Phase 2 database migration before generating a pack.")
        return

    try:
        fit, fit_warnings = resolve_exact_fit_assessment(client, row)
        current_fingerprint = source_fingerprint(row, fit)
    except PersistenceError:
        current_fingerprint = None
        fit_warnings = ["The referenced Fit assessment could not be verified."]
    has_pack = bool(saved and saved.get("pack_json"))
    status = saved.get("generation_status") if saved else "idle"
    stale = bool(has_pack and (current_fingerprint is None or saved.get("source_fingerprint") != current_fingerprint))
    st.markdown("**Preparation pack**")
    st.caption(f"Interview stage: {INTERVIEW_TYPES.get(row.get('interview_type'), row.get('interview_type'))}")
    if not cv or cv.get("artifact_status") != "saved":
        st.info("Submitted CV is unavailable or unresolved. Generation can use the saved profile and Fit evidence without substituting another CV.")
    elif cv_mismatch:
        st.warning("The saved CandidateProfile does not verify provenance from this submitted CV. The two sources will be identified separately.")
    if not source.get("description"):
        st.warning("Frozen job-description details are missing. Any generated role analysis will be limited.")
    for warning in fit_warnings:
        st.info(warning)
    if has_pack:
        if stale:
            st.warning("Interview details or saved source context changed since this pack was generated. It remains available; regenerate explicitly to refresh it.")
        usage = saved.get("api_usage") or {}
        st.caption(f"Generated {str(saved.get('generated_at') or '')[:19]} UTC · model {saved.get('model') or 'unknown'} · input {int(usage.get('input_tokens') or 0)} / output {int(usage.get('output_tokens') or 0)} / total {int(usage.get('total_tokens') or 0)} tokens")
        if status == "failed":
            st.error("Regeneration failed. The previous successful pack is still available.")
        elif status == "running":
            st.info("A new generation is in progress. The previous successful pack remains available below.")

    consent = st.checkbox(
        "I understand generation sends the saved job description and necessary candidate evidence to OpenAI. A connection failure may trigger one extra generation request and charge.",
        key=f"interview-pack-consent-{preparation_id}",
    )
    action = "Regenerate preparation pack" if has_pack else "Generate preparation pack"
    st.caption("Each generation or regeneration makes OpenAI API requests and may incur usage charges.")
    if st.button(action, key=f"interview-pack-generate-{preparation_id}", disabled=not consent):
        with st.spinner("Researching the company and preparing your interview pack…"):
            try:
                generate_preparation_pack(client, user_id=user_id, preparation_id=preparation_id, consent_confirmed=True)
            except PackGenerationError as exc:
                st.error(str(exc))
                if has_pack:
                    st.info("Your previous successful preparation pack has been retained.")
            except (ValueError, PersistenceError):
                st.error("The preparation pack could not be generated or saved. Any previous successful pack was retained.")
            else:
                st.success("Preparation pack generated and saved.")
            st.rerun(scope="fragment")

    if not has_pack:
        if saved and saved.get("generation_status") == "running":
            st.info("Preparation pack generation is already in progress. Reopen this round shortly to check its status.")
        elif saved and saved.get("generation_status") == "failed":
            st.warning("The last generation attempt failed. You can explicitly retry; any previous successful pack remains unchanged.")
        return

    pack = saved["pack_json"]
    source_rows = saved.get("research_sources") or []
    source_numbers, source_entries = _source_directory(source_rows)
    evidence_catalog = {item.get("evidence_id"): item for item in pack.get("candidate_evidence_catalog", []) if isinstance(item, dict)}
    for disclosure in pack.get("generation_disclosures", []):
        st.warning(disclosure)
    tabs = st.tabs(["Company", "Role", "My experience", "Interview questions", "Topics to study", "Questions to ask", "Final briefing"])
    with tabs[0]:
        company = pack.get("company_intelligence") or {}
        company_source_ids = []
        for fact in company.get("facts", []):
            st.markdown(f"**{fact.get('evidence_category', '').replace('_', ' ').title()}**  \n{fact.get('claim', '')}")
            source_ids = fact.get("source_ids", [])
            company_source_ids.extend(source_ids)
            _render_citation_refs(source_ids, source_numbers)
        _render_source_list(company_source_ids, source_numbers, source_entries,
                            key=f"pack-company-sources-{preparation_id}")
        for note in company.get("research_limitations", []):
            st.caption(note)
        if not company.get("facts"):
            st.info("No company-specific facts were validated; this pack is grounded in the saved role and candidate evidence.")
    with tabs[1]:
        analysis = pack.get("job_requirement_analysis") or {}
        for heading, key in (("Responsibilities", "responsibilities"), ("Required competencies", "required_competencies"),
                             ("Preferred competencies", "preferred_competencies")):
            st.markdown(f"**{heading}**")
            for item in analysis.get(key, []):
                st.markdown(f"- {item.get('requirement')}: {item.get('evidence')}")
        for heading, key in (("Seniority and ownership", "seniority_and_ownership"), ("Technical focus", "technical_focus"),
                             ("Likely interview themes", "likely_themes")):
            st.markdown(f"**{heading}**")
            for item in analysis.get(key, []):
                st.markdown(f"- {item}")
    with tabs[2]:
        for item in pack.get("personal_experience_mapping", []):
            st.markdown(f"**{item.get('assessment', '').title()} · {item.get('requirement', '')}**")
            st.write(item.get("talking_point", ""))
            for evidence_id in item.get("candidate_evidence", []):
                evidence = evidence_catalog.get(evidence_id)
                if evidence:
                    st.caption(f"CandidateProfile · {evidence.get('source_section')} · {evidence.get('evidence_type')}")
                    st.write(evidence.get("statement", ""))
    with tabs[3]:
        question_source_ids = []
        for number, item in enumerate(pack.get("tailored_interview_questions", []), 1):
            with st.expander(f"{number}. {item.get('question', '')}"):
                st.caption(f"{item.get('category', '')} · {item.get('difficulty', '')}")
                st.write(item.get("why_it_matters", ""))
                for reference in item.get("evidence", []):
                    if reference in source_numbers:
                        question_source_ids.append(reference)
                        _render_citation_refs([reference], source_numbers)
                    elif reference:
                        st.caption(f"Evidence: {reference}")
                for evidence_id in item.get("candidate_evidence", []):
                    evidence = evidence_catalog.get(evidence_id)
                    if evidence:
                        st.caption(f"Candidate evidence · {evidence.get('source_section')}")
                        st.write(evidence.get("statement", ""))
                st.markdown("**Talking points**")
                for point in item.get("talking_points", []):
                    st.markdown(f"- {point}")
                st.write("Answer structure:", item.get("answer_structure", ""))
                st.write("Follow-up:", item.get("follow_up", ""))
        _render_source_list(question_source_ids, source_numbers, source_entries,
                            key=f"pack-question-sources-{preparation_id}")
    with tabs[4]:
        resource_source_ids = []
        for item in pack.get("knowledge_gap_preparation", []):
            with st.expander(f"{item.get('priority', '').title()} · {item.get('topic', '')}"):
                st.write(item.get("relevance", ""))
                st.write(item.get("explanation", ""))
                st.write("Practice:", item.get("practice_question", ""))
                source_ids = item.get("resource_source_ids", [])
                resource_source_ids.extend(source_ids)
                _render_citation_refs(source_ids, source_numbers)
        _render_source_list(resource_source_ids, source_numbers, source_entries,
                            key=f"pack-resource-sources-{preparation_id}")
    with tabs[5]:
        for item in pack.get("questions_for_interviewers", []):
            st.markdown(f"**{item.get('question', '')}**")
            st.caption(f"{item.get('stage', '')} · {item.get('why_useful', '')}")
    with tabs[6]:
        briefing = pack.get("final_interview_briefing") or {}
        for key, label in (("company_facts", "Company"), ("role_requirements", "Role"),
                           ("talking_points", "Your talking points"), ("examples", "Examples"),
                           ("knowledge_gaps", "Knowledge gaps"), ("questions_to_prepare", "Prepare"),
                           ("questions_to_ask", "Ask"), ("uncertainties", "Uncertainties")):
            values = briefing.get(key, [])
            if values:
                st.markdown(f"**{label}**")
                briefing_source_ids = []
                for value in values:
                    if isinstance(value, dict):
                        if key == "company_facts":
                            st.markdown(f"**{value.get('evidence_category', '').replace('_', ' ').title()}**  \n{value.get('claim', '')}")
                            source_ids = value.get("source_ids", [])
                            briefing_source_ids.extend(source_ids)
                            _render_citation_refs(source_ids, source_numbers)
                        else:
                            st.markdown(f"- {value.get('statement', '')}")
                            for evidence_id in value.get("evidence_ids", []):
                                evidence = evidence_catalog.get(evidence_id)
                                if evidence:
                                    st.caption(f"CandidateProfile · {evidence.get('source_section')} · {evidence.get('evidence_type')}")
                                    st.write(evidence.get("statement", ""))
                    else:
                        st.markdown(f"- {value}")
                if key == "company_facts":
                    _render_source_list(briefing_source_ids, source_numbers, source_entries,
                                        key=f"pack-brief-sources-{preparation_id}")


def render_interview_prep(client: SupabaseRestClient, *, user_id: str, job_id: int) -> None:
    st.divider()
    top = st.columns([4, 1])
    with top[0]:
        st.header("Interview Prep")
    with top[1]:
        if st.button("Close", key="interview-prep-close"):
            for key in ("interview_prep_job_id", "interview_prep_record_id", "interview_prep_request_key"):
                st.session_state.pop(key, None)
            st.rerun(scope="fragment")
    try:
        apps = client.get_json(f"/rest/v1/applications?{urlencode({'select': 'id,job_id,status,applied_at', 'user_id': f'eq.{user_id}', 'job_id': f'eq.{job_id}', 'order': 'created_at.desc,id.desc'})}")
        if not isinstance(apps, list) or not apps:
            st.warning("No application record is available for this listing.")
            return
        app_ids = [int(row["id"]) for row in apps]
        application_id = st.selectbox("Application", app_ids,
                                      format_func=lambda value: f"Application #{value}", key=f"interview-prep-app-{job_id}",
                                      on_change=_reset_application_selection)
        context = resolve_application_context(client, user_id=user_id, application_id=application_id)
        rounds = list_interview_preparations_for_application(client, user_id=user_id, application_id=application_id)
    except (ValueError, PersistenceError):
        st.error("Could not load this application's interview preparation data.")
        return
    st.subheader(f"{context['job']['company']} | {context['job']['title']}")
    st.caption(f"Application #{application_id} | {context['application']['status'].title()}")
    if rounds:
        st.markdown("**Saved interview rounds**")
        for round_row in rounds:
            label = INTERVIEW_TYPES.get(round_row["interview_type"], round_row["interview_type"])
            date = round_row.get("interview_datetime")
            detail = datetime.fromisoformat(date.replace("Z", "+00:00")).astimezone(VIENNA).strftime("%d %b %Y %H:%M") if date else "Unscheduled"
            created = datetime.fromisoformat(round_row["created_at"].replace("Z", "+00:00")).astimezone(VIENNA).strftime("%d %b %Y %H:%M")
            if st.button(f"{label} | {detail} | created {created} | #{str(round_row['id'])[:8]}",
                         key=f"interview-open-{round_row['id']}"):
                st.session_state["interview_prep_record_id"] = round_row["id"]
                st.rerun(scope="fragment")
    selected_id = st.session_state.get("interview_prep_record_id")
    if selected_id and any(row["id"] == selected_id for row in rounds):
        if st.button("New interview round", key="interview-new-round"):
            st.session_state.pop("interview_prep_record_id", None)
            st.session_state.pop("interview_prep_request_key", None)
            st.rerun(scope="fragment")
        try:
            _render_saved(client, user_id, selected_id)
        except (ValueError, PersistenceError):
            st.error("Could not reopen this interview preparation.")
        return
    st.markdown("**Create preparation**")
    submitted = context["submitted_cv"]
    versions = context["cv_versions"]
    selected_cv_id = int(submitted["id"]) if submitted else None
    confirmed = submitted is not None
    if submitted:
        st.write("Submitted CV:", _cv_label(submitted))
    elif versions:
        st.warning("The CV actually submitted with this application is not recorded. Confirm it before creating this round.")
        options = [None, *(int(row["id"]) for row in versions)]
        selected_cv_id = st.selectbox("CV sent with this application", options,
                                      format_func=lambda value: "Unknown / create a draft" if value is None else _cv_label(next(row for row in versions if row["id"] == value)),
                                      key=f"interview-cv-{application_id}")
        confirmed = st.checkbox("I confirm this is the CV I submitted", key=f"interview-cv-confirm-{application_id}") if selected_cv_id else False
    else:
        st.warning("No associated CV artifact is available. You can create a draft without a submitted CV.")
    st.write("Candidate profile:", f"Version #{context['profile']['id']}" if context["profile"] else "Not available")
    st.write("Fit evaluation:", f"Version #{context['assessment']['id']}" if context["assessment"] else "Not available")
    st.write("Job description:", "Available" if context["job"].get("description") else "Not available")
    st.session_state.setdefault("interview_prep_request_key", str(uuid4()))
    scheduled = st.checkbox("Scheduled", key=f"interview-create-{application_id}-scheduled")
    with st.form(f"interview-create-{application_id}"):
        interview_type, date, name, role, notes = _fields(f"interview-create-{application_id}", scheduled)
        create = st.form_submit_button("Create preparation")
    if create:
        try:
            row = create_interview_preparation(
                client, user_id=user_id, application_id=application_id,
                idempotency_key=st.session_state["interview_prep_request_key"],
                interview_type=interview_type, selected_cv_version_id=selected_cv_id,
                cv_confirmed=confirmed, interview_datetime=date, interviewer_name=name,
                interviewer_role=role, interview_notes=notes,
            )
        except ValueError as exc:
            st.error(str(exc))
        except PersistenceError:
            st.error("Could not create the preparation. Please retry.")
        else:
            st.session_state["interview_prep_record_id"] = row["id"]
            st.session_state.pop("interview_prep_request_key", None)
            st.rerun(scope="fragment")
