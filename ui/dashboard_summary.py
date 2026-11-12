"""Bounded dashboard summary reads and resumable summary construction.

Eligibility and Fit identity remain owned by the existing Python code. The
database stores only their compact result, filters/orders the full set, and
returns one page plus bounded stale-summary diagnostics.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import logging
import re
import time
from typing import Any
from urllib.parse import urlencode

from matching.candidate_profile_persistence import PersistenceError, SupabaseRestClient


SUMMARY_ALGORITHM_VERSION = 2
PAGE_SIZE = 50
DETAIL_FIELDS = {"description", "fit_strengths", "fit_gaps", "fit_job_snapshot"}
SUMMARY_CARD_FIELDS = {
    "id", "source", "company", "title", "location", "remote_scope",
    "source_url", "application_url", "availability_status", "verification_status",
    "posted_at", "first_seen_at", "last_seen_at", "source_company", "source_title",
    "metadata_override", "source_metadata_quality_issues", "user_verification_status",
    "user_verification_reason", "verified_location_status", "verified_employment_type",
    "employment_type_decision", "location_checked_at", "employment_type",
    "preference_override_fields", "preference_override_at", "description_kind",
    "is_manual", "role_eligibility", "location_eligibility",
    "employment_type_eligibility", "seniority_eligibility",
    "eligibility_reason", "role_reason", "location_reason",
    "employment_type_reason", "seniority_reason",
    "metadata_quality_issues", "description_available", "fit_fingerprint",
}


def bounded_dashboard_enabled(value: str | None) -> bool:
    """Use compact pages by default; explicit false allows a legacy rollback."""
    normalized = (value or "").strip().lower()
    if normalized in {"false", "0", "off", "no"}:
        return False
    if normalized in {"", "1", "true", "yes", "on"}:
        return True
    raise PersistenceError("Invalid bounded dashboard setting; use true or false.")


@dataclass(frozen=True)
class DashboardPage:
    jobs: list[Any]
    active_profile_id: int | None
    user_id: str
    cv_version_id: int
    storage_bucket: str
    page: int
    page_size: int
    total_count: int
    pending_count: int
    pending_duplicate_count: int
    pending_preview: tuple[dict[str, Any], ...]
    pending_preview_page: int
    pending_preview_pages: int
    complete: bool
    filters: dict[str, Any]


def normalize_dashboard_identity(value: str | None) -> str:
    """Keep duplicate matching identical to the legacy all-jobs resolver."""
    return re.sub(r"[^a-z0-9]+", " ", (value or "").casefold()).strip()


def validate_supabase_target(actual_url: str, expected_url: str) -> str:
    """Require application and worker to use the same explicitly configured API endpoint."""
    actual = actual_url.strip().rstrip("/")
    expected = expected_url.strip().rstrip("/")
    if not actual or not expected or actual != expected:
        raise PersistenceError("Configured Supabase endpoint does not match the expected test target.")
    return actual


def compact_job_summary(job: Any, *, active_profile_id: int | None) -> dict[str, Any]:
    """Serialize authoritative Python decisions without heavy/lazy payloads."""
    value = {key: value for key, value in asdict(job).items() if key in SUMMARY_CARD_FIELDS}
    value["description_available"] = bool(job.description)
    value["active_profile_id"] = active_profile_id
    value["static_actionable"] = bool(job.actionable)
    value["static_live"] = bool(job.live_for_user)
    value["static_decision_state"] = job.decision.state
    value["static_reason_code"] = job.decision.primary_reason_code
    value["static_reason_label"] = job.decision.primary_reason_label
    value["static_reason_detail"] = job.decision.primary_reason_detail
    value["metadata_unresolved"] = bool(job.metadata_unresolved)
    # Assessment and lifecycle state are queried live. These are empty by
    # construction in the summary builder and are set by the page RPC.
    return value


def summary_input_fingerprint(job: Any, *, job_updated_at: str, profile_revision: int,
                              job_revision: int) -> str:
    payload = {
        "algorithm": SUMMARY_ALGORITHM_VERSION,
        "job_updated_at": job_updated_at,
        "profile_revision": profile_revision,
        "job_revision": job_revision,
        "job": {
            "source": job.source, "source_company": job.source_company,
            "source_title": job.source_title, "company": job.company,
            "title": job.title, "location": job.location,
            "remote_scope": job.remote_scope, "employment_type": job.employment_type,
            "description": job.description, "description_kind": job.description_kind,
            "availability_status": job.availability_status,
            "fit_fingerprint": job.fit_fingerprint,
            "eligibility": [job.role_eligibility, job.location_eligibility,
                job.employment_type_eligibility, job.seniority_eligibility],
            "metadata_override": job.metadata_override,
            "verification": [job.user_verification_status, job.verified_location_status,
                job.verified_employment_type, job.employment_type_decision],
        },
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


def _rpc(client: SupabaseRestClient, function: str, payload: dict[str, Any]) -> Any:
    # Preserve PostgREST's result shape. Table-returning RPCs (notably the
    # summary work queue) must remain lists even when the final batch has one
    # row; unwrapping singleton arrays makes the worker mistake that row for
    # an invalid response and fail to drain the queue.
    started = time.perf_counter()
    outcome = "error"
    try:
        result = client.json_request("POST", f"/rest/v1/rpc/{function}", payload)
        outcome = "ok"
        return result
    finally:
        # End-to-end server RPC time includes transport and JSON decoding.
        # Never log payloads, identifiers, search text, or exception messages.
        logging.getLogger(__name__).info(
            "dashboard_rpc rpc=%s outcome=%s elapsed_ms=%.1f",
            function, outcome, (time.perf_counter() - started) * 1000,
        )


def fetch_dashboard_page(client: SupabaseRestClient, *, user_id: str,
                         filters: dict[str, Any]) -> DashboardPage:
    """Read one server-filtered, server-ranked page; never falls back to history."""
    from ui.dashboard_data import DashboardJob
    failed = {
        str(k): str(v)
        for k, v in filters.get("failed_fingerprints", {}).items()
        if str(k).isdigit() and isinstance(v, str)
    }
    page_rpc = (
        "dashboard_job_attention_page"
        if str(filters.get("view", "")) == "Needs attention"
        else "dashboard_job_page"
    )
    response = _rpc(client, page_rpc, {
        "p_user_id": user_id,
        "p_view": str(filters.get("view", "Pending / unresolved")),
        "p_score_state": str(filters.get("score_state", "All")),
        "p_minimum_fit": int(filters.get("minimum_fit", 0)),
        "p_search": str(filters.get("search", "")),
        "p_archive_category": str(filters.get("archive_category", "All")),
        "p_work_model": str(filters.get("work_model", "All")),
        "p_page": max(1, int(filters.get("page", 1))),
        "p_page_size": PAGE_SIZE,
        "p_failed_fingerprints": failed,
        "p_pending_page": max(1, int(filters.get("pending_page", 1))),
    })
    if not isinstance(response, dict) or not isinstance(response.get("items"), list):
        raise PersistenceError("Supabase returned an invalid dashboard summary page.")
    try:
        cv_version_id = int(response["cv_version_id"])
        storage_bucket = str(response["storage_bucket"])
        raw_profile_id = response.get("active_profile_id")
        active_profile_id = int(raw_profile_id) if raw_profile_id is not None else None
    except (KeyError, TypeError, ValueError) as exc:
        raise PersistenceError("Supabase could not resolve the active CV dashboard context.") from exc
    jobs = []
    for row in response["items"]:
        if not isinstance(row, dict) or "id" not in row:
            raise PersistenceError("Supabase returned an invalid dashboard summary card.")
        # Older local database migrations can omit optional dataclass defaults;
        # the current version always persists only known DashboardJob fields.
        tuple_fields = {
            "fit_strengths", "fit_gaps", "metadata_quality_issues",
            "source_metadata_quality_issues", "preference_override_fields",
        }
        for field in tuple_fields:
            if isinstance(row.get(field), list):
                row[field] = tuple(row[field])
        allowed = set(DashboardJob.__dataclass_fields__)
        card = {key: value for key, value in row.items() if key in allowed}
        card.setdefault("review_status", "new")
        card.setdefault("fit_score", None)
        card.setdefault("fit_assessment_id", None)
        card["description"] = None
        card["fit_strengths"] = ()
        card["fit_gaps"] = ()
        card["fit_job_snapshot"] = None
        card["summary_backed"] = True
        jobs.append(DashboardJob(**card))
    return DashboardPage(
        jobs=jobs,
        active_profile_id=active_profile_id,
        user_id=user_id,
        cv_version_id=cv_version_id,
        storage_bucket=storage_bucket,
        page=max(1, int(response.get("page", 1))),
        page_size=min(PAGE_SIZE, max(1, int(response.get("page_size", PAGE_SIZE)))),
        total_count=max(0, int(response.get("total_count", 0))),
        pending_count=max(0, int(response.get("pending_count", 0))),
        pending_duplicate_count=max(0, int(response.get("pending_duplicate_count", 0))),
        pending_preview=tuple(response.get("pending_preview") or ()),
        pending_preview_page=max(1, int(response.get("pending_preview_page", 1))),
        pending_preview_pages=max(1, int(response.get("pending_preview_pages", 1))),
        complete=bool(response.get("complete", False)),
        filters=dict(filters),
    )


def load_assessment_detail(client: SupabaseRestClient, *, user_id: str, job_id: int,
                           assessment_id: int | None, include_snapshot: bool = False) -> dict[str, Any]:
    """Read exactly the displayed assessment, scoped to its owner and job."""
    if assessment_id is None:
        return {}
    columns = "strengths,gaps" + (",job_snapshot" if include_snapshot else "")
    query = urlencode({
        "select": columns, "id": f"eq.{assessment_id}", "user_id": f"eq.{user_id}",
        "job_id": f"eq.{job_id}", "limit": "1",
    })
    rows = client.get_json(f"/rest/v1/job_match_assessments?{query}")
    if not isinstance(rows, list) or len(rows) > 1:
        raise PersistenceError("Supabase returned invalid assessment details.")
    if not rows:
        return {}
    row = rows[0]
    detail = {"fit_strengths": tuple(row.get("strengths") or ()),
              "fit_gaps": tuple(row.get("gaps") or ())}
    if include_snapshot:
        detail["fit_job_snapshot"] = row.get("job_snapshot")
    return detail


def load_job_detail(client: SupabaseRestClient, *, user_id: str, job_id: int,
                    include_description: bool = False) -> dict[str, Any]:
    result = _rpc(client, "dashboard_job_detail", {
        "p_user_id": user_id, "p_job_id": int(job_id),
        "p_include_description": bool(include_description),
    })
    if not isinstance(result, dict) or int(result.get("job_id", -1)) != int(job_id):
        raise PersistenceError("The listing details could not be loaded.")
    if not result.get("summary_current"):
        raise PersistenceError("This listing changed while the dashboard was loading. Refresh and retry the action.")
    return result


def build_dashboard_summaries(client: SupabaseRestClient, *, user_id: str,
                              max_batches: int | None = None,
                              target_job_id: int | None = None,
                              priority_job_ids: list[int] | None = None) -> dict[str, int]:
    """Build at most 50 summaries per DB round trip; safe to rerun after interruption."""
    from ui.dashboard import _load_dashboard_context_rows

    if target_job_id is not None and int(target_job_id) < 1:
        raise ValueError("job_id must be a positive integer")
    if target_job_id is not None and priority_job_ids is not None:
        raise ValueError("Choose a single target job or a prioritized job list, not both")
    selected_job_ids = (
        [int(target_job_id)] if target_job_id is not None else
        sorted({int(job_id) for job_id in priority_job_ids}) if priority_job_ids is not None else None
    )
    if selected_job_ids is not None and any(job_id < 1 for job_id in selected_job_ids):
        raise ValueError("job ids must be positive integers")
    if selected_job_ids is not None and len(selected_job_ids) > 5000:
        raise ValueError("at most 5000 prioritized job ids are allowed")
    after_job_id = int(target_job_id) - 1 if target_job_id is not None else 0
    batches = saved = stale = 0
    profile_cache: dict = {}
    while max_batches is None or batches < max_batches:
        if selected_job_ids is not None:
            batch = _rpc(client, "dashboard_summary_selected_batch", {
                "p_user_id": user_id, "p_job_ids": selected_job_ids, "p_limit": PAGE_SIZE,
            })
        else:
            batch = _rpc(client, "dashboard_summary_next_batch", {
                "p_user_id": user_id, "p_after_job_id": after_job_id, "p_limit": PAGE_SIZE,
            })
        if not isinstance(batch, list):
            raise PersistenceError("Supabase returned an invalid dashboard summary work batch.")
        if not batch:
            break
        expected: dict[int, dict[str, Any]] = {}
        for row in batch:
            job_id = int(row["job_id"])
            expected[job_id] = {
                "job_updated_at": row["observed_job_updated_at"],
                "profile_revision": int(row["observed_profile_revision"]),
                "job_revision": int(row["observed_job_revision"]),
            }
        revisions = {row["profile_revision"] for row in expected.values()}
        if len(revisions) != 1:
            raise PersistenceError("Summary batch contains inconsistent profile revisions.")
        context, active_profile_id, *_ = _load_dashboard_context_rows(
            client, user_id, job_ids=set(expected), ui_state={}, summary_only=True,
            profile_cache=profile_cache, profile_revision=revisions.pop(),
        )
        rows_by_id = {job.id: job for job in context}
        payload = []
        for job_id, stamps in expected.items():
            job = rows_by_id.get(job_id)
            if job is None:
                stale += 1
                continue
            payload.append({
                "job_id": job_id,
                **stamps,
                "summary_algorithm_version": SUMMARY_ALGORITHM_VERSION,
                "input_fingerprint": summary_input_fingerprint(job, **stamps),
                "identity_company": normalize_dashboard_identity(job.company),
                "identity_title": normalize_dashboard_identity(job.title),
                "summary": compact_job_summary(job, active_profile_id=active_profile_id),
            })
        result = _rpc(client, "dashboard_summary_store_batch", {
            "p_user_id": user_id, "p_rows": payload,
        })
        if not isinstance(result, dict):
            raise PersistenceError("Supabase returned an invalid dashboard summary write result.")
        saved += int(result.get("saved", 0))
        stale += int(result.get("stale", 0))
        batches += 1
        logging.info("dashboard_summary_build user=%s batch=%d rows=%d saved=%d stale=%d",
                     user_id, batches, len(payload), result.get("saved", 0), result.get("stale", 0))
        if not result.get("saved"):
            # Avoid spinning forever when one input is continuously changing.
            break
        if selected_job_ids is not None and len(batch) < PAGE_SIZE and not int(result.get("stale", 0)):
            break
    if selected_job_ids is not None:
        probe = _rpc(client, "dashboard_summary_selected_batch", {
            "p_user_id": user_id, "p_job_ids": selected_job_ids, "p_limit": 1,
        })
        if not isinstance(probe, list):
            raise PersistenceError("Supabase returned an invalid targeted summary completion check.")
        return {"batches": batches, "saved": saved, "stale": stale, "remaining": bool(probe)}
    probe = _rpc(client, "dashboard_summary_next_batch", {
        "p_user_id": user_id, "p_after_job_id": 0, "p_limit": 1,
    })
    if not isinstance(probe, list):
        raise PersistenceError("Supabase returned an invalid dashboard summary completion check.")
    return {"batches": batches, "saved": saved, "stale": stale, "remaining": bool(probe)}
