"""Dark, user-scoped Profile page for CV evidence and discovery preferences."""

from __future__ import annotations

import os
import streamlit as st

from matching.candidate_profile import CandidateProfile
from matching.candidate_profile_persistence import PersistenceError, SupabaseRestClient
from matching.cv_parser import parse_candidate_profile
from matching.search_profile import SearchProfile
from matching.tailored_cv import TailoredCVError, compile_latex
from .profile_data import (
    EMPLOYMENT_TYPES, SENIORITY, load_profile_context,
    parse_line_values, save_and_parse_base_cv, save_job_preferences, search_profile_model, validate_latex_upload,
)

_APPTEST_CLIENT = None


def _render_profile_app_test() -> None:
    """Named entry point used only by Streamlit's offline AppTest harness."""
    import ui.profile as profile_ui

    profile_ui.render_profile(profile_ui._APPTEST_CLIENT, user_id="user-a")


def _style() -> None:
    st.markdown("""
    <style>
    .stApp{background:#0f1117;color:#f3f4f6}.block-container{max-width:1220px;padding-top:1.2rem}
    h1,h2,h3,label,p{color:#f3f4f6}.profile-card{background:#181b24;border:1px solid #2b3040;border-radius:12px;padding:1rem 1.1rem;margin:.45rem 0 1rem}
    [data-testid="stTextInput"] input,[data-testid="stTextArea"] textarea,[data-testid="stMultiSelect"] [data-baseweb="select"]>div{background:#181b24;color:#f3f4f6;border-color:#2b3040}
    [data-testid="stFileUploader"] section{background:#181b24;border:1px dashed #343a4a;border-radius:10px}
    </style>""", unsafe_allow_html=True)


def candidate_preview_data(profile: CandidateProfile) -> dict[str, object]:
    """Expose only human-facing facts, never evidence levels or provenance metadata."""
    ordered = sorted(profile.capabilities, key=lambda item: (-int(item.evidence_level), item.normalized_name.casefold()))
    names = list(dict.fromkeys(_display_capability(item.normalized_name) for item in ordered if int(item.evidence_level) > 0))[:7]
    return {
        "current_role": profile.current_role,
        "experience": f"{profile.total_professional_experience_years:g} years" if profile.total_professional_experience_years is not None else None,
        "key_areas": names,
        "certifications": [item.name for item in profile.certifications],
    }


def _display_capability(value: str) -> str:
    displayed = value.title()
    for acronym in ("Sast", "Sca", "Dast", "Aws", "Iam", "Api", "Ci/Cd", "Iso"):
        displayed = displayed.replace(acronym, acronym.upper())
    return displayed


def _candidate_preview(profile: CandidateProfile | None) -> None:
    st.subheader("Candidate profile")
    if profile is None:
        st.info("Candidate profile needs generation.")
        return
    preview = candidate_preview_data(profile)
    left, right = st.columns(2)
    with left:
        st.markdown("**Current role**")
        st.write(preview["current_role"])
        if preview["experience"]:
            st.markdown("**Experience**")
            st.write(preview["experience"])
    with right:
        st.markdown("**Key areas**")
        st.write(" · ".join(preview["key_areas"]) if preview["key_areas"] else "No capabilities recorded")
        st.markdown("**Certifications**")
        st.write(", ".join(preview["certifications"]) or "None recorded")


def _render_preferences(client: SupabaseRestClient, user_id: str, row: dict | None) -> None:
    st.subheader("Job Preferences")
    st.caption("Preferences guide discovery; they do not alter factual profile evidence or AI Fit.")
    profile = search_profile_model(row) if row else SearchProfile(name="Job preferences")
    accepted_jobs = list(dict.fromkeys(profile.accepted_employment_types + profile.employment_types))
    seniority_options = list(dict.fromkeys((*SENIORITY, *profile.target_seniority, *profile.accepted_seniority, *profile.excluded_seniority)))
    employment_options = list(dict.fromkeys((*EMPLOYMENT_TYPES, *accepted_jobs, *profile.excluded_employment_types)))

    with st.form("profile-preferences-form"):
        left, middle, right = st.columns(3)
        with left:
            st.markdown("**Roles**")
            titles = st.text_area("Target job titles", "\n".join(profile.target_titles), height=90)
            terms = st.text_area("Related terms", "\n".join(profile.target_terms), height=90)
            excluded_titles = st.text_area("Excluded job titles", "\n".join(dict.fromkeys(profile.excluded_titles + profile.excluded_title_patterns)), height=80)
            excluded_terms = st.text_area("Excluded terms", "\n".join(profile.excluded_terms), height=80)
        with middle:
            st.markdown("**Seniority & employment**")
            target_seniority = st.multiselect("Target seniority", seniority_options, default=profile.target_seniority)
            accepted_seniority = st.multiselect("Also consider", seniority_options, default=profile.accepted_seniority)
            excluded_seniority = st.multiselect("Exclude seniority", seniority_options, default=profile.excluded_seniority)
            accepted_employment = st.multiselect("Employment types accepted", employment_options, default=accepted_jobs, format_func=lambda value: value.replace("_", " ").title())
            excluded_employment = st.multiselect("Employment types excluded", employment_options, default=profile.excluded_employment_types, format_func=lambda value: value.replace("_", " ").title())
        with right:
            st.markdown("**Location**")
            allowed_regions = st.text_area("Allowed regions", "\n".join(profile.allowed_regions), height=80, placeholder="Europe\nEU / EEA\nWorldwide")
            allowed_countries = st.text_area("Allowed countries", "\n".join(profile.allowed_countries), height=70, placeholder="Austria\nGermany")
            locations = st.text_area("Specific locations", "\n".join(profile.locations), height=70, placeholder="Vienna\nBerlin")
            excluded_regions = st.text_area("Excluded regions", "\n".join(profile.excluded_regions), height=70)
            excluded_countries = st.text_area("Excluded countries", "\n".join(profile.excluded_countries), height=70)
        submitted = st.form_submit_button("Save job preferences", type="primary")
    if not submitted:
        return

    overlap = set(accepted_employment) & set(excluded_employment)
    if overlap:
        st.error("An employment type cannot be both accepted and excluded.")
        return
    try:
        saved = save_job_preferences(client, user_id=user_id, row=row, definition_updates={
            "target_titles": parse_line_values(titles),
            "target_terms": parse_line_values(terms),
            "excluded_titles": parse_line_values(excluded_titles),
            "excluded_title_patterns": parse_line_values(excluded_titles),
            "excluded_terms": parse_line_values(excluded_terms),
            "target_seniority": target_seniority,
            "accepted_seniority": accepted_seniority,
            "excluded_seniority": excluded_seniority,
            "allowed_regions": parse_line_values(allowed_regions),
            "allowed_countries": parse_line_values(allowed_countries),
            "locations": parse_line_values(locations),
            "excluded_regions": parse_line_values(excluded_regions),
            "excluded_countries": parse_line_values(excluded_countries),
            "employment_types": accepted_employment,
            "accepted_employment_types": accepted_employment,
            "excluded_employment_types": excluded_employment,
        })
    except (PersistenceError, ValueError) as exc:
        st.error(str(exc))
        return
    st.success("Preferences saved")
    st.rerun(scope="fragment")


@st.fragment
def render_profile(client: SupabaseRestClient, *, user_id: str) -> None:
    _style()
    st.title("Profile")
    try:
        context = load_profile_context(client, user_id)
    except (PersistenceError, ValueError) as exc:
        st.error(f"Profile could not be loaded: {exc}")
        return
    cv = context["cv"]
    search = context["search_profile"]
    columns = st.columns(3)
    with columns[0]:
        st.markdown("**Active CV**")
        st.write(cv.get("label") if cv else "No base CV uploaded")
        if cv and cv.get("created_at"):
            st.caption(f"Uploaded {str(cv['created_at'])[:10]}")
    with columns[1]:
        st.markdown("**Candidate profile**")
        st.write("Ready" if context["candidate"] else "Needs generation")
    with columns[2]:
        st.markdown("**Job preferences**")
        st.write("Configured" if search else "Incomplete")

    st.divider()
    base_col, candidate_col = st.columns([1, 1.2], gap="large")
    with base_col:
        st.subheader("Base CV")
        if cv:
            st.markdown(f"**{cv.get('label') or 'Base CV'}**")
            if cv.get("created_at"):
                st.caption(f"Uploaded {str(cv['created_at'])[:10]} · Active")
            pdf_key = f"profile_base_pdf_{cv['id']}"
            if pdf_key in st.session_state:
                st.download_button("Download current CV (PDF)", st.session_state[pdf_key], file_name="base_cv.pdf", mime="application/pdf")
            elif st.button("Prepare current CV PDF"):
                try:
                    with st.spinner("Preparing PDF…"):
                        source = client.download_storage_object(cv["storage_bucket"], cv["file_path"])
                        st.session_state[pdf_key] = compile_latex(source.decode("utf-8"))
                except (PersistenceError, UnicodeDecodeError, TailoredCVError) as exc:
                    st.error(f"The current CV PDF could not be prepared: {exc}")
                else:
                    st.rerun(scope="fragment")
            with st.expander("View source") as source_expander:
                if source_expander.open:
                    try:
                        source = client.download_storage_object(cv["storage_bucket"], cv["file_path"])
                        st.code(source.decode("utf-8", errors="replace"), language="latex")
                    except PersistenceError as exc:
                        st.error(f"Current CV source could not be loaded: {exc}")
        else:
            st.info("No base CV uploaded.")

        st.markdown("**Replace CV**")
        upload = st.file_uploader("LaTeX CV", type=["tex"], key="profile_cv_upload")
        valid_source = None
        if upload is not None:
            try:
                valid_source = validate_latex_upload(upload.name, upload.getvalue())
            except ValueError as exc:
                st.error(str(exc))
            else:
                st.success("LaTeX structure validated. Current CV stays active until parsing succeeds.")
        submitted = st.button("Save & Parse", type="primary", disabled=valid_source is None, key="profile_save_parse")
        if submitted and upload is not None:
            try:
                with st.spinner("Parsing CV and preparing the new profile…"):
                    save_and_parse_base_cv(
                        client, user_id=user_id, filename=upload.name, data=upload.getvalue(),
                        parser=parse_candidate_profile, model=os.getenv("OPENAI_MODEL", "gpt-6-luna"),
                    )
            except Exception as exc:
                st.error(f"CV replacement failed. The previous active CV and profile were preserved. {exc}")
            else:
                if cv:
                    st.session_state.pop(f"profile_base_pdf_{cv['id']}", None)
                st.success("CV and CandidateProfile updated")
                st.rerun(scope="fragment")
    with candidate_col:
        _candidate_preview(context["candidate"])

    st.divider()
    _render_preferences(client, user_id, search)
