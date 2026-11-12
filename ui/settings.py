"""Read-only application settings and discovery controls."""

from __future__ import annotations

from datetime import datetime, timezone
import streamlit as st

from .dashboard_data import DashboardJob
from .discovery_runner import format_elapsed, read_discovery_status, start_discovery


def _navigate_to_dashboard(status: str, fit_state: str, reason: str) -> None:
    st.session_state["app_page"] = "Jobs"
    st.session_state["dashboard_section"] = "Jobs"
    st.session_state["dashboard_status"] = status
    st.session_state["dashboard_status_initialized"] = True
    st.session_state["dashboard_fit_state"] = fit_state
    st.session_state["pending_reason_filter"] = reason


def _attention_items(jobs: list[DashboardJob]) -> list[tuple[str, int, str, str, str]]:
    pending_categories = sorted({job.pending_category for job in jobs if job.pending_category})
    items: list[tuple[str, int, str, str, str]] = []

    def add(label: str, count: int, status: str, fit_state: str, reason: str = "All unresolved") -> None:
        if count:
            items.append((label, count, status, fit_state, reason))

    add(
        "Verification needed",
        sum(job.pending_category == "Verification needed" for job in jobs),
        "Pending / unresolved",
        "All",
        "Verification needed",
    )
    add("JD required", sum(job.jd_required for job in jobs), "Unaddressed", "JD required")
    add("Ready to rate", sum(job.ready_to_rate for job in jobs), "Unaddressed", "Ready to rate")
    add("Rating failed", sum(job.rating_failed for job in jobs), "Unaddressed", "Rating failed")
    for category in pending_categories:
        if category == "Verification needed":
            continue
        add(
            category,
            sum(job.pending_category == category for job in jobs),
            "Pending / unresolved",
            "All",
            category,
        )
    return items


def _render_attention_summary(jobs: list[DashboardJob] | None) -> None:
    st.subheader("Review jobs in the dashboard")
    if jobs is None:
        st.caption("Review counts appear after the Jobs page has loaded during this session.")
        return
    items = _attention_items(jobs)
    if not items:
        st.caption("There are no jobs currently waiting for review, a JD, verification, or rating.")
        return
    st.caption("Choose a section to open the matching Jobs filter. Counts use the latest Jobs data loaded in this session.")
    for start in range(0, len(items), 3):
        row = items[start : start + 3]
        columns = st.columns(3)
        for index, item in enumerate(row):
            label, count, status, fit_state, reason = item
            with columns[index]:
                st.button(
                    f"{label} · {count}",
                    key=f"attention-{start + index}-{label}",
                    use_container_width=True,
                    on_click=_navigate_to_dashboard,
                    args=(status, fit_state, reason),
                )


def _render_discovery_summary(stats: dict) -> None:
    st.markdown("**Listings from this search**")
    outcomes = (
        ("New listings added", "new_jobs"),
        ("Actionable listings", "active_actionable"),
        ("Need eligibility review", "eligibility_unclear_retained"),
        ("Live status uncertain", "unknown"),
    )
    columns = st.columns(4)
    for column, (label, key) in zip(columns, outcomes):
        column.metric(label, _discovery_count(stats, key))
    st.caption("New listings are records created by this search. Review counts describe different outcomes and may overlap.")

    with st.expander("Search diagnostics"):
        metrics = (
            ("Sources checked", "source_count"),
            ("Listings fetched", "raw_discovered"),
            ("Unique listings", "normalized"),
            ("Existing listings updated", "existing_jobs"),
            ("Full JDs ready", "fit_ready"),
            ("Verified ATS boards", "ats_boards_considered"),
            ("ATS boards crawled", "ats_boards_crawled"),
            ("ATS jobs relevant", "ats_jobs_relevant"),
            ("ATS jobs actionable", "ats_jobs_actionable"),
            ("ATS listings closed", "ats_job_rows_closed"),
            ("Validation cache hits", "cache_hits"),
            ("Live URL checks", "validation_network_checks"),
        )
        for start in range(0, len(metrics), 4):
            columns = st.columns(4)
            for column, (label, key) in zip(columns, metrics[start : start + 4]):
                column.metric(label, _discovery_count(stats, key))
        detail_items = (
            ("Irrelevant/excluded not saved", "filtered_irrelevant"),
            ("Preference mismatches retained", "preference_mismatches_retained"),
            ("Needs location/work-model review", "location_unclear"),
            ("Role excluded as unrelated", "unrelated"),
            ("Excluded by title/preferences", "excluded"),
            ("Expired listings", "expired"),
            ("JD hydration failures", "jd_hydration_failures"),
            ("Source errors", "source_errors"),
        )
        details = [
            f"{label}: {_discovery_count(stats, key)}"
            for label, key in detail_items if _discovery_count(stats, key)
        ]
        if details:
            st.caption(" · ".join(details))
        st.caption(
            f"ATS boards: {stats.get('ats_boards_success', 0)} succeeded, "
            f"{stats.get('ats_boards_empty', 0)} empty, {stats.get('ats_boards_partial', 0)} partial, "
            f"{stats.get('ats_boards_rate_limited', 0)} rate-limited, {stats.get('ats_boards_failed', 0)} failed; "
            f"{stats.get('ats_boards_skipped', 0)} skipped as fresh, "
            f"{stats.get('ats_boards_deferred_budget', 0)} deferred by run budget."
        )
        provider_counts = stats.get("ats_provider_counts")
        if isinstance(provider_counts, dict) and provider_counts:
            st.caption("ATS providers: " + " · ".join(f"{name}: {count}" for name, count in sorted(provider_counts.items())))
        st.caption(f"Physical identity: {stats.get('physical_identity_mode', 'unknown')}")


def _discovery_count(stats: dict, key: str) -> int:
    value = stats.get(key, 0)
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _discovery_issue_counts(result: dict) -> tuple[int, int, int]:
    errors = [
        item.get("message", "")
        for run in result.get("runs", []) if isinstance(run, dict)
        for item in (run.get("stats") or {}).get("errors", [])
        if isinstance(item, dict)
    ]
    collisions = sum("Physical identity conflict or source URL collision" in message for message in errors)
    rate_limits = sum("429 Too Many Requests" in message for message in errors)
    return collisions, rate_limits, len(errors) - collisions - rate_limits


def render_settings(
    *,
    user_id: str,
    jobs: list[DashboardJob] | None = None,
) -> None:
    st.title("Settings")
    st.caption("Search configuration and discovery controls")
    st.subheader("Job discovery")
    st.write("Run one combined search using your specific role terms and broader role families. Results are deduplicated and added to the same job pool.")

    @st.fragment(run_every="5s")
    def discovery_panel() -> None:
        status = read_discovery_status()
        running = bool(status and status.get("status") == "running")
        if st.button("Search for new positions", type="primary", disabled=running):
            start_discovery(user_id=user_id)
            st.success("Combined search started in the background.")
            st.rerun(scope="fragment")
        if running:
            elapsed = format_elapsed(status.get("started_at"), datetime.now(timezone.utc).isoformat())
            st.info(f"Search in progress: {status.get('stage', 'starting')} · elapsed {elapsed}…")
            return
        if status and status.get("status") == "completed":
            result = status.get("result") or {}
            stats = result.get("stats") or {}
            if not isinstance(stats, dict):
                stats = {}
            new_jobs = stats.get("new_jobs", 0)
            if not isinstance(new_jobs, int) or isinstance(new_jobs, bool):
                new_jobs = 0
            summary = (
                f"Search completed: {new_jobs} new position(s) found "
                f"in {format_elapsed(status.get('started_at'), status.get('finished_at'))}."
            )
            source_errors = stats.get("source_errors", 0)
            if isinstance(source_errors, int) and source_errors > 0:
                collisions, rate_limits, other = _discovery_issue_counts(result)
                issues = []
                if collisions:
                    issues.append(f"{collisions} URL identity conflict(s) skipped")
                if rate_limits:
                    issues.append(f"{rate_limits} source rate-limit error(s)")
                if other:
                    issues.append(f"{other} other issue(s)")
                st.warning(f"Search finished with issues. {summary} {' · '.join(issues) or f'{source_errors} source issue(s)'}.")
            else:
                st.success(summary)
            _render_discovery_summary(stats)
            st.caption("Use Update view beside Rate selected in Job Search to load changed listings.")
        elif status and status.get("status") == "failed":
            duration = format_elapsed(status.get("started_at"), status.get("finished_at"))
            st.error(f"Search failed after {duration}. {status.get('error') or 'Check the local discovery log.'}")
            if st.button("Dismiss search notice", key="dismiss-discovery-error"):
                st.rerun(scope="fragment")

    discovery_panel()
    _render_attention_summary(jobs)
