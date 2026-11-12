"""Local Streamlit entry point for job search and CV review."""

from __future__ import annotations

import os
from pathlib import Path
import time

import streamlit as st

from matching.candidate_profile_persistence import PersistenceError, SupabaseRestClient, load_env_file, supabase_data_revision, supabase_card_revision
from ui.dashboard import (
    get_dashboard_jobs_snapshot,
    get_dashboard_context_snapshot,
    render_applications,
    render_dashboard,
    render_gap_analytics_page,
    save_dashboard_context_snapshot,
    _load_gap_analytics_data_cached,
    _reconcile_dashboard_overrides,
)
from ui.cv_diff import render_cv_diff
from ui.settings import render_settings
from ui.manual_job import create_and_rate_manual_job
from ui.manual_jd import load_manual_job_context
from ui.profile import render_profile
from ui.profile_data import resolve_application_user_id, load_profile_context
from ui.page_loading import page_data, loading_notice, load_positions, PENDING
from ui.dashboard_summary import bounded_dashboard_enabled, fetch_dashboard_page


ROOT = Path(__file__).resolve().parent


def _dashboard_summary_activation_setting() -> str:
    value = os.getenv("AI_JOB_SEARCH_BOUNDED_DASHBOARD_ENABLED")
    if value:
        return value
    try:
        return str(st.secrets.get("AI_JOB_SEARCH_BOUNDED_DASHBOARD_ENABLED", "true"))
    except Exception:
        return "true"


def _app_styles() -> None:
    """Style app-level navigation before Streamlit creates the tab widgets."""

    st.markdown(
        """
        <style>
        .stTabs {
            margin-top: 1.35rem;
            margin-bottom: 0.9rem;
        }
        .stTabs [data-baseweb="tab-list"] {
            gap: 0.35rem;
            border-bottom: 1px solid #2b3040;
        }
        .stTabs [data-baseweb="tab"] {
            color: #a8afbd !important;
            background: transparent !important;
            border-radius: 8px 8px 0 0;
            padding: 0.65rem 1rem;
        }
        .stTabs [data-baseweb="tab"] p,
        .stTabs [data-baseweb="tab"] span {
            color: #a8afbd !important;
            font-weight: 650;
        }
        .stTabs [data-baseweb="tab"][aria-selected="true"],
        .stTabs [data-baseweb="tab"][aria-selected="true"] p,
        .stTabs [data-baseweb="tab"][aria-selected="true"] span {
            color: #f3f4f6 !important;
        }
        .stTabs [data-baseweb="tab-highlight"] {
            background: #6c5ce7 !important;
            height: 3px;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


def main() -> None:
    load_env_file(ROOT / ".env")
    load_env_file(ROOT / ".env.daily-job-report")
    url = os.getenv("SUPABASE_URL")
    secret = os.getenv("SUPABASE_SECRET_KEY")
    if not url or not secret:
        st.error("SUPABASE_URL and SUPABASE_SECRET_KEY are required in the local environment.")
        st.stop()

    try:
        client = SupabaseRestClient(url, secret)
        st.set_page_config(page_title="PairRole", page_icon="J", layout="wide")
    except PersistenceError:
        st.error("The Jobs dashboard could not load its server-side data.")
        st.stop()
    try:
        user_id = resolve_application_user_id(client)
        if st.query_params.get("view") == "cv_diff":
            render_cv_diff(client, user_id)
            return
        pending_page = st.session_state.pop("_pending_app_page", None)
        if pending_page in {"Jobs", "Applications", "Settings"}:
            st.session_state["app_page"] = pending_page
        page = st.sidebar.radio(
            "Page",
            ["Jobs", "Applications", "Gap analytics", "Add Job", "Profile", "Settings"],
            key="app_page",
            label_visibility="collapsed",
        )
        if page == "Profile":
            key = (url, user_id, "Profile")
            revision = supabase_data_revision()
            if page_data(key, revision, load_profile_context, client, user_id) is PENDING:
                st.title("Profile")
                loading_notice(key, revision)
                return
            render_profile(client, user_id=user_id)
            return
        if page == "Gap analytics":
            key = (url, user_id, "Gap analytics")
            revision = (supabase_data_revision(), supabase_card_revision())
            if page_data(key, revision, _load_gap_analytics_data_cached, client, user_id, url, revision) is PENDING:
                st.title("Gap analytics")
                loading_notice(key, revision)
                return
            render_gap_analytics_page(client, user_id=user_id)
            return
        if page == "Add Job":
            try:
                key = (url, user_id, "Add Job")
                revision = supabase_data_revision()
                manual_context = page_data(key, revision, load_manual_job_context, client, user_id=user_id)
                if manual_context is PENDING:
                    st.title("Add a job manually")
                    loading_notice(key, revision)
                    return
                cv_version_id, active_profile_id = manual_context
            except PersistenceError:
                st.error("The active CV and CandidateProfile could not be loaded.")
                st.stop()
            _app_styles()
            render_add_job(
                client, user_id=user_id, cv_version_id=cv_version_id,
                active_profile_id=active_profile_id,
            )
            return
        if page == "Settings":
            render_settings(
                user_id=user_id,
                jobs=get_dashboard_jobs_snapshot(user_id),
            )
            return
        page_info = None
        summary_enabled = bounded_dashboard_enabled(_dashboard_summary_activation_setting())
        if page in {"Jobs", "Applications"} and summary_enabled:
            from ui.dashboard import _initialize_dashboard_status

            if "dashboard_section" not in st.session_state:
                st.session_state["dashboard_section"] = "Jobs"
            section = st.session_state.get("dashboard_section", "Jobs")
            if page == "Jobs" and section == "Jobs":
                _initialize_dashboard_status()
                dashboard_status = st.session_state.get("dashboard_status", "Needs attention")
                filters = {
                    "view": "Needs attention" if dashboard_status == "Ready to rate" else dashboard_status,
                    "score_state": "Ready to rate" if dashboard_status == "Ready to rate" else "All",
                    "search": st.session_state.get("dashboard_search", ""),
                    "archive_category": st.session_state.get("archive_category_filter", "All"),
                    "work_model": st.session_state.get("dashboard_work_model_filter", "All"),
                    "page": st.session_state.get("dashboard_page", 1),
                    "failed_fingerprints": dict(st.session_state.get("fit_failed_fingerprints", {})),
                }
            elif page == "Jobs":
                filters = {
                    "view": "Archive", "score_state": "All",
                    "search": st.session_state.get("archive_search", ""),
                    "archive_category": st.session_state.get("archive_category_filter", "All"),
                    "work_model": "All", "page": st.session_state.get("archive_page", 1),
                    "failed_fingerprints": dict(st.session_state.get("fit_failed_fingerprints", {})),
                }
            else:
                stage = st.session_state.get("application_stage_filter", "Active")
                app_view = {
                    "Active": "Active applications", "All applications": "Applications",
                    "Applied": "Applied", "Interview": "Interview", "Offer": "Offer", "Closed": "Closed",
                }.get(stage, "Active applications")
                filters = {
                    "view": app_view, "score_state": "All",
                    "search": st.session_state.get("applications_search", ""),
                    "archive_category": "All", "work_model": "All",
                    "page": st.session_state.get("applications_page", 1),
                    "failed_fingerprints": dict(st.session_state.get("fit_failed_fingerprints", {})),
                }
            filters["pending_page"] = st.session_state.get("dashboard_summary_pending_page", 1)
            signature = tuple((key, str(value)) for key, value in sorted(filters.items())
                              if key not in {"page", "pending_page", "failed_fingerprints"})
            signature_key = f"dashboard_server_page_signature_{page}_{section}"
            if st.session_state.get(signature_key) != signature:
                st.session_state[signature_key] = signature
                page_key = "archive_page" if page == "Jobs" and section == "Archive" else (
                    "applications_page" if page == "Applications" else "dashboard_page"
                )
                st.session_state[page_key] = 1
                filters["page"] = 1
            # Fail closed: when explicitly enabled, RPC errors are shown; there
            # is no silent fallback to loading all historical rows.
            page_info = fetch_dashboard_page(client, user_id=user_id, filters=filters)
            jobs = page_info.jobs
            active_profile_id = page_info.active_profile_id
            cv_version_id = page_info.cv_version_id
            storage_bucket = page_info.storage_bucket
            st.session_state["dashboard_summary_pending_count"] = page_info.pending_count
            st.session_state["dashboard_summary_pending_duplicate_count"] = page_info.pending_duplicate_count
        else:
            context = get_dashboard_context_snapshot(user_id) if page in {"Jobs", "Applications"} else None
            if context is None:
                key = (url, user_id, "Positions")
                revision = (supabase_data_revision(), supabase_card_revision())
                context = page_data(
                    key, revision, load_positions, client, user_id,
                    dict(st.session_state.get("fit_failed_fingerprints", {})),
                    cache_window=int(time.time() // 30),
                )
                if context is PENDING:
                    st.title("PairRole" if page == "Jobs" else "Applications")
                    loading_notice(key, revision)
                    return
                context, flags, change_cursor = context
                st.session_state.update(flags)
                _reconcile_dashboard_overrides(user_id, {job.id for job in context[0]})
                save_dashboard_context_snapshot(user_id, context, change_cursor=change_cursor)
            jobs, active_profile_id, user_id, cv_version_id, storage_bucket = context
    except PersistenceError as exc:
        if "AI_JOB_SEARCH_USER_ID" in str(exc):
            st.error(str(exc))
            st.stop()
        st.error("The Jobs dashboard could not load its server-side data.")
        st.stop()
    _app_styles()
    if page == "Jobs":
        render_dashboard(jobs, active_profile_id, client, user_id=user_id, cv_version_id=cv_version_id, storage_bucket=storage_bucket, page_info=page_info)
    elif page == "Applications":
        render_applications(jobs, active_profile_id, client, user_id=user_id, cv_version_id=cv_version_id, storage_bucket=storage_bucket, page_info=page_info)


_MANUAL_JOB_FORM_KEYS = (
    "manual_job_jd",
    "manual_job_title",
    "manual_job_company",
    "manual_job_listing_url",
)


def _clear_manual_job_form() -> None:
    for key in _MANUAL_JOB_FORM_KEYS:
        st.session_state[key] = ""
    st.session_state.pop("manual_job_added_result", None)


def _render_added_job_result(user_id: str, result: dict) -> None:
    st.success(f"Job added · AI Fit {result['fit_score']}")
    if st.button("View job in Jobs", key="view-added-manual-job", type="primary"):
        from ui.dashboard import refresh_dashboard_data

        refresh_dashboard_data(user_id)
        st.session_state["_pending_app_page"] = "Jobs"
        st.session_state["dashboard_status"] = "All"
        st.session_state["dashboard_status_initialized"] = True
        st.session_state["dashboard_fit_state"] = "All"
        st.session_state["dashboard_search"] = f"{result['company']} {result['title']}"
        st.session_state.pop("manual_job_added_result", None)
        st.rerun()
    st.button("Dismiss", key="dismiss-added-manual-job", on_click=_clear_manual_job_form)


@st.fragment
def render_add_job(client: SupabaseRestClient, *, user_id: str, cv_version_id: int, active_profile_id: int | None) -> None:
    from ui.manual_jd import ManualJDValidationError

    result = st.session_state.get("manual_job_added_result")
    if result and result.get("user_id") == user_id:
        st.title("Add a job manually")
        _render_added_job_result(user_id, result)
        return

    st.title("Add a job manually")
    st.caption("Paste a job description and it will be added to your job board and rated against your current profile.")
    if active_profile_id is None:
        st.info("No active CandidateProfile is available for rating.")
    with st.form("add-manual-job"):
        jd = st.text_area("Job description *", height=360, placeholder="Paste the complete job description here…", key="manual_job_jd")
        title = st.text_input("Job title *", key="manual_job_title")
        company = st.text_input("Company *", key="manual_job_company")
        listing_url = st.text_input("Listing URL *", placeholder="https://...", key="manual_job_listing_url")
        submitted = st.form_submit_button("Add & Rate", type="primary", disabled=active_profile_id is None)
        dismissed = st.form_submit_button("Dismiss", on_click=_clear_manual_job_form)
    if dismissed:
        return
    if not submitted:
        return
    if active_profile_id is None:
        st.error("No active CandidateProfile is available for rating.")
        return
    missing_fields = [
        label for label, value in (
            ("job description", jd),
            ("job title", title),
            ("company", company),
            ("listing URL", listing_url),
        ) if not value.strip()
    ]
    if missing_fields:
        st.error("Complete all required fields: " + ", ".join(missing_fields) + ".")
        return
    try:
        with st.spinner("Adding and rating job…"):
            result = create_and_rate_manual_job(
                client,
                user_id=user_id,
                cv_version_id=cv_version_id,
                candidate_profile_id=active_profile_id,
                jd_text=jd,
                title=title,
                company=company,
                listing_url=listing_url,
            )
    except (ManualJDValidationError, ValueError) as exc:
        st.error(str(exc))
        return
    except Exception as exc:
        st.error(str(exc))
        return
    score = result["rating"].get("fit_score")
    st.session_state["manual_job_added_result"] = {
        "user_id": user_id,
        "job_id": int(result["job"]["id"]),
        "title": result["job"].get("title") or title,
        "company": result["job"].get("company") or company,
        "fit_score": score,
    }
    _render_added_job_result(user_id, st.session_state["manual_job_added_result"])


if __name__ == "__main__":
    main()
