"""Read-only Jobs dashboard data loading and rendering."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, is_dataclass, replace
from html import escape
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from typing import Any, Callable
from urllib.parse import urlencode, urlparse

import streamlit as st

from matching.candidate_profile_persistence import (
    PersistenceError,
    SupabaseRestClient,
    invalidate_supabase_read_cache,
    supabase_data_revision,
    supabase_card_revision,
)
from matching.candidate_profile import CandidateProfile
from matching.application_lifecycle import (
    ALLOWED_TRANSITIONS,
    can_archive_state,
    can_apply_state,
    lifecycle_state,
    workflow_timestamp_column,
)
from matching.holistic_matcher import (
    DEFAULT_MODEL, VerifiedJob, candidate_projection_sha256, evaluation_fingerprint,
)
from matching.job_metadata_overrides import (
    MetadataField,
    load_job_metadata_overrides,
    reset_job_metadata_override,
    resolve_effective_job_metadata,
    save_job_metadata_override,
)
from matching.job_description import classify_job_description
from matching.job_eligibility import assess_discovered_job
from .manual_jd import (
    ManualEmploymentTypeDecisionRequired,
    ManualJDOperationError,
    ManualJDValidationError,
    manual_jd_sha256,
    normalize_manual_jd,
    rate_job_with_manual_jd,
)
from .preference_override import load_preference_overrides, remove_preference_override, save_preference_override
from .dashboard_data import (
    DashboardJob,
    application_view_jobs,
    can_rate_job,
    can_select_job,
    can_archive_job,
    can_retry_pending_evidence,
    can_generate_cv,
    can_rerate_job,
    filter_dashboard_jobs,
    group_application_jobs,
    group_archive_jobs,
    group_dashboard_jobs,
    group_needs_attention_jobs,
    job_pdf_filename,
    merge_dashboard_rows,
    paginate_job_groups,
    pending_category,
    pending_reason,
    sort_dashboard_jobs,
)
from .interview_prep import render_interview_prep
from matching.tailored_cv import TailoredCVError, generate_or_reuse_tailored_cv
from matching.tailored_cv_expiration import (
    clear_tailored_expiration_for_job,
    run_archived_cv_cleanup_for_job,
)
from matching.gap_generalization import (
    CandidateProfileOption,
    GapAssessment,
    analyze_unmapped_gaps,
    calculate_gap_analytics,
    load_candidate_profile_options,
    load_gap_assessments,
    load_mappings as load_gap_mappings,
)
from matching.gap_recommendations import (
    GAP_IMPROVEMENT_VERSION,
    candidate_improvement_evidence,
    recommend_gap_improvement_plans,
)


MATCHER_VERSION = "holistic_fit_v1"
MAX_PENDING_RETRY_BATCH = 25
RATE_BATCH_SIZE = 5
_ARCHIVE_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="job-archive")
_CV_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tailored-cv")
_CHANGE_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="change-check")
_CONTEXT_READ_EXECUTOR = ThreadPoolExecutor(max_workers=6, thread_name_prefix="dashboard-read")
_PREFERENCE_OVERRIDE_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="listing-preference")


@st.cache_data(ttl=30, max_entries=128, show_spinner=False)
def _download_tailored_pdf_cached(
    _client: SupabaseRestClient, bucket: str, path: str, user_id: str
) -> bytes:
    """Reuse recently rendered card artifacts instead of rereading Storage per rerun."""
    if not path.startswith(f"{user_id}/tailored/"):
        raise PersistenceError("The tailored CV path is outside the current user's storage scope.")
    return _client.download_storage_object(bucket, path)


@st.cache_data(max_entries=16, show_spinner=False)
def _load_gap_analytics_data_cached(
    _client: SupabaseRestClient, user_id: str, project_url: str, data_revision: int | tuple[int, int]
) -> tuple[list[Any], list[Any], list[dict[str, Any]]]:
    profiles = load_candidate_profile_options(_client, user_id=user_id)
    selected_ids = sorted({profile.id for profile in profiles})
    labels = {profile.id: profile.label for profile in profiles}
    if not selected_ids:
        return profiles, [], []
    jobs = load_gap_assessments(
        _client, user_id=user_id, candidate_profile_ids=selected_ids, profile_labels=labels
    )
    mappings = load_gap_mappings(_client, user_id=user_id, candidate_profile_ids=selected_ids)
    return profiles, jobs, mappings


def run_pending_evidence_retry(job_ids: list[int], *, user_id: str) -> dict[str, Any]:
    """Run the existing bounded verifier/hydrator only after an explicit action."""
    ids = list(dict.fromkeys(int(job_id) for job_id in job_ids))
    if not ids or len(ids) > MAX_PENDING_RETRY_BATCH or any(job_id <= 0 for job_id in ids):
        raise ValueError(f"Choose between 1 and {MAX_PENDING_RETRY_BATCH} eligible jobs.")
    root = Path(__file__).resolve().parents[1]
    script = root / "tools" / "process_pending_job_evidence.ts"
    bun_candidates = [
        root / ".agents/skills/jobnet-search/cli/node_modules/.bin/bun",
        Path(shutil.which("bun")) if shutil.which("bun") else None,
    ]
    bun = next((path for path in bun_candidates if path is not None and path.exists()), None)
    if bun is None:
        raise RuntimeError("The local Bun runtime is unavailable for verification retries.")
    environment = os.environ.copy()
    environment["AI_JOB_SEARCH_USER_ID"] = user_id
    completed = subprocess.run(
        [str(bun), str(script), "--ids", ",".join(map(str, ids)), "--user-id", user_id],
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr or ""
        missing = re.search(r"Selected job IDs were not found: ([\d, ]+)", detail)
        if missing:
            raise RuntimeError(f"Selected jobs were not found: {missing.group(1).strip()}. Refresh the dashboard and retry.")
        if "manual listing owned by another user" in detail:
            raise RuntimeError("The selection includes a manual listing owned by another user.")
        raise RuntimeError("The verification/evidence workflow could not complete. Check the local discovery log for details.")
    try:
        result = json.loads(completed.stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("The verification workflow returned an invalid result.") from exc
    if not isinstance(result, dict) or not isinstance(result.get("jobs"), list):
        raise RuntimeError("The verification workflow returned an incomplete result.")
    return result


def pending_retry_cohorts(jobs: list[DashboardJob], attempted_ids: set[int] | None = None) -> tuple[list[DashboardJob], list[DashboardJob]]:
    """Split only the already-filtered, unresolved visible cohort for safe retries."""
    attempted = attempted_ids or set()
    retryable = [job for job in jobs if can_retry_pending_evidence(job) and job.id not in attempted]
    verification = [job for job in retryable if job.pending_category == "Verification needed"]
    evidence = [job for job in retryable if job.pending_category != "Verification needed"]
    return verification, evidence


def _select_section_jobs(job_ids: list[int], state_key: str) -> None:
    selected = bool(st.session_state.get(state_key))
    for job_id in job_ids:
        st.session_state[f"archive-select-{job_id}"] = selected


def _sync_section_selection(job_ids: list[int], state_key: str) -> None:
    st.session_state[state_key] = all(
        bool(st.session_state.get(f"archive-select-{job_id}", False)) for job_id in job_ids
    )


def _mark_dashboard_status_selected() -> None:
    st.session_state["dashboard_status_initialized"] = True


def _initialize_dashboard_status() -> None:
    # Default to the review queue while preserving the user's Show choice.
    if st.session_state.get("dashboard_status") not in {"Needs attention", "Ready to rate", "Rated"}:
        st.session_state["dashboard_status"] = "Needs attention"
    st.session_state["dashboard_status_initialized"] = True


def _post_it_styles() -> None:
    st.markdown(
        """
        <style>
        .stApp {
            background: #0f1117;
            color: #f3f4f6;
        }
        .block-container {
            max-width: 1440px;
            padding-top: 1.4rem;
            padding-bottom: 2.5rem;
        }
        h1, h2, h3, p, label, [data-testid="stCaptionContainer"] {
            color: #f3f4f6;
        }
        h1 {
            letter-spacing: -0.02em;
            margin-bottom: 0.35rem;
        }
        @keyframes dashboardNoticeDrop {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .st-key-batch-refresh-notice {
            background: #202431;
            border: 1px solid #343a4a;
            border-left: 3px solid #6c5ce7;
            border-radius: 10px;
            padding: 0.4rem 0.65rem;
            animation: dashboardNoticeDrop 220ms ease-out;
        }
        .st-key-batch-refresh-notice [data-testid="stCaptionContainer"] {
            margin: 0;
        }
        hr {
            border-color: #2b3040;
        }
        [data-testid="stTextInput"] input,
        [data-testid="stSelectbox"] [data-baseweb="select"] > div,
        [data-testid="stTextArea"] textarea {
            background: #181b24;
            border: 1px solid #2b3040;
            border-radius: 8px;
            color: #f3f4f6;
        }
        [data-testid="stTextInput"] input::placeholder,
        [data-testid="stTextArea"] textarea::placeholder {
            color: #727b8c;
            opacity: 1;
        }
        [data-testid="stSelectbox"] [data-baseweb="select"] svg {
            color: #a8afbd;
        }
        [data-baseweb="popover"] {
            background: #181b24;
            border: 1px solid #2b3040;
        }
        [role="option"] {
            background: #181b24;
            color: #f3f4f6;
        }
        [role="option"]:hover {
            background: #202431;
        }
        div[data-testid="stVerticalBlockBorderWrapper"] {
            background: #181b24;
            border: 1px solid #2b3040;
            border-radius: 8px;
            min-height: 0;
            padding: 0.35rem;
            box-shadow: 0 3px 12px rgba(0, 0, 0, 0.16);
            transition: background 120ms ease, border-color 120ms ease;
        }
        div[data-testid="stVerticalBlockBorderWrapper"]:hover {
            background: #1b1f29;
            border-color: #454c5d;
        }
        div[data-testid="stVerticalBlockBorderWrapper"] h3 {
            font-size: 1.22rem;
            line-height: 1.3;
            margin: 0.15rem 0 0.2rem;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }
        .fit-badge {
            background: #6257e5;
            border-radius: 9px;
            color: white;
            min-width: 66px;
            padding: 0.35rem 0.45rem 0.4rem;
            text-align: center;
        }
        .fit-badge-label {
            display: block;
            font-size: 0.62rem;
            font-weight: 700;
            letter-spacing: 0.08em;
            opacity: 0.9;
        }
        .fit-badge-score {
            display: block;
            font-size: 1.85rem;
            font-weight: 800;
            line-height: 1.05;
        }
        .fit-badge-muted {
            background: #242936;
            color: #a8afbd;
            font-size: 0.68rem;
            letter-spacing: 0.04em;
            padding: 0.85rem 0.35rem;
        }
        .job-meta {
            color: #b6bdca;
            font-size: 0.86rem;
            line-height: 1.55;
            padding: 0.3rem 0 0.7rem;
        }
        .job-company {
            color: #e1e5ed;
            font-size: 0.95rem;
            font-weight: 600;
            margin-bottom: 0.4rem;
        }
        div[data-testid="stVerticalBlockBorderWrapper"] [data-testid="stMarkdownContainer"] {
            font-size: 0.91rem;
            line-height: 1.55;
        }
        div[data-testid="stVerticalBlockBorderWrapper"] [data-testid="stMarkdownContainer"] ul {
            padding-left: 1.15rem;
            margin-top: 0.25rem;
            margin-bottom: 0.65rem;
        }
        div[data-testid="stVerticalBlockBorderWrapper"] [data-testid="stMarkdownContainer"] li {
            padding-left: 0.12rem;
            margin-bottom: 0.28rem;
        }
        .fit-reasons-label {
            color: #8f98aa;
            font-size: 0.64rem;
            font-weight: 700;
            letter-spacing: 0.08em;
            margin-top: 0.35rem;
        }
        .job-status {
            background: rgba(108, 92, 231, 0.15);
            border-radius: 999px;
            color: #afa7ff;
            display: inline-block;
            font-size: 0.68rem;
            font-weight: 700;
            letter-spacing: 0.08em;
            padding: 0.18rem 0.45rem;
        }
        .gap-item-meter {
            background: #2b3040;
            border-radius: 4px;
            height: 5px;
            margin: 0.7rem 0 0.65rem;
            overflow: hidden;
        }
        .gap-item-meter-fill {
            background: #6c5ce7;
            height: 100%;
        }
        .stLinkButton a {
            background: #2d6cdf !important;
            border: 1px solid #5c91f0 !important;
            color: #ffffff !important;
            min-height: 1.95rem;
            padding: 0.2rem 0.65rem;
            font-size: 0.76rem;
            font-weight: 650;
        }
        .stLinkButton a:hover {
            background: #4380ef !important;
            border-color: #8ab0ff !important;
        }
        .stButton button:not([data-testid="stBaseButton-tertiary"]) {
            background: #343d50 !important;
            border: 1px solid #66748d !important;
            color: #ffffff !important;
            min-height: 2.35rem;
            padding: 0.4rem 0.8rem;
            font-size: 0.8rem;
            font-weight: 650;
            box-shadow: 0 2px 5px rgba(0, 0, 0, 0.28);
            transition: background 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
        }
        .stButton button:not([data-testid="stBaseButton-tertiary"]):hover {
            background: #46536b !important;
            border-color: #95a4bd !important;
            color: #ffffff !important;
            box-shadow: 0 3px 9px rgba(0, 0, 0, 0.35);
            transform: translateY(-1px);
        }
        .stButton button:focus-visible,
        .stLinkButton a:focus-visible {
            outline: 2px solid #9b91ff;
            outline-offset: 2px;
        }
        .stButton button:disabled {
            background: #252a35 !important;
            border-color: #414958 !important;
            color: #8992a2 !important;
            box-shadow: none;
            transform: none;
            opacity: 1;
        }
        .stButton button[data-testid="stBaseButton-primary"] {
            background: #6257e5 !important;
            border-color: #a49cff !important;
            color: #ffffff !important;
            box-shadow: 0 2px 8px rgba(98, 87, 229, 0.32);
        }
        .stButton button[data-testid="stBaseButton-primary"]:hover {
            background: #766bf0 !important;
            border-color: #c0baff !important;
        }
        div[data-testid="stVerticalBlockBorderWrapper"] [class*="st-key-lifecycle-interview-"] button,
        div[data-testid="stVerticalBlockBorderWrapper"] [class*="st-key-lifecycle-offer-"] button,
        div[data-testid="stVerticalBlockBorderWrapper"] [class*="st-key-lifecycle-hired-"] button {
            background: #1d5961 !important;
            border-color: #4a9aa0 !important;
            color: #ffffff !important;
        }
        div[data-testid="stVerticalBlockBorderWrapper"] [class*="st-key-lifecycle-interview-"] button:hover,
        div[data-testid="stVerticalBlockBorderWrapper"] [class*="st-key-lifecycle-offer-"] button:hover,
        div[data-testid="stVerticalBlockBorderWrapper"] [class*="st-key-lifecycle-hired-"] button:hover {
            background: #28737a !important;
            border-color: #73c1c0 !important;
        }
        div[data-testid="stVerticalBlockBorderWrapper"] [class*="st-key-lifecycle-rejected-"] button,
        div[data-testid="stVerticalBlockBorderWrapper"] [class*="st-key-lifecycle-withdrawn-"] button {
            background: #303440 !important;
            border-color: #626a7a !important;
            color: #e1e4eb !important;
        }
        div[data-testid="stVerticalBlockBorderWrapper"] [class*="st-key-lifecycle-rejected-"] button:hover,
        div[data-testid="stVerticalBlockBorderWrapper"] [class*="st-key-lifecycle-withdrawn-"] button:hover {
            background: #424857 !important;
            border-color: #8590a3 !important;
            color: #ffffff !important;
        }
        div[class*="st-key-archive-action"] .stButton button:not([data-testid="stBaseButton-tertiary"]) {
            background: #55452b !important;
            border-color: #9a7841 !important;
            color: #fff2d6 !important;
        }
        div[class*="st-key-archive-action"] .stButton button:not([data-testid="stBaseButton-tertiary"]):hover {
            background: #6b5533 !important;
            border-color: #c39a53 !important;
            color: #ffffff !important;
        }
        .stButton [data-testid="stBaseButton-tertiary"] {
            background: transparent !important;
            border: 0 !important;
            box-shadow: none !important;
            color: #a8afbd !important;
            min-height: 1.8rem !important;
            width: 1.8rem !important;
            padding: 0 !important;
        }
        .stButton [data-testid="stBaseButton-tertiary"] [data-testid="stIconMaterial"] {
            font-size: 1.15rem !important;
            visibility: visible !important;
        }
        .stButton [data-testid="stBaseButton-tertiary"]:hover {
            background: #242936 !important;
            color: #f3f4f6 !important;
        }
        .stButton button, .stLinkButton a {
            border-radius: 8px;
        }
        .st-key-archive-pagination [data-testid="stCaptionContainer"] {
            text-align: center;
            margin-bottom: 0.35rem;
        }
        .st-key-archive-pagination [data-testid="stHorizontalBlock"] {
            justify-content: center;
            align-items: center;
            flex-wrap: wrap;
            gap: 0.35rem;
        }
        .st-key-archive-pagination [data-testid="column"] {
            flex: 0 0 auto !important;
            min-width: 2.55rem;
            width: auto !important;
        }
        .st-key-archive-pagination .stButton button {
            min-width: 2.55rem;
            min-height: 2.35rem;
            padding: 0.35rem 0.65rem;
        }
        @media (max-width: 640px) {
            .st-key-archive-pagination [data-testid="stHorizontalBlock"] {
                row-gap: 0.25rem;
            }
            .st-key-archive-pagination .stButton button {
                min-width: 2.25rem;
                padding-inline: 0.45rem;
            }
        }
        .diff-link {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 1.8rem;
            height: 1.8rem;
            border: 1px solid #343a4a;
            border-radius: 8px;
            color: #d6d9e0;
            text-decoration: none;
            background: #242936;
            font-size: 1rem;
        }
        .diff-link:hover {
            background: #303746;
            color: #ffffff;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


def _get_rows(client: SupabaseRestClient, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    rows = client.get_json(f"/rest/v1/{table}?{urlencode(params)}")
    if not isinstance(rows, list):
        raise PersistenceError(f"Supabase returned invalid {table} data.")
    return rows


def _get_all_job_rows(client: SupabaseRestClient, params: dict[str, str]) -> list[dict[str, Any]]:
    """Page through all visible jobs instead of silently stopping at PostgREST's row cap."""
    page_size = 500
    rows: list[dict[str, Any]] = []
    last_id = 0
    while True:
        page_params = {**params, "id": f"gt.{last_id}", "order": "id.asc", "limit": str(page_size)}
        page = _get_rows(client, "jobs", page_params)
        for row in page:
            try:
                job_id = int(row["id"])
            except (KeyError, TypeError, ValueError) as exc:
                raise PersistenceError("Supabase returned an invalid job ID while loading the dashboard.") from exc
            if job_id <= last_id:
                raise PersistenceError("Supabase returned unordered jobs while loading the dashboard.")
            last_id = job_id
            rows.append(row)
        if len(page) < page_size:
            return rows


def _get_all_assessment_rows(client: SupabaseRestClient, params: dict[str, str]) -> list[dict[str, Any]]:
    """Read all score-cache generations for this user, including inactive CV profiles."""
    page_size = 500
    rows: list[dict[str, Any]] = []
    last_id = 0
    while True:
        page_params = {**params, "id": f"gt.{last_id}", "order": "id.asc", "limit": str(page_size)}
        page = _get_rows(client, "job_match_assessments", page_params)
        for row in page:
            try:
                assessment_id = int(row["id"])
            except (KeyError, TypeError, ValueError) as exc:
                raise PersistenceError("Supabase returned an invalid Fit assessment ID.") from exc
            if assessment_id <= last_id:
                raise PersistenceError("Supabase returned unordered Fit assessments.")
            last_id = assessment_id
            rows.append(row)
        if len(page) < page_size:
            return rows


@st.cache_data(max_entries=32, show_spinner=False)
def _load_dashboard_context_cached(
    _client: SupabaseRestClient,
    user_id: str | None,
    project_url: str,
    data_revision: int | tuple[int, int],
) -> tuple[list[dict[str, Any]], int | None, str, int, str]:
    """Keep the read model until an explicit/local-write revision invalidates it."""
    context = _load_dashboard_context_uncached(_client, user_id)
    return ([_cache_plain_data(job) for job in context[0]], *context[1:])


def load_dashboard_context(client: SupabaseRestClient, user_id: str | None = None) -> tuple[list[DashboardJob], int | None, str, int, str]:
    """Load the per-user read model until a local write or explicit refresh invalidates it."""
    context = _load_dashboard_context_cached(
        client,
        user_id,
        client.base_url,
        (supabase_data_revision(), supabase_card_revision()),
    )
    jobs = [
        _dashboard_job_from_cache(job) if isinstance(job, dict) else job
        for job in context[0]
    ]
    context = (jobs, *context[1:])
    if user_id:
        overrides = st.session_state.get("dashboard_lifecycle_overrides", {}).get(user_id, {})
        if overrides:
            jobs = [
                replace(job, **_dashboard_job_overrides(user_id, job.id, job=job))
                for job in context[0]
            ]
            return (jobs, *context[1:])
    return context


def _dashboard_job_from_cache(value: dict[str, Any]) -> DashboardJob:
    tuple_fields = (
        "source_metadata_quality_issues",
        "fit_strengths",
        "fit_gaps",
        "metadata_quality_issues",
        "preference_override_fields",
    )
    payload = dict(value)
    for field in tuple_fields:
        if field in payload:
            payload[field] = tuple(payload[field] or ())
    return DashboardJob(**payload)


def get_dashboard_jobs_snapshot(user_id: str) -> list[DashboardJob] | None:
    """Return jobs already loaded during this Streamlit session, if available."""
    snapshots = st.session_state.get("dashboard_jobs_snapshot_by_user", {})
    return snapshots.get(user_id)


def get_dashboard_context_snapshot(user_id: str) -> tuple[list[DashboardJob], int | None, str, int, str] | None:
    snapshots = st.session_state.get("dashboard_context_snapshot_by_user", {})
    context = snapshots.get(user_id)
    revisions = st.session_state.setdefault("dashboard_context_revision_by_user", {})
    if context is not None:
        saved_revision = revisions.setdefault(user_id, supabase_data_revision())
        if saved_revision != supabase_data_revision():
            return None
    return context


def save_dashboard_context_snapshot(
    user_id: str,
    context: tuple[list[DashboardJob], int | None, str, int, str],
    *,
    change_cursor: str | None = None,
) -> None:
    st.session_state.setdefault("dashboard_context_snapshot_by_user", {})[user_id] = context
    st.session_state.setdefault("dashboard_jobs_snapshot_by_user", {})[user_id] = context[0]
    st.session_state.setdefault("dashboard_context_revision_by_user", {})[user_id] = supabase_data_revision()
    st.session_state.setdefault("dashboard_change_cursor_by_user", {})[user_id] = (
        change_cursor or (datetime.now(timezone.utc) - timedelta(seconds=2)).isoformat()
    )


def save_dashboard_jobs_snapshot(user_id: str, jobs: list[DashboardJob]) -> None:
    st.session_state.setdefault("dashboard_jobs_snapshot_by_user", {})[user_id] = jobs


_FIT_OVERRIDE_FIELDS = {
    "fit_score", "fit_assessment_id", "fit_fingerprint", "fit_strengths", "fit_gaps", "fit_attempt_failed",
    "description", "description_kind",
}


def _without_fit_override(fields: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if key not in _FIT_OVERRIDE_FIELDS
            and not (key == "review_status" and value == "rated")}


def _record_dashboard_lifecycle_override(user_id: str, job_id: int, **fields: Any) -> None:
    """Keep a just-updated user's card responsive without reloading every job row."""
    try:
        expected = fields.pop("_expected_fit_fingerprint", fields.get("fit_fingerprint"))
        expected_profile = fields.pop("_expected_profile_id", None)
        context = st.session_state.get("dashboard_context_snapshot_by_user", {}).get(user_id)
        if expected_profile is not None and context is not None and context[1] != expected_profile:
            return
        jobs = st.session_state.get("dashboard_jobs_snapshot_by_user", {}).get(user_id)
        current = next((job for job in (jobs or []) if job.id == job_id), None)
        if ("fit_score" in fields or "fit_attempt_failed" in fields) and (
            not fields.get("fit_fingerprint")
            or (current is not None and current.fit_fingerprint not in {expected, fields["fit_fingerprint"]})
        ):
            fields = _without_fit_override(fields)
        all_overrides = st.session_state.setdefault("dashboard_lifecycle_overrides", {})
        user_overrides = all_overrides.setdefault(user_id, {})
        previous = user_overrides.get(job_id, {})
        user_overrides[job_id] = {**previous, **fields}
        snapshots = st.session_state.get("dashboard_jobs_snapshot_by_user", {})
        jobs = snapshots.get(user_id)
        if jobs is not None:
            updated_jobs = [
                replace(job, **fields) if int(job.id) == job_id else job
                for job in jobs
            ]
            snapshots[user_id] = updated_jobs
            contexts = st.session_state.get("dashboard_context_snapshot_by_user", {})
            context = contexts.get(user_id)
            if context is not None:
                contexts[user_id] = (updated_jobs, *context[1:])
    except Exception:
        # Lifecycle persistence remains authoritative outside an active UI session.
        return


def _dashboard_job_overrides(user_id: str, job_id: int, *, job: DashboardJob | None = None) -> dict[str, Any]:
    overrides = st.session_state.get("dashboard_lifecycle_overrides", {}).get(user_id, {})
    fields = dict(overrides.get(job_id, {}))
    if job is not None and ("fit_score" in fields or "fit_fingerprint" in fields or "fit_attempt_failed" in fields):
        if not fields.get("fit_fingerprint") or fields["fit_fingerprint"] != job.fit_fingerprint:
            fields = _without_fit_override(fields)
    return fields


def _reconcile_dashboard_overrides(user_id: str, job_ids: set[int]) -> None:
    """A successful authoritative read retires temporary updates for those rows."""
    overrides = st.session_state.get("dashboard_lifecycle_overrides", {}).get(user_id, {})
    pending = st.session_state.get("bulk_archive_task") or {}
    pending_ids = set(pending.get("job_ids", []))
    for job_id in job_ids:
        previous = overrides.pop(job_id, {})
        if job_id in pending_ids and previous.get("review_status") == "archived":
            overrides[job_id] = {"review_status": "archived"}


def refresh_dashboard_data(user_id: str) -> None:
    invalidate_supabase_read_cache()
    try:
        st.session_state.get("dashboard_lifecycle_overrides", {}).pop(user_id, None)
        st.session_state.get("dashboard_jobs_snapshot_by_user", {}).pop(user_id, None)
        st.session_state.get("dashboard_context_snapshot_by_user", {}).pop(user_id, None)
    except Exception:
        return


def _changed_job_ids_since(client: SupabaseRestClient, user_id: str, cursor: str, *, ui_state=None) -> tuple[set[int], bool]:
    """Read only changed-row keys; the boolean means profile context changed globally."""
    changed_ids: set[int] = set()
    state = st.session_state if ui_state is None else ui_state
    state["dashboard_jobs_timestamp_unavailable"] = False
    sources = (
        ("jobs", "updated_at", {}),
        ("applications", "updated_at", {"user_id": f"eq.{user_id}"}),
        ("job_reviews", "updated_at", {"user_id": f"eq.{user_id}"}),
        ("job_metadata_overrides", "updated_at", {"user_id": f"eq.{user_id}"}),
        ("user_job_verifications", "checked_at", {"user_id": f"eq.{user_id}"}),
        ("user_job_work_model_verifications", "verified_at", {"user_id": f"eq.{user_id}"}),
        ("user_job_location_verifications", "verified_at", {"user_id": f"eq.{user_id}"}),
        ("user_job_employment_type_verifications", "verified_at", {"user_id": f"eq.{user_id}"}),
        ("job_match_assessments", "created_at", {"user_id": f"eq.{user_id}", "matcher_version": f"eq.{MATCHER_VERSION}"}),
        ("cv_versions", "created_at", {"user_id": f"eq.{user_id}", "is_base": "eq.false"}),
        ("cv_versions", "artifacts_deleted_at", {"user_id": f"eq.{user_id}", "is_base": "eq.false"}),
    )
    for table, timestamp_column, filters in sources:
        job_column = "job_id:id" if table == "jobs" else "job_id"
        tie_breaker = "id" if table in {"jobs", "applications", "job_reviews", "job_match_assessments", "cv_versions"} else "job_id"
        offset = 0
        while True:
            try:
                rows = _get_rows(client, table, {
                    "select": f"{job_column},{timestamp_column}",
                    **filters,
                    timestamp_column: f"gt.{cursor}",
                    "order": f"{timestamp_column}.asc,{tie_breaker}.asc",
                    "limit": "500",
                    "offset": str(offset),
                })
            except PersistenceError as exc:
                message = str(exc)
                if table == "jobs" and "updated_at" in message and any(code in message for code in ("42703", "PGRST204")):
                    state["dashboard_jobs_timestamp_unavailable"] = True
                    break
                if table == "user_job_employment_type_verifications" and any(code in message.lower() for code in ("pgrst205", "42p01", "404")):
                    state["employment_type_verification_unavailable"] = True
                    break
                raise
            changed_ids.update(
                int(row["job_id"]) for row in rows
                if row.get("job_id") is not None and str(row["job_id"]).isdigit()
            )
            if len(rows) < 500:
                break
            offset += len(rows)

    profile_context_changed = bool(_get_rows(client, "search_profiles", {
        "select": "id", "user_id": f"eq.{user_id}", "updated_at": f"gt.{cursor}", "limit": "1",
    }))
    return changed_ids, profile_context_changed


def sync_dashboard_context(client: SupabaseRestClient, user_id: str) -> int:
    """Check change markers and merge only changed job cards into the session snapshot."""
    context = get_dashboard_context_snapshot(user_id)
    if context is None:
        context = load_dashboard_context(client, user_id)
        save_dashboard_context_snapshot(user_id, context)
        return len(context[0])

    cursor = st.session_state.get("dashboard_change_cursor_by_user", {}).get(user_id)
    if not cursor:
        save_dashboard_context_snapshot(user_id, context)
        return 0
    next_cursor = (datetime.now(timezone.utc) - timedelta(seconds=2)).isoformat()
    try:
        changed_ids, global_change = _changed_job_ids_since(client, user_id, cursor)
    except PersistenceError as exc:
        if "updated_at" in str(exc).lower():
            raise PersistenceError("Incremental refresh needs the jobs.updated_at migration applied first.") from exc
        raise

    active_cv = client.resolve_active_base_cv(user_id)
    profile_rows = client.list_profiles(user_id, active_cv.id)
    active_profiles = [row for row in profile_rows if row.get("is_active") is True]
    current_profile_id = int(active_profiles[0]["id"]) if len(active_profiles) == 1 else None
    global_change = global_change or current_profile_id != context[1] or active_cv.id != context[3]

    if global_change:
        refresh_dashboard_data(user_id)
        context = load_dashboard_context(client, user_id)
        save_dashboard_context_snapshot(user_id, context, change_cursor=next_cursor)
        return len(context[0])

    if changed_ids:
        delta = _load_dashboard_context_rows(client, user_id, job_ids=changed_ids)
        _reconcile_dashboard_overrides(user_id, changed_ids)
        delta_jobs = [
            replace(job, **_dashboard_job_overrides(user_id, job.id, job=job))
            for job in delta[0]
        ]
        by_id = {job.id: job for job in context[0]}
        changed_count = sum(by_id.get(job.id) != job for job in delta_jobs)
        by_id.update({job.id: job for job in delta_jobs})
        merged = sort_dashboard_jobs(by_id.values())
        context = (merged, *context[1:])
        save_dashboard_context_snapshot(user_id, context, change_cursor=next_cursor)
        return changed_count

    st.session_state.setdefault("dashboard_change_cursor_by_user", {})[user_id] = next_cursor
    return 0


def save_work_model_and_update_card(
    client: SupabaseRestClient, *, user_id: str, job: DashboardJob, work_model: str
) -> DashboardJob:
    """Save the fact and recompute this card without reloading dashboard data."""
    profiles = _get_rows(client, "search_profiles", {
        "select": "id,definition", "user_id": f"eq.{user_id}",
        "is_active": "eq.true", "limit": "2",
    })
    eligibility = assess_discovered_job(
        title=job.title, location=job.location, remote_scope=job.remote_scope,
        description=job.description, profile=profiles[0] if len(profiles) == 1 else None,
        manual=job.is_manual, employment_type=job.employment_type,
        description_kind=job.description_kind, verified_work_model=work_model,
    )
    fields = {"verified_work_model": work_model, "eligibility_reason": eligibility.reason}
    for name in ("role", "location", "work_model", "language", "employment_type", "seniority"):
        fields[f"{name}_eligibility"] = getattr(eligibility, name)
        fields[f"{name}_reason"] = getattr(eligibility, f"{name}_reason")
    save_manual_work_model(client, user_id=user_id, job_id=job.id, work_model=work_model)
    updated = replace(job, **fields, work_model_checked_at=datetime.now(timezone.utc).isoformat())
    jobs = get_dashboard_jobs_snapshot(user_id)
    if jobs is not None:
        rows = [updated if row.id == job.id else row for row in jobs]
        save_dashboard_jobs_snapshot(user_id, rows)
        contexts = st.session_state.get("dashboard_context_snapshot_by_user", {})
        if user_id in contexts:
            contexts[user_id] = (rows, *contexts[user_id][1:])
    return updated


def _load_dashboard_context_uncached(client: SupabaseRestClient, user_id: str | None = None) -> tuple[list[DashboardJob], int | None, str, int, str]:
    return _load_dashboard_context_rows(client, user_id)


def _load_optional_verifications(client, table: str, params: dict[str, str]) -> tuple[list[dict[str, Any]], bool]:
    try:
        return _get_rows(client, table, params), False
    except PersistenceError as exc:
        message = str(exc).lower()
        if table not in message or not any(code in message for code in ("pgrst205", "42p01", "404")):
            raise
        return [], True


def _load_current_assessments(client, params: dict[str, str]) -> list[dict[str, Any]]:
    # List decisions need identity, score and freshness, not assessment narratives.
    return _get_all_assessment_rows(
        client,
        {"select": "id,job_id,candidate_profile_id,fit_score,evaluation_fingerprint,created_at,matcher_version", **params},
    )


def _load_dashboard_profile_context(client, user_id):
    """Read profile inputs together; callers may reuse them for one DB revision."""
    cv = client.resolve_active_base_cv(user_id) if user_id else client.resolve_active_base_cv()
    profiles = client.list_profiles(cv.user_id, cv.id)
    active_profiles = [row for row in profiles if row.get("is_active") is True]
    active_profile_id = int(active_profiles[0]["id"]) if len(active_profiles) == 1 else None
    candidate_profile = (
        CandidateProfile.model_validate(active_profiles[0]["profile_json"])
        if active_profile_id is not None
        else None
    )
    search_profiles = _get_rows(
        client,
        "search_profiles",
        {"select": "id,definition", "user_id": f"eq.{cv.user_id}", "is_active": "eq.true", "limit": "2"},
    )
    search_profile = search_profiles[0] if len(search_profiles) == 1 else None

    return cv, active_profile_id, candidate_profile, search_profile


def _load_dashboard_context_rows(
    client: SupabaseRestClient,
    user_id: str | None = None,
    *,
    job_ids: set[int] | None = None,
    ui_state: dict[str, Any] | None = None,
    summary_only: bool = False,
    profile_cache: dict | None = None,
    profile_revision: int | None = None,
) -> tuple[list[DashboardJob], int | None, str, int, str]:
    """Load the current user's read-only dashboard context and rows."""

    state = st.session_state if ui_state is None else ui_state
    cache_key = (getattr(client, "base_url", ""), user_id, profile_revision)
    if profile_cache is not None and profile_revision is not None:
        if cache_key not in profile_cache:
            # Bound memory to the current revision of this rebuild run.
            profile_cache.clear()
            profile_cache[cache_key] = _load_dashboard_profile_context(client, user_id)
        cv, active_profile_id, candidate_profile, search_profile = profile_cache[cache_key]
    else:
        cv, active_profile_id, candidate_profile, search_profile = _load_dashboard_profile_context(client, user_id)

    job_filters = {
        "or": f"(manual_owner_user_id.is.null,manual_owner_user_id.eq.{cv.user_id})",
    }
    if job_ids is not None:
        if not job_ids:
            return [], active_profile_id, cv.user_id, cv.id, cv.storage_bucket
        job_filters["id"] = "in.(" + ",".join(str(value) for value in sorted(job_ids)) + ")"
    try:
        job_select = "id,source,company,title,location,remote_scope,employment_type,source_url,application_url,description,description_kind,availability_status,posted_at,first_seen_at,last_seen_at,updated_at,manual_owner_user_id"
        if job_ids is None:
            jobs = _get_all_job_rows(client, {"select": job_select, **job_filters})
        else:
            jobs = _get_rows(client, "jobs", {"select": job_select, **job_filters})
    except PersistenceError as exc:
        message = str(exc).lower()
        missing_column = False
        if "updated_at" in message:
            job_select = job_select.replace(",updated_at", "")
            missing_column = True
        if "employment_type" in message:
            job_select = job_select.replace("employment_type,", "")
            missing_column = True
        if not missing_column:
            raise
        if job_ids is None:
            jobs = _get_all_job_rows(client, {"select": job_select, **job_filters})
        else:
            jobs = _get_rows(client, "jobs", {"select": job_select, **job_filters})
    job_scope = (
        {"job_id": "in.(" + ",".join(str(value) for value in sorted(job_ids)) + ")"}
        if job_ids is not None else {}
    )
    scoped_user = {"user_id": f"eq.{cv.user_id}", **job_scope}
    read_futures = {
        "metadata": _CONTEXT_READ_EXECUTOR.submit(
            load_job_metadata_overrides, client, user_id=cv.user_id, job_ids=job_ids
        ),
        "preference_overrides": _CONTEXT_READ_EXECUTOR.submit(
            load_preference_overrides, client, user_id=cv.user_id,
            job_ids=(int(row["id"]) for row in jobs if row.get("id") is not None),
        ),
        **({} if summary_only else {"applications": _CONTEXT_READ_EXECUTOR.submit(_get_rows, client, "applications", {
            "select": "job_id,status,terminal_at,applied_at,interview_at,offer_at,hired_at,rejected_at,withdrawn_at,status_changed_at,updated_at,created_at",
            **scoped_user, "order": "updated_at.desc",
        })}),
        **({} if summary_only else {"reviews": _CONTEXT_READ_EXECUTOR.submit(_get_rows, client, "job_reviews", {
            "select": "job_id,status,updated_at,created_at", **scoped_user, "order": "updated_at.desc",
        })}),
        "user_verifications": _CONTEXT_READ_EXECUTOR.submit(_load_optional_verifications, client, "user_job_verifications", {
            "select": "job_id,verification_status,verification_reason,checked_at", **scoped_user,
        }),
        "location_verifications": _CONTEXT_READ_EXECUTOR.submit(_load_optional_verifications, client, "user_job_location_verifications", {
            "select": "job_id,location_status,verified_at", **scoped_user,
        }),
        "employment_type_verifications": _CONTEXT_READ_EXECUTOR.submit(_load_optional_verifications, client, "user_job_employment_type_verifications", {
            "select": "job_id,employment_type,decision,jd_sha256,verified_at", **scoped_user,
        }),
        **({} if summary_only else {"tailored_versions": _CONTEXT_READ_EXECUTOR.submit(_get_rows, client, "cv_versions", {
            "select": "id,job_id,storage_bucket,file_path,pdf_file_path,tex_file_path,tailoring_fingerprint,created_at,expires_at,artifacts_deleted_at",
            "user_id": f"eq.{cv.user_id}", "is_base": "eq.false",
            "source_cv_version_id": f"eq.{cv.id}", "order": "created_at.desc", **job_scope,
        })}),
    }
    assessment_future = None
    if active_profile_id is not None and not summary_only:
        assessment_params = {
            "user_id": f"eq.{cv.user_id}",
            "matcher_version": f"eq.{MATCHER_VERSION}",
            **job_scope,
        }
        assessment_future = _CONTEXT_READ_EXECUTOR.submit(_load_current_assessments, client, assessment_params)

    metadata_overrides = read_futures["metadata"].result()
    current_fingerprints: dict[int, str] = {}
    candidate_digest = candidate_projection_sha256(candidate_profile) if candidate_profile is not None else None
    if candidate_profile is not None:
        for row in jobs:
            description = row.get("description")
            if not description or classify_job_description(description, str(row.get("description_kind") or "missing")) != "full":
                continue
            job_id = int(row["id"])
            effective = resolve_effective_job_metadata(
                row.get("company"), row.get("title"), metadata_overrides.get(job_id)
            )
            verified = VerifiedJob(
                title=effective.title,
                company=effective.company,
                description=str(description),
                source_url=row.get("application_url") or row.get("source_url") or f"manual://job/{job_id}",
                location=row.get("location"),
                remote_scope=row.get("remote_scope"),
            )
            current_fingerprints[job_id] = evaluation_fingerprint(
                candidate_profile=candidate_profile,
                job=verified,
                matcher_version=MATCHER_VERSION,
                model=DEFAULT_MODEL,
                candidate_projection_digest=candidate_digest,
            )
    applications = read_futures["applications"].result() if not summary_only else []
    reviews = read_futures["reviews"].result() if not summary_only else []
    verification_results = {
        name: read_futures[name].result()
        for name in (
            "user_verifications", "location_verifications", "employment_type_verifications",
        )
    }
    user_verifications, state["manual_verification_unavailable"] = verification_results["user_verifications"]
    location_verifications, state["location_verification_unavailable"] = verification_results["location_verifications"]
    employment_type_verifications, state["employment_type_verification_unavailable"] = verification_results["employment_type_verifications"]
    preference_overrides = read_futures["preference_overrides"].result()
    state["preference_override_unavailable"] = False
    assessments = assessment_future.result() if assessment_future is not None else []
    tailored_versions = read_futures["tailored_versions"].result() if not summary_only else []
    failed_fit_fingerprints = {
        int(job_id): str(fingerprint)
        for job_id, fingerprint in state.get("fit_failed_fingerprints", {}).items()
        if str(job_id).isdigit() and isinstance(fingerprint, str)
    }
    loaded_jobs = sort_dashboard_jobs(
        merge_dashboard_rows(
            jobs,
            applications,
            assessments,
            reviews,
            tailored_versions,
            search_profile=search_profile,
            current_fit_fingerprints=current_fingerprints,
            failed_fit_fingerprints=failed_fit_fingerprints,
            user_verifications=user_verifications,
            location_verifications=location_verifications,
            employment_type_verifications=employment_type_verifications,
            preference_overrides=preference_overrides,
            metadata_overrides=metadata_overrides,
            active_profile_id=active_profile_id,
        )
    )
    if ui_state is None:
        _reconcile_dashboard_overrides(cv.user_id, job_ids if job_ids is not None else {
            *st.session_state.get("dashboard_lifecycle_overrides", {}).get(cv.user_id, {}),
            *(job.id for job in loaded_jobs),
        })
    return loaded_jobs, active_profile_id, cv.user_id, cv.id, cv.storage_bucket


def load_dashboard_data(client: SupabaseRestClient) -> tuple[list[DashboardJob], int | None]:
    """Compatibility wrapper returning only the rows and active profile."""

    jobs, profile_id, _, _, _ = load_dashboard_context(client)
    return jobs, profile_id


def transition_job_lifecycle(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_id: int,
    target: str,
    cv_version_id: int | None = None,
    has_current_fit: bool = False,
    update_session_state: bool = True,
) -> None:
    """Persist a validated user-specific lifecycle action; never mutate jobs."""

    def cleanup_archived_cv() -> None:
        if not isinstance(client, SupabaseRestClient):
            return
        result = run_archived_cv_cleanup_for_job(client, user_id=user_id, job_id=job_id)
        for failure in result.failures:
            logging.warning("Archived CV cleanup will retry: %s", failure)

    apps = _get_rows(client, "applications", {
        "select": "id,status,cv_version_id,applied_at,interview_at,offer_at,hired_at,rejected_at,withdrawn_at",
        "user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}", "limit": "1",
    })
    reviews = _get_rows(client, "job_reviews", {
        "select": "id,status", "user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}", "limit": "1",
    })
    app = apps[0] if apps else None
    review = reviews[0] if reviews else None
    state = lifecycle_state(app, review, has_current_fit=has_current_fit)
    if target == state:
        if target in {"ignored", "archived"}:
            if target == "archived":
                cleanup_archived_cv()
            return
        raise PersistenceError(f"This listing is already {target}.")
    if target == "reopen":
        if target not in ALLOWED_TRANSITIONS.get(state, frozenset()):
            raise PersistenceError(f"Cannot reopen a listing in state {state}.")
        now = datetime.now(timezone.utc).isoformat()
        if app and app.get("status") in {"hired", "rejected", "withdrawn", "no_response"}:
            client.json_request(
                "PATCH", f"/rest/v1/applications?id=eq.{app['id']}&user_id=eq.{user_id}&job_id=eq.{job_id}",
                {"status": "draft", "status_changed_at": now}, prefer="return=representation",
            )
        if review and review.get("status") in {"ignored", "archived"}:
            client.json_request(
                "PATCH", f"/rest/v1/job_reviews?id=eq.{review['id']}&user_id=eq.{user_id}&job_id=eq.{job_id}",
                {"status": "interested"}, prefer="return=representation",
            )
        if update_session_state:
            _record_dashboard_lifecycle_override(
                user_id,
                job_id,
                review_status="rated" if has_current_fit else "new",
                application_status=None,
            )
        return
    if target not in {"applied", "interview", "offer", "hired", "rejected", "withdrawn", "archived"}:
        raise ValueError("Choose a supported lifecycle action.")
    if target not in ALLOWED_TRANSITIONS.get(state, frozenset()):
        raise PersistenceError(f"Cannot move a listing from {state} to {target}.")
    now = datetime.now(timezone.utc).isoformat()
    if target == "archived":
        if review:
            client.json_request(
                "PATCH", f"/rest/v1/job_reviews?id=eq.{review['id']}&user_id=eq.{user_id}&job_id=eq.{job_id}",
                {"status": target}, prefer="return=representation",
            )
        else:
            client.json_request(
                "POST", "/rest/v1/job_reviews",
                {"user_id": user_id, "job_id": job_id, "status": target},
                prefer="return=representation",
            )
        cleanup_archived_cv()
        if update_session_state:
            _record_dashboard_lifecycle_override(user_id, job_id, review_status="archived")
        return

    timestamp_field = workflow_timestamp_column(target)
    payload: dict[str, Any] = {"status": target, "status_changed_at": now}
    if timestamp_field:
        payload[timestamp_field] = now
    if app:
        client.json_request(
            "PATCH", f"/rest/v1/applications?id=eq.{app['id']}&user_id=eq.{user_id}&job_id=eq.{job_id}", payload,
            prefer="return=representation",
        )
    elif target == "applied" and cv_version_id is not None:
        client.json_request(
            "POST", "/rest/v1/applications",
            {"user_id": user_id, "job_id": job_id, "cv_version_id": cv_version_id, **payload},
            prefer="return=representation",
        )
    else:
        raise PersistenceError("An application must be recorded before changing its application stage.")
    if target == "applied":
        clear_tailored_expiration_for_job(client, user_id=user_id, job_id=job_id)
    _record_dashboard_lifecycle_override(
        user_id,
        job_id,
        review_status=target,
        application_status=target,
        status_changed_at=now,
        **({timestamp_field: now} if timestamp_field else {}),
        **({"tailored_expires_at": None} if target == "applied" else {}),
    )


def mark_applied(client: SupabaseRestClient, *, user_id: str, job_id: int, cv_version_id: int) -> None:
    transition_job_lifecycle(
        client, user_id=user_id, job_id=job_id, target="applied", cv_version_id=cv_version_id
    )


def _mark_applied_and_open_applications(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_id: int,
    cv_version_id: int,
) -> None:
    try:
        mark_applied(client, user_id=user_id, job_id=job_id, cv_version_id=cv_version_id)
    except (PersistenceError, ValueError) as exc:
        st.session_state["application_action_error"] = str(exc)
        return
    st.session_state["app_page"] = "Applications"
    st.session_state["application_stage_filter"] = "Active"


def archive_job(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_id: int,
    has_current_fit: bool = False,
    update_session_state: bool = True,
) -> None:
    transition_job_lifecycle(
        client, user_id=user_id, job_id=job_id, target="archived",
        has_current_fit=has_current_fit, update_session_state=update_session_state,
    )


def reopen_job(client: SupabaseRestClient, *, user_id: str, job_id: int, has_current_fit: bool = False) -> None:
    transition_job_lifecycle(
        client, user_id=user_id, job_id=job_id, target="reopen", has_current_fit=has_current_fit
    )


def archive_jobs(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_ids: list[int],
    update_session_state: bool = True,
) -> tuple[list[int], list[tuple[int, str]]]:
    """Archive each selected job, retaining partial results."""
    archived: list[int] = []
    failed: list[tuple[int, str]] = []
    for job_id in dict.fromkeys(int(value) for value in job_ids):
        try:
            archive_job(
                client, user_id=user_id, job_id=job_id,
                update_session_state=update_session_state,
            )
        except (PersistenceError, ValueError) as exc:
            failed.append((job_id, str(exc)))
        else:
            archived.append(job_id)
    return archived, failed


def start_bulk_archive(client: SupabaseRestClient, *, user_id: str, jobs: list[DashboardJob]) -> int:
    """Optimistically hide a selected cohort and archive it on a worker thread."""
    if st.session_state.get("bulk_archive_task"):
        return 0
    archiveable = [job for job in jobs if can_archive_job(job)]
    if not archiveable:
        return 0
    job_ids = [job.id for job in archiveable]
    future = _ARCHIVE_EXECUTOR.submit(
        archive_jobs, client, user_id=user_id, job_ids=job_ids, update_session_state=False
    )
    st.session_state["bulk_archive_task"] = {
        "future": future,
        "job_ids": job_ids,
        "previous_statuses": {job.id: job.review_status for job in archiveable},
    }
    for job in archiveable:
        _record_dashboard_lifecycle_override(user_id, job.id, review_status="archived")
        st.session_state.pop(f"archive-select-{job.id}", None)
    return len(archiveable)


def _collect_bulk_archive_result(user_id: str, task: dict[str, Any]) -> dict[str, Any]:
    try:
        archived, failed = task["future"].result()
    except Exception:
        archived, failed = [], [(int(job_id), "Archive operation failed unexpectedly.") for job_id in task["job_ids"]]
    for job_id, _reason in failed:
        _record_dashboard_lifecycle_override(
            user_id, job_id, review_status=task["previous_statuses"][job_id]
        )
    return {"archived": len(archived), "failed": failed, "job_ids": task["job_ids"]}


def _finish_bulk_archive_ui() -> bool:
    result = st.session_state.get("bulk_archive_result")
    if result is None:
        return False
    st.session_state["bulk_archive_flash"] = result
    st.session_state.pop("bulk_archive_result", None)
    return True


@st.fragment(run_every="1s")
def _poll_bulk_archive_task(user_id: str) -> None:
    task = st.session_state.get("bulk_archive_task")
    if task:
        future: Future = task["future"]
        if not future.done():
            return
        result = _collect_bulk_archive_result(user_id, task)
        st.session_state["bulk_archive_result"] = result
        st.session_state.pop("bulk_archive_task", None)
        st.toast(f"Archive done · {result['archived']} moved, {len(result['failed'])} failed. Click Update view beside Rate selected.")


def rate_jobs(
    jobs: list[DashboardJob],
    client: SupabaseRestClient,
    *,
    user_id: str,
    cv_version_id: int,
    candidate_profile_id: int | None,
    failed_fingerprints: dict[int, str],
    progress_callback: Callable[[int, int], None] | None = None,
    result_callback: Callable[[DashboardJob, dict[str, Any]], None] | None = None,
) -> tuple[list[DashboardJob], int, list[tuple[DashboardJob, str]]]:
    """Rate eligible selected jobs through the same cached Fit path as card actions."""
    eligible = [job for job in jobs if can_rate_job(job)]
    if candidate_profile_id is None:
        return [], 0, [(job, "No active CandidateProfile is available for rating.") for job in eligible]

    completed: list[DashboardJob] = []
    cache_hits = 0
    failed: list[tuple[DashboardJob, str]] = []
    for start in range(0, len(eligible), RATE_BATCH_SIZE):
        batch = eligible[start : start + RATE_BATCH_SIZE]
        for job in batch:
            try:
                job = _hydrate_dashboard_job(client, user_id=user_id, job=job, include_description=True)
                if not job.description:
                    raise PersistenceError("The verified job description is unavailable for rating.")
                result = rate_job_with_manual_jd(
                    client,
                    user_id=user_id,
                    cv_version_id=cv_version_id,
                    candidate_profile_id=candidate_profile_id,
                    job_id=job.id,
                    jd_text=job.description or "",
                )
            except (ManualJDOperationError, ManualJDValidationError, PersistenceError) as exc:
                if job.fit_fingerprint:
                    failed_fingerprints[job.id] = job.fit_fingerprint
                failed.append((job, str(exc)))
            else:
                failed_fingerprints.pop(job.id, None)
                completed.append(job)
                cache_hits += int(bool(result.get("cache_hit")))
                if result_callback:
                    result_callback(job, result)
        if progress_callback:
            progress_callback(min(start + len(batch), len(eligible)), len(eligible))
    return completed, cache_hits, failed


def _run_bulk_rating_task(
    jobs: list[DashboardJob],
    client: SupabaseRestClient,
    *,
    user_id: str,
    cv_version_id: int,
    candidate_profile_id: int | None,
    failed_fingerprints: dict[int, str],
) -> dict[str, Any]:
    fit_results: dict[int, dict[str, Any]] = {}
    completed, cache_hits, failed = rate_jobs(
        jobs,
        client,
        user_id=user_id,
        cv_version_id=cv_version_id,
        candidate_profile_id=candidate_profile_id,
        failed_fingerprints=failed_fingerprints,
        result_callback=lambda job, result: fit_results.__setitem__(job.id, {
            "fit_fingerprint": result.get("fit_fingerprint") or job.fit_fingerprint,
            "_expected_fit_fingerprint": job.fit_fingerprint,
            "_expected_profile_id": candidate_profile_id,
            "fit_assessment_id": result.get("fit_assessment_id"),
            "fit_score": int(result["fit_score"]),
            "fit_strengths": tuple(result.get("strengths", [])),
            "fit_gaps": tuple(result.get("gaps", [])),
        }),
    )
    return {
        "completed_ids": [job.id for job in completed],
        "fit_results": fit_results,
        "failed": [(job.id, job.company, job.title, reason) for job, reason in failed],
        "cache_hits": cache_hits,
        "failed_fingerprints": failed_fingerprints,
    }


def start_bulk_rating(
    jobs: list[DashboardJob],
    client: SupabaseRestClient,
    *,
    user_id: str,
    cv_version_id: int,
    candidate_profile_id: int | None,
    failed_fingerprints: dict[int, str],
) -> int:
    """Start selected Fit evaluations without blocking the dashboard thread."""
    if any(st.session_state.get(key) for key in ("bulk_archive_task", "bulk_rating_task", "bulk_rating_result")):
        return 0
    eligible = [job for job in jobs if can_rate_job(job)]
    if not eligible:
        return 0
    job_ids = [job.id for job in eligible]
    future = _ARCHIVE_EXECUTOR.submit(
        _run_bulk_rating_task,
        eligible,
        client,
        user_id=user_id,
        cv_version_id=cv_version_id,
        candidate_profile_id=candidate_profile_id,
        failed_fingerprints=dict(failed_fingerprints),
    )
    st.session_state["bulk_rating_task"] = {"future": future, "job_ids": job_ids}
    for job_id in job_ids:
        st.session_state.pop(f"archive-select-{job_id}", None)
    return len(job_ids)


@st.fragment(run_every="1s")
def _poll_bulk_rating_task() -> None:
    task = st.session_state.get("bulk_rating_task")
    if task is None:
        return
    future: Future = task["future"]
    if not future.done():
        return
    result = _collect_bulk_rating_result(task)
    result["job_ids"] = task["job_ids"]
    st.session_state["bulk_rating_result"] = result
    st.session_state.pop("bulk_rating_task", None)
    st.toast(f"Rating done · {len(result['completed_ids'])} rated, {len(result['failed'])} failed. Click Update view beside Rate selected.")


def _collect_bulk_rating_result(task: dict[str, Any]) -> dict[str, Any]:
    try:
        return task["future"].result()
    except Exception:
        return {
            "completed_ids": [],
            "fit_results": {},
            "failed": [(job_id, "", "", "Background rating failed unexpectedly.") for job_id in task["job_ids"]],
            "cache_hits": 0,
            "failed_fingerprints": {},
        }


def _render_bulk_rating_status(user_id: str) -> None:
    result = st.session_state.get("bulk_rating_result")
    task = st.session_state.get("bulk_rating_task")
    if result is not None:
        st.caption(f"Ratings complete · {len(result['completed_ids'])} rated · {len(result['failed'])} failed. Click Update view beside Rate selected.")
    elif task:
        st.caption(f"Rating {len(task['job_ids'])} selected listing(s)…")


def _apply_bulk_rating_result(user_id: str) -> bool:
    result = st.session_state.get("bulk_rating_result")
    task = st.session_state.get("bulk_rating_task")
    if result is None and task is not None:
        if not task["future"].done():
            return False
        result = _collect_bulk_rating_result(task)
        result["job_ids"] = task["job_ids"]
        st.session_state["bulk_rating_result"] = result
        st.session_state.pop("bulk_rating_task", None)
    if result is None:
        return False
    completed_count = len(result["completed_ids"])
    failed_count = len(result["failed"])
    failed_fingerprints = {
        str(key): value
        for key, value in st.session_state.get("fit_failed_fingerprints", {}).items()
        if str(key).isdigit() and isinstance(value, str)
    }
    failed_fingerprints.update({
        str(key): value
        for key, value in result["failed_fingerprints"].items()
    })
    st.session_state["fit_failed_fingerprints"] = failed_fingerprints
    for job_id, fields in result["fit_results"].items():
        _record_dashboard_lifecycle_override(
            user_id, int(job_id), **fields, fit_attempt_failed=False
        )
    for job_id, _company, _title, _reason in result["failed"]:
        if int(job_id) not in result["fit_results"]:
            fingerprint = failed_fingerprints.get(str(job_id))
            _record_dashboard_lifecycle_override(
                user_id, int(job_id), fit_attempt_failed=True, fit_fingerprint=fingerprint,
            )
    for job_id in result["job_ids"]:
        st.session_state.pop(f"archive-select-{job_id}", None)
    st.session_state["bulk_rate_flash"] = {
        "rated": completed_count,
        "cache_hits": result["cache_hits"],
        "failed": [(company, title, reason) for _, company, title, reason in result["failed"]],
    }
    st.session_state.pop("bulk_rating_result", None)
    return True


def save_manual_verification(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_id: int,
    verification_status: str,
    reason: str | None = None,
) -> None:
    allowed = {"confirmed_live", "confirmed_closed", "unable_to_verify"}
    if verification_status not in allowed:
        raise ValueError("Choose a valid verification outcome.")
    normalized_reason = (reason or "").strip() or None
    if verification_status != "confirmed_live" and not normalized_reason:
        raise ValueError("Choose or enter a reason for the unsuccessful check.")
    try:
        client.json_request(
            "POST",
            "/rest/v1/user_job_verifications?on_conflict=user_id,job_id",
            {
                "user_id": user_id,
                "job_id": job_id,
                "verification_status": verification_status,
                "verification_reason": normalized_reason,
                "checked_at": datetime.now(timezone.utc).isoformat(),
            },
            prefer="resolution=merge-duplicates,return=minimal",
        )
    except PersistenceError as exc:
        message = str(exc).lower()
        if "user_job_verifications" in message and any(code in message for code in ("pgrst205", "42p01", "404")):
            raise PersistenceError("Manual verification is not set up in Supabase yet. Apply the latest migration, then reload.") from exc
        raise


def save_manual_work_model(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_id: int,
    work_model: str,
) -> None:
    """Persist a user-confirmed work arrangement without changing job-wide data."""
    allowed = {"remote", "hybrid", "onsite", "flexible"}
    if work_model not in allowed:
        raise ValueError("Choose a supported work arrangement.")
    try:
        client.json_request(
            "POST",
            "/rest/v1/user_job_work_model_verifications?on_conflict=user_id,job_id",
            {
                "user_id": user_id,
                "job_id": job_id,
                "work_model": work_model,
                "verified_at": datetime.now(timezone.utc).isoformat(),
            },
            prefer="resolution=merge-duplicates,return=minimal",
        )
    except PersistenceError as exc:
        message = str(exc).lower()
        if "user_job_work_model_verifications" in message and any(code in message for code in ("pgrst205", "42p01", "404")):
            raise PersistenceError("Manual work-model resolution needs the latest Supabase migration. Apply it, then reload.") from exc
        raise


def save_manual_language_status(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_id: int,
    language_status: str,
) -> None:
    if language_status not in {"accepted", "rejected"}:
        raise ValueError("Choose whether the language fits your preferences.")
    try:
        client.json_request(
            "POST",
            "/rest/v1/user_job_language_verifications?on_conflict=user_id,job_id",
            {
                "user_id": user_id,
                "job_id": job_id,
                "language_status": language_status,
                "verified_at": datetime.now(timezone.utc).isoformat(),
            },
            prefer="resolution=merge-duplicates,return=minimal",
        )
    except PersistenceError as exc:
        message = str(exc).lower()
        if "user_job_language_verifications" in message and any(code in message for code in ("pgrst205", "42p01", "404")):
            raise PersistenceError("Manual language confirmation needs the latest Supabase migration. Apply it, then reload.") from exc
        raise


def save_manual_location_status(
    client: SupabaseRestClient,
    *,
    user_id: str,
    job_id: int,
    location_status: str,
) -> None:
    """Persist a user's location preference decision without changing the global job."""
    if location_status not in {"accepted", "rejected"}:
        raise ValueError("Choose whether the listing location fits your preferences.")
    try:
        client.json_request(
            "POST",
            "/rest/v1/user_job_location_verifications?on_conflict=user_id,job_id",
            {
                "user_id": user_id,
                "job_id": job_id,
                "location_status": location_status,
                "verified_at": datetime.now(timezone.utc).isoformat(),
            },
            prefer="resolution=merge-duplicates,return=minimal",
        )
    except PersistenceError as exc:
        message = str(exc).lower()
        if "user_job_location_verifications" in message and any(code in message for code in ("pgrst205", "42p01", "404")):
            raise PersistenceError("Manual location confirmation needs the latest Supabase migration. Apply it, then reload.") from exc
        raise


def save_location_and_update_card(
    client: SupabaseRestClient, *, user_id: str, job: DashboardJob, location_status: str
) -> DashboardJob:
    """Save the user's location decision and update only the affected card."""
    profiles = _get_rows(client, "search_profiles", {
        "select": "id,definition", "user_id": f"eq.{user_id}",
        "is_active": "eq.true", "limit": "2",
    })
    eligibility = assess_discovered_job(
        title=job.title, location=job.location, remote_scope=job.remote_scope,
        description=job.description, profile=profiles[0] if len(profiles) == 1 else None,
        manual=job.is_manual, employment_type=job.employment_type,
        description_kind=job.description_kind, verified_work_model=job.verified_work_model,
        verified_language=job.verified_language_status,
        verified_location_status=location_status,
    )
    fields = {
        "verified_location_status": location_status,
        "eligibility_reason": eligibility.reason,
    }
    for name in ("role", "location", "work_model", "language", "employment_type", "seniority"):
        fields[f"{name}_eligibility"] = getattr(eligibility, name)
        fields[f"{name}_reason"] = getattr(eligibility, f"{name}_reason")
    save_manual_location_status(client, user_id=user_id, job_id=job.id, location_status=location_status)
    fields["location_checked_at"] = datetime.now(timezone.utc).isoformat()
    _record_dashboard_lifecycle_override(user_id, job.id, **fields)
    return replace(job, **fields)


def _render_manual_language_control(job: DashboardJob, client: SupabaseRestClient, *, user_id: str, disabled: bool) -> None:
    if job.language_eligibility != "unclear":
        return
    with st.form(f"manual-language-form-{job.id}"):
        decision = st.radio(
            "Does the listing language fit your preferences?",
            ["Yes, approve this language", "No, reject this listing"],
            key=f"manual-language-choice-{job.id}",
        )
        submitted = st.form_submit_button("Save language decision", disabled=disabled)
    if not submitted:
        return
    status = "accepted" if decision == "Yes, approve this language" else "rejected"
    try:
        save_manual_language_status(client, user_id=user_id, job_id=job.id, language_status=status)
    except (PersistenceError, ValueError) as exc:
        st.error(f"Could not save the language decision: {exc}")
        return
    st.session_state["language_verification_unavailable"] = False
    _record_dashboard_lifecycle_override(
        user_id,
        job.id,
        language_eligibility="eligible" if status == "accepted" else "ineligible",
        language_reason="Language compatibility manually approved." if status == "accepted" else "Language manually rejected by the user.",
    )
    _refresh_listing_summary_after_action(client, user_id=user_id, job_id=job.id)
    st.rerun(scope="fragment")


def _render_manual_location_control(job: DashboardJob, client: SupabaseRestClient, *, user_id: str, disabled: bool) -> None:
    if st.session_state.get("location_verification_unavailable"):
        return
    if job.verified_location_status == "rejected":
        st.warning("You marked this location as outside your preferences. Find it under Archive → Preference mismatches.")
    elif job.verified_location_status == "accepted":
        st.success("You approved this location for this listing, overriding the configured location preference.")
    if job.location_eligibility not in {"unclear", "ineligible"}:
        return
    with st.form(f"manual-location-form-{job.id}"):
        if job.location_eligibility == "ineligible":
            st.caption("The location conflicts with your saved preferences. You can explicitly allow it after checking the listing.")
        else:
            st.caption("Check the listing location and confirm whether it fits your configured preferences.")
        st.caption("If it does not fit, it will leave Jobs and remain available under Archive → Preference mismatches.")
        decision = st.radio(
            "Does this location fit your preferences?",
            ["Yes, this location fits", "No, this location does not fit"],
            key=f"manual-location-choice-{job.id}",
        )
        submitted = st.form_submit_button("Save location decision", disabled=disabled)
    if not submitted:
        return
    status = "accepted" if decision == "Yes, this location fits" else "rejected"
    try:
        with st.spinner("Saving location decision…"):
            save_location_and_update_card(client, user_id=user_id, job=job, location_status=status)
    except (PersistenceError, ValueError) as exc:
        st.error(f"Could not save the location decision: {exc}")
        return
    _refresh_listing_summary_after_action(client, user_id=user_id, job_id=job.id)
    st.session_state["location_verification_unavailable"] = False
    message = (
        f"{job.company} · {job.title}: location approved for this listing."
        if status == "accepted"
        else f"{job.company} · {job.title}: marked as outside your location preferences. It is now under Archive → Preference mismatches."
    )
    st.session_state["manual_location_flash"] = (status, message)
    st.rerun(scope="fragment")


def validate_listing_url(value: str) -> str:
    """Validate and normalize a user-supplied listing URL before writing it."""

    url = value.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Enter a complete http:// or https:// listing URL.")
    return url


def save_listing_url(client: SupabaseRestClient, *, job_id: int, url: str) -> None:
    """Attach a user-provided listing URL without changing job identity or metadata."""

    normalized = validate_listing_url(url)
    client.json_request(
        "PATCH",
        f"/rest/v1/jobs?id=eq.{job_id}",
        {"application_url": normalized},
        prefer="return=minimal",
    )


def _display_date(value: str | None) -> str:
    return value[:10] if value else "Not available"


def _manual_verification_control(
    output: Any,
    job: DashboardJob,
    client: SupabaseRestClient,
    *,
    user_id: str,
    disabled: bool,
) -> None:
    if not job.direct_url or st.session_state.get("manual_verification_unavailable"):
        return
    with output.container():
        _render_manual_verification_control(job, client, user_id=user_id, disabled=disabled)


def _render_manual_work_model_control(
    job: DashboardJob,
    client: SupabaseRestClient,
    *,
    user_id: str,
    disabled: bool,
) -> None:
    if job.work_model_eligibility != "unclear" or st.session_state.get("work_model_verification_unavailable"):
        return
    with st.form(f"manual-work-model-form-{job.id}"):
        st.caption("Checked the listing? Record the work arrangement it actually offers.")
        work_model = st.selectbox(
            "Work arrangement",
            ["Remote", "Hybrid", "On-site", "Flexible / employee choice"],
            key=f"manual-work-model-choice-{job.id}",
        )
        submitted = st.form_submit_button("Save work model", disabled=disabled)
    if not submitted:
        return
    value = {
        "Remote": "remote",
        "Hybrid": "hybrid",
        "On-site": "onsite",
        "Flexible / employee choice": "flexible",
    }[work_model]
    try:
        save_work_model_and_update_card(client, user_id=user_id, job=job, work_model=value)
    except (PersistenceError, ValueError) as exc:
        st.error(f"Could not save the work model: {exc}")
        return
    _refresh_listing_summary_after_action(client, user_id=user_id, job_id=job.id)
    st.session_state["manual_work_model_flash"] = f"{job.company} · {job.title}: work model saved."
    st.rerun(scope="fragment")


def _render_manual_verification_control(
    job: DashboardJob,
    client: SupabaseRestClient,
    *,
    user_id: str,
    disabled: bool,
) -> None:
    if job.user_verification_status is not None and st.session_state.get("manual_verification_job_id") != job.id:
        st.caption("Manual verification already recorded.")
        return
    if st.session_state.get("manual_verification_job_id") != job.id:
        if not st.button("Verify manually", key=f"manual-verify-{job.id}", disabled=disabled):
            return
        st.session_state["manual_verification_job_id"] = job.id

    with st.form(f"manual-verification-form-{job.id}"):
        open_label = "I confirmed this exact listing is open"
        closed_label = "I confirmed it is closed"
        unsuitable_label = "It is open, but it does not fit my preferences"
        unable_label = "I could not verify it"
        outcome_label = st.radio(
            "What did you find?",
            [open_label, unsuitable_label, closed_label, unable_label],
            key=f"manual-verification-outcome-{job.id}",
            label_visibility="visible",
        )
        reason = None
        if outcome_label == unsuitable_label:
            reason = st.selectbox(
                "Why is it not a fit?",
                [
                    "Location does not fit my preferences",
                    "Work arrangement does not fit my preferences",
                    "Role does not fit my search",
                    "Other",
                ],
                key=f"manual-verification-reason-{job.id}",
            )
            if reason == "Other":
                detail = st.text_input("Add a short reason", key=f"manual-verification-detail-{job.id}")
                reason = f"Other: {detail.strip()}" if detail.strip() else "Other"
        elif outcome_label not in {open_label}:
            reason_choices = (
                ["The listing says applications are closed", "The requisition is no longer listed", "The link points to a different role", "Other"]
                if outcome_label == closed_label
                else ["The page is blocked or inaccessible", "The link is broken", "Only a generic careers page is available", "I could not determine its status", "Other"]
            )
            reason_choice = st.selectbox("Why?", reason_choices, key=f"manual-verification-reason-{job.id}")
            reason_detail = st.text_input(
                "Add details" if reason_choice == "Other" else "Optional details",
                key=f"manual-verification-detail-{job.id}",
            )
            reason = reason_choice + (f": {reason_detail.strip()}" if reason_detail.strip() else "")
        submitted = st.form_submit_button("Save verification", disabled=disabled)
        if submitted:
            if "Other" in (reason or "") and ":" not in (reason or ""):
                st.error("Add details for the Other reason.")
            else:
                verification_status = {
                    open_label: "confirmed_live",
                    unsuitable_label: "confirmed_live",
                    closed_label: "confirmed_closed",
                    unable_label: "unable_to_verify",
                }[outcome_label]
                verification_reason = (
                    f"Open listing; {reason.lower()}." if outcome_label == unsuitable_label else reason
                )
                try:
                    save_manual_verification(
                        client,
                        user_id=user_id,
                        job_id=job.id,
                        verification_status=verification_status,
                        reason=verification_reason,
                    )
                    if outcome_label == unsuitable_label:
                        archive_job(
                            client,
                            user_id=user_id,
                            job_id=job.id,
                            has_current_fit=job.fit_score is not None,
                        )
                except (PersistenceError, ValueError) as exc:
                    st.error(f"Could not save your verification: {exc}")
                else:
                    _record_dashboard_lifecycle_override(
                        user_id, job.id,
                        user_verification_status=verification_status,
                        user_verification_reason=verification_reason,
                        availability_status=("expired" if verification_status == "confirmed_closed" else "active"),
                        **({"review_status": "archived"} if outcome_label == unsuitable_label else {}),
                    )
                    _refresh_listing_summary_after_action(client, user_id=user_id, job_id=job.id)
                    st.session_state.pop("manual_verification_job_id", None)
                    st.rerun(scope="fragment")


def _job_operation_busy(job_id: int) -> bool:
    if any(key[1] == job_id for key in st.session_state.get("tailored_cv_tasks", {})):
        return True
    if st.session_state.get("busy_job_id") == job_id or st.session_state.get("tailored_cv_busy_job_id") == job_id:
        return True
    for key in ("bulk_rating_task", "bulk_rating_result", "bulk_archive_task", "bulk_archive_result"):
        operation = st.session_state.get(key)
        if operation and job_id in {int(value) for value in operation.get("job_ids", [])}:
            return True
    if any(key[1] == job_id for key in st.session_state.get("preference_override_tasks", {})):
        return True
    return False


def _persist_preference_override_and_rebuild(
    client: SupabaseRestClient, *, user_id: str, job_id: int,
    fields: tuple[str, ...] | None,
) -> None:
    if fields:
        save_preference_override(client, user_id=user_id, job_id=job_id, fields=fields)
    else:
        remove_preference_override(client, user_id=user_id, job_id=job_id)
    _rebuild_listing_dashboard_summary(client, user_id=user_id, job_id=job_id)


def _rebuild_listing_dashboard_summary(
    client: SupabaseRestClient, *, user_id: str, job_id: int,
) -> None:
    from .dashboard_summary import build_dashboard_summaries

    result = build_dashboard_summaries(
        client, user_id=user_id, max_batches=1, target_job_id=job_id
    )
    if result["stale"]:
        raise PersistenceError(
            "The listing changed while its summary was rebuilding. The background worker will retry it."
        )


def _refresh_listing_summary_after_action(
    client: SupabaseRestClient, *, user_id: str, job_id: int,
) -> None:
    try:
        _rebuild_listing_dashboard_summary(client, user_id=user_id, job_id=job_id)
    except Exception:
        logging.exception("Could not immediately rebuild dashboard summary for job %s", job_id)
        st.warning(
            "Your decision was saved, but this listing is still updating. "
            "The background worker will retry it."
        )


def _start_preference_override_task(
    client: SupabaseRestClient, *, user_id: str, job_id: int,
    fields: tuple[str, ...] | None,
) -> None:
    key = (user_id, int(job_id))
    tasks = st.session_state.setdefault("preference_override_tasks", {})
    if key in tasks:
        return
    tasks[key] = _PREFERENCE_OVERRIDE_EXECUTOR.submit(
        _persist_preference_override_and_rebuild,
        client, user_id=user_id, job_id=int(job_id), fields=fields,
    )


def _listing_acceptance_fields(job: DashboardJob) -> tuple[str, ...]:
    fields = []
    if job.role_eligibility == "target_adjacent":
        fields.append("role")
    if job.location_eligibility in {"unclear", "ineligible"}:
        fields.append("location")
    if job.employment_type_eligibility in {"unclear", "ineligible"}:
        fields.append("employment_type")
    if job.seniority_eligibility in {"unclear", "ineligible"}:
        fields.append("seniority")
    return tuple(fields)


def _listing_acceptance_blockers(job: DashboardJob, *, active_profile_id: int | None) -> tuple[str, ...]:
    blockers = []
    if job.role_eligibility in {"excluded", "unrelated"}:
        blockers.append("This role is excluded by the active profile and cannot be overridden here.")
    if job.metadata_unresolved:
        blockers.append("Resolve the company or title details first.")
    if job.duplicate_review_status == "pending":
        blockers.append("Resolve the possible duplicate first.")
    if not job.live_for_user:
        blockers.append("Verify that this exact listing is still open first.")
    if active_profile_id is None and not job.is_manual:
        blockers.append("An active SearchProfile is required to review this listing.")
    has_full_jd = job.description_kind == "full" and (
        bool(job.description) if job.description_available is None else job.description_available
    )
    if not has_full_jd:
        blockers.append("A verified full job description is required before accepting this listing.")
    if job.review_status in {"applied", "interview", "offer", "hired", "rejected", "no_response", "withdrawn", "ignored", "archived", "closed"}:
        blockers.append("This listing already has a recorded outcome.")
    return tuple(blockers)


def _poll_preference_override_tasks(user_id: str) -> bool:
    """Collect finished per-card writes; return whether the page should reload."""
    tasks = st.session_state.get("preference_override_tasks", {})
    finished = False
    for key, future in list(tasks.items()):
        if key[0] != user_id or not future.done():
            continue
        tasks.pop(key, None)
        try:
            future.result()
        except Exception as exc:
            st.session_state.setdefault("preference_override_errors", {})[key] = str(exc)
            st.toast("The preference save needs attention; the listing remains queued for refresh.")
        else:
            st.session_state.setdefault("preference_override_errors", {}).pop(key, None)
            st.toast("Listing preference saved and its card refreshed.")
        finished = True
    return finished


def _open_interview_prep(job_id: int) -> None:
    st.session_state["interview_prep_job_id"] = job_id
    st.session_state.pop("interview_prep_record_id", None)
    st.session_state.pop("interview_prep_request_key", None)


def _render_job(
    job: DashboardJob,
    client: SupabaseRestClient,
    *,
    user_id: str,
    cv_version_id: int,
    active_profile_id: int | None,
    storage_bucket: str,
    application_view: bool = False,
    archive_view: bool = False,
    application_action_blocked: bool = False,
) -> None:
    job = replace(job, **_dashboard_job_overrides(user_id, job.id, job=job))
    failed_fingerprints: dict[int, str] = {
        int(job_id): str(fingerprint)
        for job_id, fingerprint in st.session_state.get("fit_failed_fingerprints", {}).items()
        if str(job_id).isdigit() and isinstance(fingerprint, str)
    }
    card_busy = _job_operation_busy(job.id)
    selected_job_id = st.session_state.get("manual_jd_job_id")
    selected_link_job_id = st.session_state.get("listing_url_job_id")
    with st.container(border=True):
        heading, score = st.columns([4, 1])
        with heading:
            status_badges = {
                "applied": "APPLIED",
                "interview": "INTERVIEW",
                "offer": "OFFER",
                "hired": "HIRED",
                "rejected": "REJECTED",
                "withdrawn": "WITHDRAWN",
                "no_response": "NO RESPONSE",
                "ignored": "ARCHIVED",
                "archived": "ARCHIVED",
                "rated": "RATED",
            }
            badge = (
                "EXPIRED / CLOSED"
                if job.decision.primary_reason_code == "listing_closed" and job.review_status not in status_badges
                else status_badges.get(job.review_status, "NEW" if job.review_status == "new" else "SEEN")
            )
            if job.source == "manual":
                badge = "MANUAL · " + badge
            st.markdown(f"<div class='job-status'>{badge}</div>", unsafe_allow_html=True)
            _render_metadata_field(
                job, "title", job.title,
                client=client, user_id=user_id, disabled=card_busy,
            )
            _render_metadata_field(
                job, "company", job.company,
                client=client, user_id=user_id, disabled=card_busy,
            )
        with score:
            if job.fit_score is not None:
                st.markdown(
                    f"<div class='fit-badge'><span class='fit-badge-label'>AI FIT</span><span class='fit-badge-score'>{job.fit_score}</span></div>",
                    unsafe_allow_html=True,
                )
            elif job.historical_fit_score is not None:
                st.markdown(
                    f"<div class='fit-badge'><span class='fit-badge-label'>OLD RATING</span><span class='fit-badge-score'>{job.historical_fit_score}</span></div>",
                    unsafe_allow_html=True,
                )
            elif job.rating_failed:
                st.markdown("<div class='fit-badge fit-badge-muted'>RATING FAILED</div>", unsafe_allow_html=True)
            elif job.jd_required:
                st.markdown("<div class='fit-badge fit-badge-muted'>JD REQUIRED</div>", unsafe_allow_html=True)
            elif job.ready_to_rate:
                st.markdown("<div class='fit-badge fit-badge-muted'>READY TO RATE</div>", unsafe_allow_html=True)
            elif job.pending_category:
                badge_text = {
                    "confirmed_closed": "MANUALLY CHECKED · CLOSED",
                    "unable_to_verify": "NOT VERIFIED",
                }.get(job.user_verification_status)
                if badge_text is None:
                    badge_text = "NOT VERIFIED" if job.pending_category == "Verification needed" else job.pending_category.upper()
                st.markdown(f"<div class='fit-badge fit-badge-muted'>{escape(badge_text)}</div>", unsafe_allow_html=True)
            else:
                st.markdown("<div class='fit-badge fit-badge-muted'>NOT ACTIONABLE</div>", unsafe_allow_html=True)

        metadata: list[str] = []
        place = " · ".join(value for value in (job.location, job.remote_scope) if value)
        if place:
            metadata.append(escape(place))
        if job.employment_type:
            employment_type = job.employment_type.strip().casefold()
            employment_label = {
                "full_time": "Full-time",
                "part_time": "Part-time",
                "contract": "Contract",
                "temporary": "Temporary",
                "internship": "Internship",
                "permanent": "Permanent",
            }.get(employment_type, job.employment_type.strip().replace("_", " ").replace("-", " ").title())
            metadata.append(f"Employment type: {escape(employment_label)}")
        if job.posted_at:
            metadata.append(f"Posted {_display_date(job.posted_at)}")
        if job.first_seen_at:
            metadata.append(f"First seen {_display_date(job.first_seen_at)}")
        if job.source:
            metadata.append(escape(job.source))
        st.markdown(f"<div class='job-meta'>{'<br>'.join(metadata)}</div>", unsafe_allow_html=True)
        if (user_id, job.id) in st.session_state.get("preference_override_tasks", {}):
            st.caption("Saving this listing preference and refreshing its summary…")
        if job.duplicate_review_status == "pending":
            st.warning("Possible match to a previously handled listing. Confirm before rating or applying.")
            st.caption(f"Previous record: {job.duplicate_match_company} — {job.duplicate_match_title}")
            choices = st.columns(2)
            for column, label, decision in (
                (choices[0], "Yes, same opening", "same_listing"),
                (choices[1], "No, different opening", "different_listing"),
            ):
                with column:
                    if st.button(label, key=f"duplicate-{decision}-{job.id}", disabled=card_busy):
                        try:
                            client.json_request(
                                "POST", "/rest/v1/user_job_duplicate_reviews?on_conflict=user_id,job_id",
                                {"user_id": user_id, "job_id": job.id,
                                 "matched_job_id": job.duplicate_match_job_id,
                                 "decision": decision, "updated_at": datetime.now(timezone.utc).isoformat()},
                                prefer="resolution=merge-duplicates,return=minimal",
                            )
                        except PersistenceError as exc:
                            st.error(f"Could not save this duplicate decision: {exc}")
                        else:
                            st.rerun()
            return
        milestone = {
            "applied": job.applied_at,
            "interview": job.interview_at,
            "offer": job.offer_at,
            "hired": job.hired_at,
            "rejected": job.rejected_at,
            "withdrawn": job.withdrawn_at,
        }.get(job.review_status)
        if milestone:
            st.caption(f"{job.review_status.replace('_', ' ').title()} · {_display_date(milestone)}")
        if job.review_status == "archived" and job.user_verification_status == "confirmed_live" and job.user_verification_reason:
            st.caption(f"Manual note · {job.user_verification_reason}")
        if job.tailored_artifact_available and job.tailored_expires_at:
            st.caption(f"CV expires {job.tailored_expires_at[:10]}")
        elif job.tailored_artifact_available and job.review_status in {"applied", "interview", "offer", "hired"}:
            st.caption("CV retained while application is active")
        if job.pending_category:
            st.caption(f"**{job.pending_category}** · {pending_reason(job)}")
            if job.pending_category == "SearchProfile needs review":
                st.caption("Review the Profile page to complete this user's search preferences.")
        elif job.decision.state == "not_actionable":
            decision = job.decision
            st.markdown(f"**{escape(decision.primary_reason_label)}**")
            st.caption(decision.primary_reason_detail)
            if decision.secondary_reasons:
                with st.expander("Why else?"):
                    for reason in decision.secondary_reasons:
                        st.caption(f"• {escape(reason)}")
        acceptance_fields = _listing_acceptance_fields(job)
        if acceptance_fields and not archive_view:
            st.markdown("**Needs your review**")
            st.caption("Accept this listing to continue, or archive it to dismiss it.")
            for field in acceptance_fields:
                detail = {
                    "role": job.role_reason,
                    "location": job.location_reason,
                    "employment_type": job.employment_type_reason,
                    "seniority": job.seniority_reason,
                }.get(field)
                st.caption(f"{field.replace('_', ' ').title()}: {detail or 'Please check this listing.'}")
            blockers = _listing_acceptance_blockers(job, active_profile_id=active_profile_id)
            if blockers:
                for blocker in blockers:
                    st.warning(blocker)
            has_full_jd = job.description_kind == "full" and (
                bool(job.description) if job.description_available is None else job.description_available
            )
            if not has_full_jd and can_retry_pending_evidence(job):
                if st.button("Retry evidence", key=f"accept-retry-evidence-{job.id}", disabled=card_busy):
                    _retry_pending_jobs([job], user_id=user_id)
            if not job.preference_override_fields:
                if st.button(
                    "Accept for this listing",
                    key=f"accept-pref-override-{job.id}",
                    disabled=card_busy or bool(blockers),
                ):
                    _start_preference_override_task(
                        client, user_id=user_id, job_id=job.id, fields=acceptance_fields
                    )
                    st.rerun()
        if job.preference_override_fields:
            st.caption(
                "Preference accepted for this listing: "
                + ", ".join(field.replace("_", " ") for field in job.preference_override_fields)
            )
            if not archive_view and st.button("Restore saved preferences", key=f"remove-pref-override-{job.id}", disabled=card_busy):
                _start_preference_override_task(
                    client, user_id=user_id, job_id=job.id, fields=None
                )
                st.rerun()
        if job.fit_score is not None and not (job.fit_strengths or job.fit_gaps):
            detail_key = f"fit-detail-{user_id}-{job.id}-{job.fit_assessment_id}"
            if st.button("Show Fit details", key=f"show-fit-{job.id}", disabled=card_busy):
                try:
                    from .dashboard_summary import load_assessment_detail
                    details = load_assessment_detail(
                        client, user_id=user_id, job_id=job.id, assessment_id=job.fit_assessment_id,
                    )
                    st.session_state[detail_key] = details
                except PersistenceError as exc:
                    st.error(str(exc))
            details = st.session_state.get(detail_key)
            if details:
                for label, field in (("Strengths", "fit_strengths"), ("Gaps", "fit_gaps")):
                    values = details.get(field) or []
                    if values:
                        st.markdown(f"**{label}**")
                        st.markdown("\n".join(f"- {escape(str(item))}" for item in values))
        elif job.fit_score is not None and (job.fit_strengths or job.fit_gaps):
            if job.fit_strengths:
                st.markdown("<div class='fit-reasons-label'>STRENGTHS</div>", unsafe_allow_html=True)
                st.markdown("\n".join(f"- {escape(item)}" for item in job.fit_strengths))
            if job.fit_gaps:
                st.markdown("<div class='fit-reasons-label'>GAPS</div>", unsafe_allow_html=True)
                st.markdown("\n".join(f"- {escape(item)}" for item in job.fit_gaps))
        with st.container(horizontal=True, vertical_alignment="center", gap="small"):
            if job.direct_url:
                st.link_button("Open listing", job.direct_url, width="content", type="primary", disabled=card_busy)
                if st.button(
                    ":material/edit:", key=f"edit-listing-url-{job.id}",
                    help="Edit listing URL", type="tertiary", width="content",
                    disabled=card_busy,
                ):
                    st.session_state["listing_url_job_id"] = job.id
                    st.session_state[f"listing-url-{job.id}"] = job.direct_url
                    st.rerun(scope="fragment")
            elif st.button("Add listing URL", key=f"add-link-{job.id}", disabled=card_busy):
                st.session_state["listing_url_job_id"] = job.id
                st.session_state[f"listing-url-{job.id}"] = ""
                st.rerun(scope="fragment")

        if selected_link_job_id == job.id:
            listing_url = st.text_input("Listing URL", key=f"listing-url-{job.id}", placeholder="https://...")
            link_columns = st.columns(2)
            with link_columns[0]:
                if st.button("Save link", key=f"save-link-{job.id}", disabled=card_busy):
                    try:
                        with st.spinner("Saving listing link…"):
                            save_listing_url(client, job_id=job.id, url=listing_url)
                    except (ValueError, PersistenceError) as exc:
                        st.error(str(exc))
                    else:
                        st.session_state.pop("listing_url_job_id", None)
                        _record_dashboard_lifecycle_override(
                            user_id, job.id, application_url=validate_listing_url(listing_url)
                        )
                        _refresh_listing_summary_after_action(client, user_id=user_id, job_id=job.id)
                        st.rerun(scope="fragment")
            with link_columns[1]:
                if st.button("Cancel", key=f"cancel-link-{job.id}", disabled=card_busy):
                    st.session_state.pop("listing_url_job_id", None)
                    st.session_state.pop(f"listing-url-{job.id}", None)
                    st.rerun(scope="fragment")
        if can_generate_cv(job):
            can_tailor = job.description_kind == "full" and active_profile_id is not None
            if can_tailor:
                _render_cv_controls(job, client, user_id, cv_version_id, active_profile_id, storage_bucket)
        if application_view and job.application_status:
            st.button("Interview Prep", key=f"interview-prep-{job.id}", disabled=card_busy,
                      on_click=_open_interview_prep, args=(job.id,))
        _render_lifecycle_actions(
            job, client, user_id=user_id, cv_version_id=cv_version_id,
            active_profile_id=active_profile_id, failed_fingerprints=failed_fingerprints,
            disabled=card_busy, allow_archive=not application_view, archive_view=archive_view,
            application_action_blocked=(
                application_action_blocked or job.duplicate_review_status == "pending"
            ),
        )

        if selected_job_id == job.id and job.jd_required:
            st.markdown("**Paste job description**")
            pasted = st.text_area("Job description", key=f"manual-jd-text-{job.id}", height=240, label_visibility="collapsed")
            pending_type = st.session_state.get("manual_employment_type_decision")
            if (
                isinstance(pending_type, dict)
                and pending_type.get("job_id") == job.id
                and pending_type.get("jd_sha256") == manual_jd_sha256(normalize_manual_jd(pasted))
            ):
                label = str(pending_type["employment_type"]).replace("_", " ").title()
                detection_source = "Detected in the job description" if pending_type.get("detected_in_jd") else "Detected in listing metadata"
                st.info(f"{detection_source}: **{label}**. {pending_type['reason']} Review the listing and approve this type for this job, or decline the listing.")
                decision_columns = st.columns(2)
                with decision_columns[0]:
                    if st.button(f"Approve {label} for this job", key=f"approve-employment-{job.id}", disabled=card_busy):
                        _save_and_rate(
                            job, pasted, client, user_id, cv_version_id, active_profile_id,
                            failed_fingerprints,
                            employment_type_decision={
                                "employment_type": pending_type["employment_type"],
                                "decision": "accepted",
                                "jd_sha256": pending_type["jd_sha256"],
                            },
                        )
                with decision_columns[1]:
                    if st.button("Decline listing", key=f"decline-employment-{job.id}", disabled=card_busy):
                        _save_and_rate(
                            job, pasted, client, user_id, cv_version_id, active_profile_id,
                            failed_fingerprints,
                            employment_type_decision={
                                "employment_type": pending_type["employment_type"],
                                "decision": "rejected",
                                "jd_sha256": pending_type["jd_sha256"],
                            },
                        )
            form_columns = st.columns(2)
            with form_columns[0]:
                if st.button("Save & rate", key=f"save-rate-{job.id}", disabled=card_busy):
                    _save_and_rate(job, pasted, client, user_id, cv_version_id, active_profile_id, failed_fingerprints)
            with form_columns[1]:
                if st.button("Cancel", key=f"cancel-jd-{job.id}", disabled=card_busy):
                    st.session_state.pop("manual_jd_job_id", None)
                    st.rerun(scope="fragment")


def _render_lifecycle_actions(
    job: DashboardJob,
    client: SupabaseRestClient,
    *,
    user_id: str,
    cv_version_id: int,
    active_profile_id: int | None,
    failed_fingerprints: dict[int, str],
    disabled: bool,
    allow_archive: bool = True,
    archive_view: bool = False,
    application_action_blocked: bool = False,
) -> None:
    state = job.lifecycle_status
    if state in {"hired", "rejected", "withdrawn", "no_response", "ignored", "archived"}:
        if st.button("Reopen / Restore", key=f"reopen-{job.id}", disabled=disabled):
            try:
                transition_job_lifecycle(
                    client, user_id=user_id, job_id=job.id, target="reopen",
                    has_current_fit=job.fit_score is not None,
                )
            except (PersistenceError, ValueError) as exc:
                st.error(str(exc))
            else:
                st.rerun(scope="fragment")
        return

    if state in {"applied", "interview", "offer"}:
        next_actions = {
            "applied": [("Mark interview", "interview"), ("Mark offer", "offer"), ("Mark rejected", "rejected"), ("Withdraw", "withdrawn")],
            "interview": [("Mark offer", "offer"), ("Mark rejected", "rejected"), ("Withdraw", "withdrawn")],
            "offer": [("Mark hired", "hired"), ("Mark rejected", "rejected"), ("Withdraw", "withdrawn")],
        }[state]
        columns = st.columns(2)
        for index, (label, target) in enumerate(next_actions):
            with columns[index % 2]:
                if st.button(label, key=f"lifecycle-{target}-{job.id}", disabled=disabled):
                    try:
                        with st.spinner("Updating application status…"):
                            transition_job_lifecycle(
                                client, user_id=user_id, job_id=job.id, target=target,
                                has_current_fit=job.fit_score is not None,
                            )
                    except (PersistenceError, ValueError) as exc:
                        st.error(str(exc))
                    else:
                        st.rerun(scope="fragment")
        if can_archive_state(state):
            with st.container(key=f"archive-action-{job.id}"):
                archive_clicked = st.button("Archive", key=f"archive-{job.id}", disabled=disabled)
            if archive_clicked:
                try:
                    archive_job(client, user_id=user_id, job_id=job.id, has_current_fit=job.fit_score is not None)
                except (PersistenceError, ValueError) as exc:
                    st.error(str(exc))
                else:
                    st.rerun(scope="fragment")
        return

    if job.rating_failed and can_rerate_job(job):
        if st.button("Retry rating", key=f"retry-{job.id}", disabled=disabled):
            _retry_rating(job, client, user_id, cv_version_id, active_profile_id, failed_fingerprints)
    elif job.ready_to_rate and can_rerate_job(job):
        if st.button("Rate job", key=f"rate-{job.id}", disabled=disabled):
            _retry_rating(job, client, user_id, cv_version_id, active_profile_id, failed_fingerprints)
    elif job.fit_score is not None and can_rerate_job(job):
        if st.button("Re-rate", key=f"rerate-{job.id}", disabled=disabled):
            _retry_rating(job, client, user_id, cv_version_id, active_profile_id, failed_fingerprints)
    if job.jd_required and st.button("Add JD", key=f"add-jd-{job.id}", disabled=disabled):
        st.session_state["manual_jd_job_id"] = job.id
        st.rerun(scope="fragment")
    if job.pending_category:
        pending_actions = st.columns(2)
        retry_label = None
        if job.pending_category == "Verification needed" and can_retry_pending_evidence(job):
            retry_label = "Retry verification"
        elif can_retry_pending_evidence(job):
            retry_label = "Retry evidence"
        if retry_label:
            with pending_actions[0]:
                if st.button(retry_label, key=f"pending-retry-{job.id}", disabled=disabled):
                    _retry_pending_jobs([job], user_id=user_id)
        if not archive_view and job.pending_category == "Verification needed" and job.user_verification_status is None:
            _manual_verification_control(st.container(), job, client, user_id=user_id, disabled=disabled)

    columns = st.columns([1, 1])
    if can_apply_state(state) and job.actionable and job.live_for_user:
        with columns[0]:
            st.button(
                "Mark applied",
                key=f"applied-{job.id}",
                disabled=disabled or application_action_blocked,
                on_click=_mark_applied_and_open_applications,
                args=(client,),
                kwargs={"user_id": user_id, "job_id": job.id, "cv_version_id": cv_version_id},
            )
    if allow_archive and can_archive_state(state):
        with columns[1]:
            with st.container(key=f"archive-action-{job.id}"):
                archive_clicked = st.button("Archive", key=f"archive-{job.id}", disabled=disabled)
            if archive_clicked:
                try:
                    archive_job(client, user_id=user_id, job_id=job.id, has_current_fit=job.fit_score is not None)
                except (PersistenceError, ValueError) as exc:
                    st.error(str(exc))
                else:
                    st.rerun()


def _render_metadata_field(
    job: DashboardJob,
    field: MetadataField,
    current_value: str,
    *,
    client: SupabaseRestClient,
    user_id: str,
    disabled: bool,
) -> None:
    with st.container():
        _render_metadata_field_content(
            job, field, current_value, client=client, user_id=user_id, disabled=disabled
        )


def _render_metadata_field_content(
    job: DashboardJob,
    field: MetadataField,
    current_value: str,
    *,
    client: SupabaseRestClient,
    user_id: str,
    disabled: bool,
) -> None:
    """Render one compact inline title/company editor on a job card."""

    edit_key = "job_metadata_edit"
    is_editing = st.session_state.get(edit_key) == (job.id, field)
    override_value = (job.metadata_override or {}).get(f"{field}_override")
    has_override = isinstance(override_value, str) and bool(override_value.strip())
    nonce_key = f"metadata-edit-nonce-{job.id}-{field}"
    nonce = int(st.session_state.get(nonce_key, 0))
    value_key = f"metadata-edit-value-{job.id}-{field}-{nonce}"

    if is_editing:
        with st.form(f"metadata-form-{job.id}-{field}-{nonce}"):
            st.text_input(
                "Job title" if field == "title" else "Company",
                key=value_key,
                max_chars=180 if field == "title" else 140,
                label_visibility="collapsed",
                disabled=disabled,
            )
            save, cancel = st.columns([1, 1])
            with save:
                submitted = st.form_submit_button("Save", type="primary", disabled=disabled)
            with cancel:
                canceled = st.form_submit_button("Cancel", disabled=disabled)
        if canceled:
            st.session_state.pop(edit_key, None)
            st.rerun(scope="fragment")
        if submitted:
            try:
                changed = save_job_metadata_override(
                    client,
                    user_id=user_id,
                    job_id=job.id,
                    field=field,
                    value=st.session_state.get(value_key, ""),
                    current_value=current_value,
                )
            except (PersistenceError, ValueError) as exc:
                st.error(str(exc))
            else:
                st.session_state.pop(edit_key, None)
                st.session_state["metadata_override_flash"] = (
                    f"{field.title()} saved." if changed else f"{field.title()} unchanged."
                )
                value = st.session_state.get(value_key, "").strip()
                metadata = dict(job.metadata_override or {})
                metadata[f"{field}_override"] = value
                _record_dashboard_lifecycle_override(
                    user_id, job.id,
                    **{field: value, "metadata_override": metadata},
                )
                if changed:
                    _refresh_listing_summary_after_action(client, user_id=user_id, job_id=job.id)
                st.rerun(scope="fragment")
        return

    with st.container(horizontal=True, vertical_alignment="center", gap="small"):
        if field == "title":
            st.subheader(current_value, width="content")
        else:
            st.markdown(
                f"<div class='job-company'>{escape(current_value)}</div>",
                unsafe_allow_html=True,
                width="content",
            )
        if st.button(
            ":material/edit:", key=f"edit-metadata-{job.id}-{field}",
            help=f"Edit {field}", disabled=disabled, type="tertiary",
            width="content",
        ):
            nonce += 1
            st.session_state[nonce_key] = nonce
            st.session_state[f"metadata-edit-value-{job.id}-{field}-{nonce}"] = current_value
            st.session_state[edit_key] = (job.id, field)
            st.rerun(scope="fragment")
        if has_override:
            reset_clicked = st.button(
                ":material/undo:", key=f"reset-metadata-{job.id}-{field}",
                help=f"Restore source {field}",
                disabled=disabled, type="tertiary", width="content",
            )
            if reset_clicked:
                try:
                    reset_job_metadata_override(
                        client, user_id=user_id, job_id=job.id, field=field
                    )
                except (PersistenceError, ValueError) as exc:
                    st.error(f"Could not reset {field}: {exc}")
                else:
                    metadata = dict(job.metadata_override or {})
                    metadata.pop(f"{field}_override", None)
                    _record_dashboard_lifecycle_override(
                        user_id, job.id,
                        **{field: getattr(job, f"source_{field}") or current_value,
                           "metadata_override": metadata},
                    )
                    _refresh_listing_summary_after_action(client, user_id=user_id, job_id=job.id)
                    st.session_state["metadata_override_flash"] = f"Source {field} restored."
                    st.rerun(scope="fragment")

def _fit_fingerprint_for_job(client, job, user_id, cv_version_id, profile_id, description: str) -> str:
    profiles = client.list_profiles(user_id, cv_version_id)
    candidates = [row for row in profiles if int(row["id"]) == profile_id and row.get("is_active") is True]
    if len(candidates) != 1:
        raise PersistenceError("The active CandidateProfile could not be resolved for rating status.")
    profile = CandidateProfile.model_validate(candidates[0]["profile_json"])
    verified = VerifiedJob(
        title=job.title,
        company=job.company,
        description=description,
        source_url=job.direct_url or f"manual://job/{job.id}",
        location=job.location,
        remote_scope=job.remote_scope,
    )
    return evaluation_fingerprint(
        candidate_profile=profile,
        job=verified,
        matcher_version=MATCHER_VERSION,
        model=DEFAULT_MODEL,
    )


def _hydrate_dashboard_job(
    client: SupabaseRestClient, *, user_id: str, job: DashboardJob,
    include_description: bool = False,
) -> DashboardJob:
    """Load/revalidate heavy content only for a requested card action."""
    if not job.summary_backed:
        from .dashboard_summary import load_assessment_detail

        detail = load_assessment_detail(
            client, user_id=user_id, job_id=job.id, assessment_id=job.fit_assessment_id,
            include_snapshot=True,
        )
        return replace(job, **detail)
    from .dashboard_summary import load_job_detail

    detail = load_job_detail(
        client, user_id=user_id, job_id=job.id,
        include_description=include_description,
    )
    updates: dict[str, Any] = {
        "fit_strengths": tuple(str(item) for item in detail.get("fit_strengths", []) if isinstance(item, str)),
        "fit_gaps": tuple(str(item) for item in detail.get("fit_gaps", []) if isinstance(item, str)),
        "fit_job_snapshot": detail.get("fit_job_snapshot"),
    }
    if include_description:
        updates["description"] = detail.get("description")
        updates["description_available"] = bool(detail.get("description"))
    return replace(job, **updates)


def _save_and_rate(job, pasted, client, user_id, cv_version_id, profile_id, failed_fingerprints, employment_type_decision=None) -> None:
    if profile_id is None:
        st.error("No active CandidateProfile is available for rating.")
        return
    st.session_state["busy_job_id"] = job.id
    try:
        with st.spinner("Saving JD and calculating AI Fit…"):
            result = rate_job_with_manual_jd(
                client, user_id=user_id, cv_version_id=cv_version_id,
                candidate_profile_id=profile_id, job_id=job.id, jd_text=pasted,
                employment_type_decision=employment_type_decision,
            )
    except ManualJDValidationError as exc:
        st.session_state.pop("busy_job_id", None)
        st.error(str(exc))
        return
    except ManualEmploymentTypeDecisionRequired as exc:
        st.session_state.pop("busy_job_id", None)
        st.session_state["manual_employment_type_decision"] = {
            "job_id": job.id,
            "employment_type": exc.employment_type,
            "reason": exc.reason,
            "jd_sha256": exc.jd_sha256,
            "detected_in_jd": exc.detected_in_jd,
        }
        st.rerun(scope="fragment")
    except ManualJDOperationError as exc:
        st.session_state.pop("busy_job_id", None)
        if exc.jd_saved:
            from .manual_jd import normalize_manual_jd
            try:
                failed_fingerprints[job.id] = _fit_fingerprint_for_job(
                    client, job, user_id, cv_version_id, profile_id, normalize_manual_jd(pasted)
                )
                st.session_state["fit_failed_fingerprints"] = {
                    str(key): value for key, value in failed_fingerprints.items()
                }
            except (PersistenceError, ValueError):
                pass
            st.session_state.pop("manual_jd_job_id", None)
            st.session_state["manual_jd_flash"] = str(exc)
            st.rerun(scope="fragment")
        st.error(str(exc))
        return
    except PersistenceError as exc:
        st.session_state.pop("busy_job_id", None)
        st.error(str(exc))
        return
    finally:
        st.session_state.pop("busy_job_id", None)
    if result.get("declined"):
        st.session_state.pop("manual_employment_type_decision", None)
        st.session_state.pop("manual_jd_job_id", None)
        st.session_state["employment_type_decision_flash"] = "Listing declined. No JD or Fit assessment was saved."
        _refresh_listing_summary_after_action(client, user_id=user_id, job_id=job.id)
        st.rerun(scope="fragment")
    failed_fingerprints.pop(job.id, None)
    st.session_state["fit_failed_fingerprints"] = {str(key): value for key, value in failed_fingerprints.items()}
    st.session_state.pop("manual_jd_job_id", None)
    st.session_state.pop("manual_employment_type_decision", None)
    from .manual_jd import normalize_manual_jd

    _record_dashboard_lifecycle_override(
        user_id, job.id,
        description=normalize_manual_jd(pasted),
        _expected_fit_fingerprint=job.fit_fingerprint,
        _expected_profile_id=profile_id,
        description_kind="full",
        fit_score=int(result["fit_score"]),
        fit_assessment_id=(int(result["fit_assessment_id"]) if result.get("fit_assessment_id") else job.fit_assessment_id),
        fit_fingerprint=result.get("fit_fingerprint") or job.fit_fingerprint,
        fit_strengths=tuple(result.get("strengths", [])),
        fit_gaps=tuple(result.get("gaps", [])),
        fit_attempt_failed=False,
        review_status="rated",
    )
    _refresh_listing_summary_after_action(client, user_id=user_id, job_id=job.id)
    st.rerun(scope="fragment")


def _retry_rating(job, client, user_id, cv_version_id, profile_id, failed_fingerprints) -> None:
    if profile_id is None or not can_rerate_job(job):
        st.error("The saved full JD or active CandidateProfile is unavailable.")
        return
    st.session_state["busy_job_id"] = job.id
    try:
        job = _hydrate_dashboard_job(client, user_id=user_id, job=job, include_description=True)
        if not job.description:
            raise PersistenceError("The verified job description is unavailable for rating.")
        with st.spinner("Retrying AI Fit…"):
            result = rate_job_with_manual_jd(client, user_id=user_id, cv_version_id=cv_version_id, candidate_profile_id=profile_id, job_id=job.id, jd_text=job.description)
    except ManualJDOperationError as exc:
        if job.fit_fingerprint:
            failed_fingerprints[job.id] = job.fit_fingerprint
            st.session_state["fit_failed_fingerprints"] = {
                str(key): value for key, value in failed_fingerprints.items()
            }
        st.error(str(exc))
        return
    except ManualJDValidationError as exc:
        st.error(str(exc))
        return
    except PersistenceError as exc:
        st.error(str(exc))
        return
    finally:
        st.session_state.pop("busy_job_id", None)
    failed_fingerprints.pop(job.id, None)
    st.session_state["fit_failed_fingerprints"] = {str(key): value for key, value in failed_fingerprints.items()}
    _record_dashboard_lifecycle_override(
        user_id,
        job.id,
        _expected_fit_fingerprint=job.fit_fingerprint,
        _expected_profile_id=profile_id,
        fit_score=int(result["fit_score"]),
        fit_assessment_id=(int(result["fit_assessment_id"]) if result.get("fit_assessment_id") else job.fit_assessment_id),
        fit_fingerprint=result.get("fit_fingerprint") or job.fit_fingerprint,
        fit_strengths=tuple(result.get("strengths", [])),
        fit_gaps=tuple(result.get("gaps", [])),
        fit_attempt_failed=False,
        review_status="rated",
    )
    # Changing Fit changes the card's dashboard group, so refresh the cached
    # dashboard view; the session override supplies the new score immediately.
    st.rerun(scope="fragment")


def _pending_result_summary(result: dict[str, Any]) -> str:
    rows = result.get("jobs", [])
    total = len(rows)
    active = sum(row.get("availability") == "active" for row in rows)
    expired = sum(row.get("availability") == "expired" for row in rows)
    unresolved = total - active - expired
    incompatible = sum(
        row.get("availability") == "active" and isinstance(row.get("eligibility"), dict)
        and (
            row["eligibility"].get("role") in {"unrelated", "excluded"}
            or any(row["eligibility"].get(key) == "ineligible" for key in ("location", "language", "employment_type", "seniority"))
        )
        for row in rows
    )
    if total == 1:
        if expired:
            return "Listing confirmed expired. It has been removed from Pending."
        if active:
            if incompatible:
                return "Verified live, but incompatible with the active SearchProfile. It remains in history."
            if isinstance(rows[0].get("eligibility"), dict) and rows[0]["eligibility"].get("actionable") is False:
                return "Verified live; the SearchProfile eligibility evidence is still unresolved."
            return "Verified live; eligibility and JD state were refreshed."
        return "Not verified automatically. Open the listing to check whether the exact requisition is still live."
    return f"{total} checked · {active} verified live · {expired} expired · {incompatible} ineligible · {unresolved} still unresolved."


def _retry_pending_jobs(jobs: list[DashboardJob], *, user_id: str, bulk: bool = False) -> None:
    if not jobs or any(not can_retry_pending_evidence(job) for job in jobs):
        st.error("This selection is no longer eligible for a retry. Refresh the dashboard and try again.")
        return
    st.session_state["busy_job_id"] = "pending-review"
    try:
        with st.spinner(f"Checking {len(jobs)} listing{'s' if len(jobs) != 1 else ''} and refreshing available evidence…"):
            result = run_pending_evidence_retry([job.id for job in jobs], user_id=user_id)
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        message = str(exc) if isinstance(exc, RuntimeError) else "The verification/evidence workflow could not complete."
        st.error(f"{message} No Fit evaluation was started.")
        return
    finally:
        st.session_state.pop("busy_job_id", None)
    if bulk:
        attempted = {int(value) for value in st.session_state.get("pending_bulk_attempted_ids", []) if str(value).isdigit()}
        attempted.update(job.id for job in jobs)
        st.session_state["pending_bulk_attempted_ids"] = sorted(attempted)
    st.session_state["pending_retry_flash"] = _pending_result_summary(result)
    st.rerun()


def _render_pending_bulk_actions(jobs: list[DashboardJob], *, user_id: str) -> None:
    attempted = {int(value) for value in st.session_state.get("pending_bulk_attempted_ids", []) if str(value).isdigit()}
    verification, evidence = pending_retry_cohorts(jobs, attempted)
    skipped = len([job for job in jobs if job.id in attempted])
    if not verification and not evidence:
        if skipped:
            st.info(f"All {skipped} retryable visible jobs have already been checked in this session.")
        return
    st.markdown("#### Resolve visible jobs")
    st.caption(f"Retries use the existing liveness and JD-evidence pipeline. Maximum 25 per action; no AI Fit runs. {skipped} already checked this session.")
    columns = st.columns(2)
    for column, label, cohort in (
        (columns[0], "Retry verification", verification),
        (columns[1], "Retry evidence", evidence),
    ):
        if not cohort:
            continue
        selected = sort_dashboard_jobs(cohort)[:MAX_PENDING_RETRY_BATCH]
        scope = f"{len(selected)} of {len(cohort)} visible" if len(cohort) > len(selected) else f"{len(selected)} visible"
        with column:
            st.caption(scope)
            if st.button(f"{label} ({len(selected)})", key=f"bulk-{label}", disabled=bool(st.session_state.get("busy_job_id"))):
                _retry_pending_jobs(selected, user_id=user_id, bulk=True)


def _render_bulk_actions(
    jobs: list[DashboardJob],
    *,
    client: SupabaseRestClient,
    user_id: str,
    cv_version_id: int,
    active_profile_id: int | None,
) -> None:
    selected = [
        job.id for job in jobs
        if can_select_job(job) and st.session_state.get(f"archive-select-{job.id}", False)
    ]
    st.caption("Select listings on their cards, then choose an action.")
    archive_column, rate_column, update_column = st.columns([1, 1, 0.8])
    operation_busy = bool(
        st.session_state.get("busy_job_id")
        or st.session_state.get("tailored_cv_busy_job_id")
        or st.session_state.get("bulk_archive_task")
        or st.session_state.get("bulk_rating_task")
    )
    with archive_column:
        with st.container(key="archive-action-selected"):
            archive_clicked = st.button("Archive selected", key="archive-selected-jobs", disabled=operation_busy)
    with rate_column:
        rate_clicked = st.button("Rate selected", key="rate-selected-jobs", disabled=operation_busy)
    with update_column:
        update_clicked = st.button(
            "Update view",
            key="update-dashboard-view",
            icon=":material/refresh:",
            help="Apply completed archive/rating results and load changed listings.",
            type="primary" if st.session_state.get("dashboard_pending_refresh_count") or st.session_state.get("bulk_archive_result") or st.session_state.get("bulk_rating_result") else "secondary",
            disabled=operation_busy,
        )
    if update_clicked:
        batch_updated = _apply_bulk_rating_result(user_id)
        archive_task = st.session_state.get("bulk_archive_task")
        if archive_task:
            if archive_task["future"].done():
                st.session_state["bulk_archive_result"] = _collect_bulk_archive_result(user_id, archive_task)
                st.session_state.pop("bulk_archive_task", None)
                batch_updated = _finish_bulk_archive_ui() or batch_updated
            else:
                st.toast("The archive batch is still running.")
                return
        batch_updated = _finish_bulk_archive_ui() or batch_updated
        try:
            with st.spinner("Checking for changed listings…", show_time=False):
                updated_count = sync_dashboard_context(client, user_id)
        except PersistenceError as exc:
            st.error(str(exc))
            return
        st.session_state.pop("dashboard_pending_refresh_count", None)
        st.session_state.get("dashboard_background_checks", {}).get((client.base_url, user_id), {}).pop("error", None)
        if updated_count:
            st.toast(f"Updated {updated_count} changed listing{'s' if updated_count != 1 else ''}.")
        else:
            if not batch_updated:
                st.toast("Everything is up to date.")
        st.rerun(scope="fragment")
    if not archive_clicked and not rate_clicked:
        return
    if not selected:
        st.info("Select at least one listing first.")
        return

    selected_jobs = [job for job in jobs if job.id in selected]
    if archive_clicked:
        archiveable_jobs = [job for job in selected_jobs if can_archive_job(job)]
        if not archiveable_jobs:
            st.info("None of the selected listings can be archived from their current state.")
            return
        start_bulk_archive(client, user_id=user_id, jobs=archiveable_jobs)
        st.rerun(scope="fragment")
    else:
        rateable = [job for job in selected_jobs if can_rate_job(job)]
        if not rateable:
            st.info("None of the selected listings has a verified full JD ready to rate.")
            return
        failed_fingerprints: dict[int, str] = {
            int(job_id): str(fingerprint)
            for job_id, fingerprint in st.session_state.get("fit_failed_fingerprints", {}).items()
            if str(job_id).isdigit() and isinstance(fingerprint, str)
        }
        start_bulk_rating(
            rateable,
            client,
            user_id=user_id,
            cv_version_id=cv_version_id,
            candidate_profile_id=active_profile_id,
            failed_fingerprints=failed_fingerprints,
        )
    st.rerun(scope="fragment")


def _render_section_selection(label: str, jobs: list[DashboardJob]) -> None:
    selectable = [job for job in jobs if can_select_job(job) and not _job_operation_busy(job.id)]
    if not selectable:
        return
    job_ids = [job.id for job in selectable]
    state_key = f"select-all-{label}"
    st.session_state[state_key] = all(
        bool(st.session_state.get(f"archive-select-{job_id}", False)) for job_id in job_ids
    )
    st.checkbox(
        f"Select all in {label}",
        key=state_key,
        on_change=_select_section_jobs,
        args=(job_ids, state_key),
    )
    with st.expander(f"Select individual listings in {label}"):
        for job in selectable:
            st.checkbox(
                f"{job.company} — {job.title}",
                key=f"archive-select-{job.id}",
                on_change=_sync_section_selection,
                args=(job_ids, state_key),
            )


def _generate_cv(
    job: DashboardJob, client, user_id: str, cv_version_id: int,
    profile_id: int | None, storage_bucket: str, *, force: bool,
) -> None:
    if profile_id is None or not can_generate_cv(job) or job.description_kind != "full":
        st.error("A full verified JD and active CandidateProfile are required.")
        return
    try:
        job = _hydrate_dashboard_job(client, user_id=user_id, job=job, include_description=True)
    except PersistenceError as exc:
        st.error(str(exc))
        return
    if not job.description:
        st.error("The verified job description is unavailable.")
        return
    tasks = st.session_state.setdefault("tailored_cv_tasks", {})
    key = (user_id, job.id)
    if key in tasks:
        return
    st.session_state.setdefault("tailored_cv_errors", {}).pop(key, None)
    tasks[key] = {
        "future": _CV_EXECUTOR.submit(
            generate_or_reuse_tailored_cv,
            client,
            user_id=user_id,
            cv_version_id=cv_version_id,
            candidate_profile_id=profile_id,
            job_id=job.id,
            title=job.title,
            company=job.company,
            description=job.description,
            source_url=job.direct_url,
            location=job.location,
            remote_scope=job.remote_scope,
            force_regenerate=force,
        ),
    }


def _collect_cv_task(user_id: str, job_id: int, storage_bucket: str) -> bool:
    """Only the UI thread updates session state; workers return ordinary data."""
    tasks = st.session_state.get("tailored_cv_tasks", {})
    key = (user_id, job_id)
    task = tasks.get(key)
    if task is None or not task["future"].done():
        return False
    try:
        result = task["future"].result()
    except Exception as exc:
        message = str(exc) if isinstance(exc, (TailoredCVError, PersistenceError)) else "Generation could not complete. Please retry."
        st.session_state.setdefault("tailored_cv_errors", {})[key] = message
        return False
    finally:
        tasks.pop(key, None)
    tailored = result["row"]
    _record_dashboard_lifecycle_override(
        user_id, job_id,
        tailored_cv_id=int(tailored["id"]),
        tailored_cv_bucket=str(tailored.get("storage_bucket") or storage_bucket),
        tailored_tex_path=tailored.get("tex_file_path"),
        tailored_pdf_path=tailored.get("pdf_file_path"),
        tailored_expires_at=tailored.get("expires_at"),
        tailored_artifacts_deleted_at=tailored.get("artifacts_deleted_at"),
    )
    return True


@st.fragment
def _render_cv_controls(job, client, user_id, cv_version_id, profile_id, storage_bucket):
    # Only a card with a submitted task needs a polling fragment.
    if (user_id, job.id) in st.session_state.get("tailored_cv_tasks", {}):
        _poll_cv_controls(job, client, user_id, cv_version_id, profile_id, storage_bucket)
    else:
        _render_cv_actions(job, client, user_id, cv_version_id, profile_id, storage_bucket)


@st.fragment(run_every="2s")
def _poll_cv_controls(job, client, user_id, cv_version_id, profile_id, storage_bucket):
    if _collect_cv_task(user_id, job.id, storage_bucket):
        st.toast(f"CV ready: {job.company} - {job.title}")
    _render_cv_actions(job, client, user_id, cv_version_id, profile_id, storage_bucket)


def _render_cv_actions(job, client, user_id, cv_version_id, profile_id, storage_bucket):
    key = (user_id, job.id)
    if key in st.session_state.get("tailored_cv_tasks", {}):
        st.button("Generating CV...", key=f"cv-progress-{job.id}", disabled=True)
        return
    job = replace(job, **_dashboard_job_overrides(user_id, job.id, job=job))
    error = st.session_state.get("tailored_cv_errors", {}).get(key)
    if error:
        st.error(f"Tailored CV generation failed: {error}")
    busy = _job_operation_busy(job.id)
    if job.tailored_pdf_path:
        try:
            # Retain bytes for this immutable path, avoiding Storage reads on polls.
            pdfs = st.session_state.setdefault("tailored_cv_downloads", {})
            pdf_key = (user_id, job.tailored_cv_bucket or storage_bucket, job.tailored_pdf_path)
            if pdf_key not in pdfs:
                pdfs[pdf_key] = _download_tailored_pdf_cached(client, pdf_key[1], pdf_key[2], user_id)
            with st.popover("Download CV ▾", help="Download or manage this tailored CV", use_container_width=True, disabled=busy):
                st.download_button(
                    "Download CV", data=pdfs[pdf_key], mime="application/pdf",
                    file_name=job_pdf_filename(job.company, job.title),
                    key=f"download-cv-{job.id}-{job.tailored_cv_id}", disabled=busy,
                    use_container_width=True, on_click="ignore",
                )
                st.button(
                    "Regenerate", key=f"regenerate-cv-{job.id}", disabled=busy,
                    use_container_width=True, on_click=_generate_cv,
                    args=(job, client, user_id, cv_version_id, profile_id, storage_bucket),
                    kwargs={"force": True},
                )
                st.link_button("View diff", f"?view=cv_diff&cv_version_id={job.tailored_cv_id}", disabled=busy, use_container_width=True)
        except PersistenceError as exc:
            st.error(f"Tailored CV download failed: {exc}")
    else:
        st.button(
            "Generate CV", key=f"generate-cv-{job.id}", disabled=busy,
            on_click=_generate_cv,
            args=(job, client, user_id, cv_version_id, profile_id, storage_bucket),
            kwargs={"force": False},
        )


def _gap_analysis_error_message(exc: Exception) -> str:
    from openai import APIConnectionError, APIStatusError, APITimeoutError

    if isinstance(exc, APITimeoutError):
        return "The AI service timed out. Please retry."
    if isinstance(exc, APIConnectionError):
        return "The server could not connect to the AI service. Check its network connection and retry."
    if isinstance(exc, APIStatusError):
        return f"The AI service returned HTTP {exc.status_code}. Please retry later."
    if isinstance(exc, ValueError):
        return str(exc)
    if isinstance(exc, PersistenceError):
        return "The gap results could not be saved. Please retry."
    return "An unexpected error occurred. Please retry."


@st.cache_data(max_entries=16, show_spinner=False)
def _load_gap_analytics_data_cached(
    _client: SupabaseRestClient, user_id: str, project_url: str, data_revision: int | tuple[int, int]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    profiles = load_candidate_profile_options(_client, user_id=user_id)
    profile_ids = sorted({profile.id for profile in profiles})
    if not profile_ids:
        return [_cache_plain_data(item) for item in profiles], [], []
    labels = {profile.id: profile.label for profile in profiles}
    jobs = load_gap_assessments(
        _client, user_id=user_id, candidate_profile_ids=profile_ids, profile_labels=labels
    )
    mappings = load_gap_mappings(_client, user_id=user_id, candidate_profile_ids=profile_ids)
    return (
        [_cache_plain_data(item) for item in profiles],
        [_cache_plain_data(item) for item in jobs],
        [_cache_plain_data(item) for item in mappings],
    )


def _cache_plain_data(value: Any) -> Any:
    """Keep Streamlit cache payloads independent of hot-reloaded Python classes."""
    if is_dataclass(value):
        return _cache_plain_data(asdict(value))
    if isinstance(value, dict):
        return {key: _cache_plain_data(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_cache_plain_data(item) for item in value]
    if hasattr(value, "__dict__"):
        return _cache_plain_data(vars(value))
    return value


def _load_gap_analytics_data(
    client: SupabaseRestClient, user_id: str, project_url: str, data_revision: int | tuple[int, int]
) -> tuple[list[CandidateProfileOption], list[GapAssessment], list[dict[str, Any]]]:
    profiles, jobs, mappings = _load_gap_analytics_data_cached(client, user_id, project_url, data_revision)
    return (
        [CandidateProfileOption(
            id=int(row["id"]), cv_version_id=int(row.get("cv_version_id", 0)),
            label=str(row.get("label") or "CandidateProfile"), is_current=bool(row.get("is_current", False)),
        ) for row in profiles],
        [GapAssessment(**{**row, "fit_gaps": tuple(row.get("fit_gaps", ()))}) for row in jobs],
        mappings,
    )


def _gap_plan_cache_key(
    *, user_id: str, candidate_profile_id: int | None, category: Any,
) -> str:
    examples = [
        {"title": item.title, "text": item.text}
        for item in getattr(category, "examples", ())[:8]
    ]
    identity = json.dumps(
        {
            "version": GAP_IMPROVEMENT_VERSION,
            "user_id": user_id,
            "candidate_profile_id": candidate_profile_id,
            "category": category.category,
            "description": category.description,
            "examples": examples,
        },
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _render_gap_analytics(
    client: SupabaseRestClient,
    *,
    user_id: str,
) -> None:
    st.subheader("Top recurring gaps")
    try:
        profiles, gap_jobs, mappings = _load_gap_analytics_data(
            client, user_id, getattr(client, "base_url", ""), (supabase_data_revision(), supabase_card_revision())
        )
    except PersistenceError as exc:
        st.error(f"Recurring gap data could not be loaded. ({exc})")
        return
    if not profiles:
        st.info("No recurring gaps to show yet.")
        return

    selected_ids = sorted({profile.id for profile in profiles})
    analytics = calculate_gap_analytics(gap_jobs, mappings)
    if flash := st.session_state.pop("gap_analysis_flash", None):
        st.success(
            f"Analyzed {flash['analyzed']} new gap(s) and prepared {flash['plans']} improvement plan(s)."
            if flash.get("plans") is not None
            else (f"Analyzed {flash['analyzed']} new gap(s)." if flash["analyzed"] else "Gap analysis is up to date.")
        )
    if st.button("Analyze gaps", key="analyze-existing-gaps"):
        current_profiles = [profile for profile in profiles if profile.is_current]
        if len(current_profiles) != 1:
            st.error("A single active CandidateProfile is required to build personalized gap plans.")
        else:
            current_profile_id = current_profiles[0].id
            st.session_state["busy_job_id"] = "gap-analysis"
            try:
                with st.spinner("Analyzing gaps and preparing improvement plans…"):
                    profile_rows = client.get_json("/rest/v1/candidate_profiles?" + urlencode({
                        "select": "id,user_id,profile_json",
                        "user_id": f"eq.{user_id}",
                        "id": f"eq.{current_profile_id}",
                        "limit": "2",
                    }))
                    if (
                        not isinstance(profile_rows, list) or len(profile_rows) != 1
                        or str(profile_rows[0].get("user_id")) != user_id
                    ):
                        raise PersistenceError("The active CandidateProfile could not be loaded for gap recommendations.")
                    current_profile = CandidateProfile.model_validate(profile_rows[0].get("profile_json"))
                    candidate_evidence = candidate_improvement_evidence(current_profile)
                    result = (
                        analyze_unmapped_gaps(
                            client,
                            user_id=user_id,
                            candidate_profile_ids=selected_ids,
                            jobs=gap_jobs,
                        )
                        if analytics["pending_gaps"] else {"analyzed": 0}
                    )
                    if analytics["pending_gaps"]:
                        mappings = load_gap_mappings(
                            client, user_id=user_id, candidate_profile_ids=selected_ids
                        )
                        analytics = calculate_gap_analytics(gap_jobs, mappings)
                    categories = analytics["top_categories"]
                    plans_by_category = recommend_gap_improvement_plans(
                        categories=[
                            {
                                "normalized_key": category.normalized_key,
                                "category": category.category,
                                "description": category.description,
                                "percentage": category.percentage,
                                "examples": [
                                    {"title": item.title, "text": item.text}
                                    for item in category.examples[:8]
                                ],
                            }
                            for category in categories
                        ],
                        candidate_evidence=candidate_evidence,
                    )
                    saved_plans = st.session_state.setdefault("gap_improvement_plans", {})
                    for category in categories:
                        saved_plans[_gap_plan_cache_key(
                            user_id=user_id,
                            candidate_profile_id=current_profile_id,
                            category=category,
                        )] = plans_by_category[category.normalized_key].model_dump(mode="json")
                    result["plans"] = len(plans_by_category)
            except Exception as exc:
                st.error(f"Gap analysis failed: {_gap_analysis_error_message(exc)}")
            else:
                st.session_state["gap_analysis_flash"] = result
                st.rerun(scope="fragment")
            finally:
                st.session_state.pop("busy_job_id", None)
    categories = analytics["top_categories"]
    if not categories:
        st.info("No recurring gaps to show yet.")
        return
    for category in categories:
        percentage = max(0.0, min(float(category.percentage), 100.0))
        label = f"{percentage:g}%"
        plan_key = _gap_plan_cache_key(
            user_id=user_id,
            candidate_profile_id=next((profile.id for profile in profiles if profile.is_current), None),
            category=category,
        )
        with st.expander(f"{category.category} · {label}", expanded=False):
            st.markdown(
                f'<div class="gap-item-meter" role="progressbar" aria-label="{escape(category.category, quote=True)}" '
                f'aria-valuemin="0" aria-valuemax="100" aria-valuenow="{percentage:g}">'
                f'<div class="gap-item-meter-fill" style="width: {label}"></div></div>',
                unsafe_allow_html=True,
            )
            if category.description:
                st.caption(category.description)
            saved_plans = st.session_state.setdefault("gap_improvement_plans", {})
            plan_payload = saved_plans.get(plan_key)
            if plan_payload is None:
                st.caption("Select Analyze gaps above to prepare an improvement plan.")
            else:
                st.markdown(f"**Plan**\n\n{plan_payload['overview']}")
                for heading, field in (
                    ("Hands-on experience", "hands_on_experience"),
                    ("Learning", "learning"),
                    ("Optional certifications", "certifications"),
                    ("Evidence to build", "evidence_to_build"),
                ):
                    items = plan_payload.get(field) or []
                    if items:
                        st.markdown(f"**{heading}**")
                        for item in items:
                            st.markdown(f"- {item}")


def render_dashboard(
    jobs: list[DashboardJob],
    active_profile_id: int | None,
    client: SupabaseRestClient,
    *,
    user_id: str,
    cv_version_id: int,
    storage_bucket: str,
    page_info=None,
) -> None:
    _poll_bulk_rating_task()
    _poll_bulk_archive_task(user_id)
    _render_dashboard_change_notice(client, user_id=user_id)
    _render_dashboard_body(
        jobs, active_profile_id, client, user_id=user_id,
        cv_version_id=cv_version_id, storage_bucket=storage_bucket, page_info=page_info,
    )


def _check_dashboard_changes(client, user_id, cursor, profile_id, cv_id):
    state = {}
    ids, global_change = _changed_job_ids_since(client, user_id, cursor, ui_state=state)
    cv = client.resolve_active_base_cv(user_id)
    profiles = [row for row in client.list_profiles(user_id, cv.id) if row.get("is_active") is True]
    active_id = int(profiles[0]["id"]) if len(profiles) == 1 else None
    global_change = global_change or cv.id != cv_id or active_id != profile_id
    jobs = _load_dashboard_context_rows(client, user_id, job_ids=ids, ui_state=state)[0] if ids and not global_change else []
    return jobs, global_change, state


@st.fragment(run_every="2s")
def _render_dashboard_change_notice(client: SupabaseRestClient, *, user_id: str) -> None:
    """Check for changes in a worker; navigating never waits for remote reads."""
    if _poll_preference_override_tasks(user_id):
        st.rerun(scope="app")
    checks = st.session_state.setdefault("dashboard_background_checks", {})
    key = (getattr(client, "base_url", ""), user_id)
    entry = checks.setdefault(key, {"future": None, "next_check": 0})
    future = entry["future"]
    if future is not None and future.done():
        try:
            jobs, global_change, flags = future.result()
            st.session_state.update(flags)
            current = {job.id: job for job in (get_dashboard_jobs_snapshot(user_id) or [])}
            changed_count = max(sum(current.get(job.id) != job for job in jobs), int(global_change))
            if changed_count:
                st.session_state["dashboard_pending_refresh_count"] = changed_count
            entry.pop("error", None)
        except Exception:
            entry["error"] = True
        entry["future"] = None
    if entry["future"] is None and time.monotonic() >= entry["next_check"]:
        context = get_dashboard_context_snapshot(user_id)
        cursor = st.session_state.get("dashboard_change_cursor_by_user", {}).get(user_id)
        if context is not None and cursor:
            entry["future"] = _CHANGE_EXECUTOR.submit(_check_dashboard_changes, client, user_id, cursor, context[1], context[3])
        entry["next_check"] = time.monotonic() + 60
    if entry.get("error"):
        st.warning("Automatic change checks failed. Your current cards are unchanged. Use Update view beside Rate selected to retry.")
    if st.session_state.get("dashboard_jobs_timestamp_unavailable"):
        st.caption("Job-content change checks need the pending timestamp migration. Application and rating checks remain active.")
    count = st.session_state.get("dashboard_pending_refresh_count", 0)
    if not count:
        return
    with st.container(key="dashboard-change-notice"):
        st.caption(f"{count} listing{'s have' if count != 1 else ' has'} changed since this view was loaded. Click Update view beside Rate selected.")


def _set_archive_page(page: int) -> None:
    st.session_state["archive_page"] = page


def _set_server_dashboard_page(key: str, page: int) -> None:
    st.session_state[key] = max(1, int(page))


def _set_dashboard_summary_pending_page(page: int) -> None:
    st.session_state["dashboard_summary_pending_page"] = max(1, int(page))


def _render_server_page_navigation(page_info, session_key: str) -> None:
    if page_info.total_count <= page_info.page_size:
        return
    total_pages = max(1, (page_info.total_count + page_info.page_size - 1) // page_info.page_size)
    page = page_info.page
    st.caption(
        f"Showing {(page - 1) * page_info.page_size + 1}–"
        f"{min(page * page_info.page_size, page_info.total_count)} of {page_info.total_count} listings"
    )
    left, center, right = st.columns([1, 2, 1])
    with left:
        st.button("← Previous", key=f"{session_key}-previous", disabled=page <= 1,
                  on_click=_set_server_dashboard_page, args=(session_key, page - 1))
    with center:
        st.caption(f"Page {page} of {total_pages}")
    with right:
        st.button("Next →", key=f"{session_key}-next", disabled=page >= total_pages,
                  on_click=_set_server_dashboard_page, args=(session_key, page + 1))


def _archive_page_numbers(page: int, page_count: int) -> list[int | None]:
    if page_count <= 7:
        return list(range(1, page_count + 1))
    if page <= 4:
        return [1, 2, 3, 4, 5, None, page_count]
    if page >= page_count - 3:
        return [1, None, page_count - 4, page_count - 3, page_count - 2, page_count - 1, page_count]
    return [1, None, page - 1, page, page + 1, None, page_count]


@st.fragment
def _render_dashboard_body(
    jobs: list[DashboardJob],
    active_profile_id: int | None,
    client: SupabaseRestClient,
    *,
    user_id: str,
    cv_version_id: int,
    storage_bucket: str,
    page_info=None,
) -> None:
    snapshot = None if page_info is not None else get_dashboard_jobs_snapshot(user_id)
    if snapshot is not None:
        jobs = snapshot
    jobs = [replace(job, **_dashboard_job_overrides(user_id, job.id, job=job)) for job in jobs]
    st.title("PairRole")
    with st.container():
        if st.session_state.get("bulk_rating_task") or st.session_state.get("bulk_rating_result"):
            _render_bulk_rating_status(user_id)
        elif task := st.session_state.get("bulk_archive_task"):
            st.caption(f"Archiving {len(task['job_ids'])} selected listing(s)…")
        elif result := st.session_state.get("bulk_archive_result"):
            st.caption(f"Archive complete · {result['archived']} moved · {len(result['failed'])} failed. Click Update view beside Rate selected.")
        else:
            st.session_state.pop("dashboard_data_refresh_notice", None)
    _post_it_styles()
    if flash := st.session_state.pop("metadata_override_flash", None):
        st.success(flash)
    if active_profile_id is None:
        st.info("No active CandidateProfile is available. Jobs requiring a JD cannot be rated.")
    if flash := st.session_state.pop("manual_jd_flash", None):
        st.error(flash)
    if flash := st.session_state.pop("employment_type_decision_flash", None):
        st.info(flash)
    if flash := st.session_state.pop("application_action_error", None):
        st.error(f"Could not update the application: {flash}")
    if flash := st.session_state.pop("pending_retry_flash", None):
        st.success(flash)
    if flash := st.session_state.pop("bulk_archive_flash", None):
        if flash["archived"]:
            st.success(f"{flash['archived']} listing{'s' if flash['archived'] != 1 else ''} moved to Archive.")
        if flash["failed"]:
            st.warning(f"{flash['failed']} listing{'s' if flash['failed'] != 1 else ''} could not be archived and remain visible. You can retry them.")
    if flash := st.session_state.pop("bulk_rate_flash", None):
        if flash["rated"]:
            st.success(f"{flash['rated']} listing{'s' if flash['rated'] != 1 else ''} rated. {flash['cache_hits']} reused cached Fit results.")
        for company, title, reason in flash["failed"]:
            st.error(f"{company} — {title}: {reason}")
    for (error_user_id, job_id), message in list(st.session_state.get("preference_override_errors", {}).items()):
        if error_user_id == user_id:
            st.warning(f"Listing {job_id}: its preference may be saved, but its summary needs rebuilding. {message}")
    if archive_result := st.session_state.get("bulk_archive_result"):
        if archive_result["failed"]:
            with st.expander("Listings that could not be archived"):
                for job_id, reason in archive_result["failed"]:
                    st.caption(f"Listing {job_id}: {reason}")
    if st.session_state.get("manual_verification_unavailable"):
        st.info("Manual verification needs the latest Supabase migration before it can be saved.")
    if st.session_state.get("dashboard_section") not in {"Jobs", "Archive"}:
        st.session_state["dashboard_section"] = "Jobs"
    section = st.radio(
        "Jobs section", ["Jobs", "Archive"], horizontal=True,
        key="dashboard_section", label_visibility="collapsed",
    )
    archive_pagination: tuple[int, int, int, int] | None = None
    if section == "Jobs":
        _initialize_dashboard_status()
        controls = st.columns([1, 2])
        with controls[0]:
            status_filter = st.selectbox(
                "Show", ["Needs attention", "Ready to rate", "Rated"], key="dashboard_status"
            )
        fit_state = "All"
        with controls[1]:
            search = st.text_input(
                "Search", placeholder="Company or title", key="dashboard_search", live=True
            )
        if page_info is not None:
            filter_signature = ("Jobs", status_filter, fit_state, search.strip().casefold())
            if st.session_state.get("dashboard_body_page_signature") != filter_signature:
                st.session_state["dashboard_body_page_signature"] = filter_signature
                st.session_state["dashboard_page"] = 1
            query_view = "Needs attention" if status_filter == "Ready to rate" else status_filter
            query_score_state = "Ready to rate" if status_filter == "Ready to rate" else fit_state
            requested = {
                **page_info.filters,
                "view": query_view,
                "score_state": {"Has Fit score": "Scored"}.get(query_score_state, query_score_state),
                "search": search,
                "archive_category": "All",
                "work_model": "All",
                "page": int(st.session_state.get("dashboard_page", 1)),
                "pending_page": int(st.session_state.get("dashboard_summary_pending_page", 1)),
            }
            if any(page_info.filters.get(key) != value for key, value in requested.items()):
                from .dashboard_summary import fetch_dashboard_page
                page_info = fetch_dashboard_page(client, user_id=user_id, filters=requested)
                jobs = page_info.jobs
            visible = jobs
            if page_info.pending_count:
                st.warning(f"{page_info.pending_count} listing summaries are updating. Results may be incomplete until the background builder finishes.")
                if page_info.pending_duplicate_count:
                    st.caption(f"{page_info.pending_duplicate_count} listings with prior application history are still being checked. Mark applied is temporarily disabled until this safety check completes.")
                if page_info.pending_preview:
                    with st.expander(f"Inspect updating listings · showing {len(page_info.pending_preview)} of {page_info.pending_count}"):
                        for item in page_info.pending_preview:
                            st.caption(f"{item.get('company') or 'Unknown company'} — {item.get('title') or 'Untitled'}")
                        if page_info.pending_preview_pages > 1:
                            left, center, right = st.columns([1, 2, 1])
                            with left:
                                st.button("← Previous", key="summary-pending-previous",
                                          disabled=page_info.pending_preview_page <= 1,
                                          on_click=_set_dashboard_summary_pending_page,
                                          args=(page_info.pending_preview_page - 1,))
                            with center:
                                st.caption(f"Page {page_info.pending_preview_page} of {page_info.pending_preview_pages}")
                            with right:
                                st.button("Next →", key="summary-pending-next",
                                          disabled=page_info.pending_preview_page >= page_info.pending_preview_pages,
                                          on_click=_set_dashboard_summary_pending_page,
                                          args=(page_info.pending_preview_page + 1,))
            _render_server_page_navigation(page_info, "dashboard_page")
        else:
            local_view = status_filter
            local_score_state = "Ready to rate" if status_filter == "Ready to rate" else fit_state
            visible = filter_dashboard_jobs(
                jobs, search=search, review_status=local_view,
                score_state={"Has Fit score": "Scored"}.get(local_score_state, local_score_state),
            )
        groups = group_needs_attention_jobs(visible)
        _render_pending_bulk_actions(visible, user_id=user_id)
        st.caption(f"Rate selected eligible listings in batches of {RATE_BATCH_SIZE}; already-rated jobs are not rated again.")
        _render_bulk_actions(
            visible,
            client=client,
            user_id=user_id,
            cv_version_id=cv_version_id,
            active_profile_id=active_profile_id,
        )
    elif section == "Archive":
        controls = st.columns([1.1, 2.2])
        with controls[0]:
            archive_filter = st.selectbox(
                "Archive section",
                ["All", "Archived", "Preference mismatches", "Not actionable"],
                key="archive_category_filter",
            )
        with controls[1]:
            search = st.text_input("Search archive", placeholder="Company or title", key="archive_search")
        archive_signature = (archive_filter, search.strip().casefold())
        if st.session_state.get("archive_page_signature") != archive_signature:
            st.session_state["archive_page_signature"] = archive_signature
            st.session_state["archive_page"] = 1
        if page_info is not None:
            requested = {
                **page_info.filters,
                "view": "Archive", "score_state": "All", "search": search,
                "archive_category": archive_filter, "work_model": "All",
                "page": int(st.session_state.get("archive_page", 1)),
            }
            if any(page_info.filters.get(key) != value for key, value in requested.items()):
                from .dashboard_summary import fetch_dashboard_page
                page_info = fetch_dashboard_page(client, user_id=user_id, filters=requested)
                jobs = page_info.jobs
            visible = jobs
            _render_server_page_navigation(page_info, "archive_page")
        else:
            visible = filter_dashboard_jobs(
                jobs, search=search, review_status="Archive",
                archive_category_filter=archive_filter,
            )
        groups = group_archive_jobs(visible)
        archive_signature = (archive_filter, search.strip().casefold())
        if st.session_state.get("archive_page_signature") != archive_signature:
            st.session_state["archive_page_signature"] = archive_signature
            st.session_state["archive_page"] = 1
        page_size = page_info.page_size if page_info is not None else 20
        page_count = max(1, (len(visible) + page_size - 1) // page_size)
        page = page_info.page if page_info is not None else min(max(1, int(st.session_state.get("archive_page", 1))), page_count)
        if page_info is None and len(visible) > page_size:
            archive_pagination = (page, page_count, page_size, len(visible))
            groups, _, _, _ = paginate_job_groups(groups, page=page, page_size=page_size)

    visible_ids = {job.id for job in visible}
    for job in jobs:
        key = f"archive-select-{job.id}"
        if job.id not in visible_ids and st.session_state.get(key):
            st.session_state.pop(key, None)
    if not visible:
        st.info("No listings in this section match the current filters.")
    current_workflow_section = None
    for label, grouped_jobs in groups:
        if section == "Jobs":
            workflow_section = {
                "Needs attention": "TO REVIEW",
                "Ready to rate": "READY TO RATE",
                "Rated": "RATED",
            }[status_filter]
            if workflow_section != current_workflow_section:
                st.markdown(f"### {workflow_section}")
                current_workflow_section = workflow_section
        st.divider()
        if not (section == "Jobs" and status_filter == "Ready to rate" and label == "Ready to rate"):
            st.subheader(label)
        st.caption(f"{len(grouped_jobs)} position{'' if len(grouped_jobs) == 1 else 's'}")
        if section == "Jobs":
            _render_section_selection(label, grouped_jobs)
        columns = st.columns(min(3, len(grouped_jobs)))
        for index, job in enumerate(grouped_jobs):
            with columns[index % len(columns)]:
                _render_job(
                    job, client, user_id=user_id, cv_version_id=cv_version_id,
                    active_profile_id=active_profile_id, storage_bucket=storage_bucket,
                    archive_view=section == "Archive",
                    application_action_blocked=bool(
                        page_info is not None and page_info.pending_duplicate_count
                    ),
                )
    if archive_pagination:
        page, page_count, _, total = archive_pagination
        with st.container(key="archive-pagination"):
            st.caption(f"Showing {(page - 1) * page_size + 1}–{min(page * page_size, total)} of {total} archived listings")
            page_items: list[int | None] = [None, *_archive_page_numbers(page, page_count), None]
            columns = st.columns(len(page_items))
            with columns[0]:
                st.button("← Previous", key="archive-page-previous", disabled=page <= 1, on_click=_set_archive_page, args=(page - 1,))
            for index, page_number in enumerate(page_items[1:-1], start=1):
                with columns[index]:
                    if page_number is None:
                        st.markdown("…")
                    else:
                        st.button(
                            str(page_number),
                            key=f"archive-page-{page_number}",
                            type="primary" if page_number == page else "secondary",
                            disabled=page_number == page,
                            on_click=_set_archive_page,
                            args=(page_number,),
                        )
            with columns[-1]:
                st.button("Next →", key="archive-page-next", disabled=page >= page_count, on_click=_set_archive_page, args=(page + 1,))


@st.fragment
def render_applications(
    jobs: list[DashboardJob],
    active_profile_id: int | None,
    client: SupabaseRestClient,
    *,
    user_id: str,
    cv_version_id: int,
    storage_bucket: str,
    page_info=None,
) -> None:
    st.title("Applications")
    _render_dashboard_change_notice(client, user_id=user_id)
    _post_it_styles()
    selected_interview_job = st.session_state.get("interview_prep_job_id")
    if selected_interview_job is not None and any(
        job.id == selected_interview_job for job in application_view_jobs(jobs)
    ):
        render_interview_prep(client, user_id=user_id, job_id=selected_interview_job)
        return
    if flash := st.session_state.pop("application_action_error", None):
        st.error(f"Could not update the application: {flash}")
    controls = st.columns([1.1, 2.2])
    with controls[0]:
        application_filter = st.selectbox(
            "Application stage",
            ["Active", "All applications", "Applied", "Interview", "Offer", "Closed"],
            key="application_stage_filter",
        )
    with controls[1]:
        search = st.text_input("Search applications", placeholder="Company or title", key="applications_search")
    stage_filter = {
        "Active": "Active applications",
        "All applications": "Applications",
        "Applied": "Applied",
        "Interview": "Interview",
        "Offer": "Offer",
        "Closed": "Closed",
    }[application_filter]
    if page_info is not None:
        filter_signature = ("Applications", stage_filter, search.strip().casefold())
        if st.session_state.get("applications_body_page_signature") != filter_signature:
            st.session_state["applications_body_page_signature"] = filter_signature
            st.session_state["applications_page"] = 1
        requested = {
            **page_info.filters,
            "view": stage_filter,
            "score_state": "All",
            "search": search,
            "archive_category": "All",
            "work_model": "All",
            "page": int(st.session_state.get("applications_page", 1)),
        }
        if any(page_info.filters.get(key) != value for key, value in requested.items()):
            from .dashboard_summary import fetch_dashboard_page
            page_info = fetch_dashboard_page(client, user_id=user_id, filters=requested)
            jobs = page_info.jobs
        visible = jobs
        if page_info.pending_count:
            st.warning(f"{page_info.pending_count} listing summaries are updating. Application results may be incomplete until the background builder finishes.")
        _render_server_page_navigation(page_info, "applications_page")
    else:
        application_jobs = application_view_jobs(jobs)
        visible = filter_dashboard_jobs(application_jobs, search=search, review_status=stage_filter)
    groups = group_application_jobs(visible)
    if not visible:
        st.info("No applications match the current filter.")
        return
    current_section = None
    for label, grouped_jobs in groups:
        heading = "CLOSED APPLICATIONS" if label == "Closed applications" else "APPLICATIONS IN PROGRESS"
        if heading != current_section:
            st.markdown(f"### {heading}")
            current_section = heading
        st.subheader(label)
        st.caption(f"{len(grouped_jobs)} position{'s' if len(grouped_jobs) != 1 else ''}")
        columns = st.columns(min(3, len(grouped_jobs)))
        for index, job in enumerate(grouped_jobs):
            with columns[index % len(columns)]:
                _render_job(
                    job, client, user_id=user_id, cv_version_id=cv_version_id,
                    active_profile_id=active_profile_id, storage_bucket=storage_bucket,
                    application_view=True,
                )


@st.fragment
def render_gap_analytics_page(client: SupabaseRestClient, *, user_id: str) -> None:
    st.title("Gap analytics")
    _post_it_styles()
    _render_gap_analytics(client, user_id=user_id)
