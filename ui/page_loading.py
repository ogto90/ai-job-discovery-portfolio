"""Session-scoped background reads; workers never access Streamlit state."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import time
from typing import Any, Callable

import streamlit as st


_READ_EXECUTOR = ThreadPoolExecutor(max_workers=3, thread_name_prefix="page-read")
PENDING = object()


@st.cache_data(ttl=30, max_entries=16, show_spinner=False)
def _load_positions_cached(
    _client,
    user_id: str,
    project_url: str,
    data_revision: int,
    card_revision: int,
    cache_window: int,
    failed_fingerprints: tuple[tuple[str, str], ...],
):
    from ui.dashboard import _load_dashboard_context_rows

    state = {"fit_failed_fingerprints": dict(failed_fingerprints)}
    # Start the cursor before reading so external writes during this load are
    # included in the next incremental change check.
    change_cursor = (datetime.now(timezone.utc) - timedelta(seconds=2)).isoformat()
    context = _load_dashboard_context_rows(_client, user_id, ui_state=state)
    state.pop("fit_failed_fingerprints", None)
    return context, state, change_cursor


def load_positions(client, user_id, failed_fingerprints, *, cache_window: int | None = None):
    from matching.candidate_profile_persistence import supabase_card_revision, supabase_data_revision

    fingerprint_key = tuple(sorted((str(job_id), str(value)) for job_id, value in failed_fingerprints.items()))
    return _load_positions_cached(
        client,
        user_id,
        getattr(client, "base_url", ""),
        supabase_data_revision(),
        supabase_card_revision(),
        int(time.time() // 30) if cache_window is None else cache_window,
        fingerprint_key,
    )


def page_data(key: tuple, revision: Any, loader: Callable, *args, **kwargs):
    entries = st.session_state.setdefault("page_read_tasks", {})
    entry = entries.get(key)
    if entry is None or entry["revision"] != revision:
        if entry is not None:
            entry["future"].cancel()
        entry = {"revision": revision, "started_at": time.monotonic(), "future": _READ_EXECUTOR.submit(loader, *args, **kwargs)}
        entries[key] = entry
    future = entry["future"]
    if not future.done():
        return PENDING
    if future.exception() is not None:
        st.error("This page's data could not be loaded. Please retry.")
        if st.button("Retry loading", key=f"retry-page-{key}"):
            entries.pop(key, None)
            st.rerun()
        return PENDING
    return future.result()


@st.fragment(run_every="1s")
def loading_notice(key: tuple, revision: Any) -> None:
    entry = st.session_state.get("page_read_tasks", {}).get(key)
    if entry is None or entry["revision"] != revision:
        return
    if entry["future"].done():
        # One paint after an initial load, using the already-loaded result.
        # Existing pages/cards are never periodically invalidated here.
        if not entry.get("announced"):
            entry["announced"] = True
            st.rerun(scope="app")
        return
    elapsed = max(0, int(time.monotonic() - entry.get("started_at", time.monotonic())))
    minutes, seconds = divmod(elapsed, 60)
    elapsed_label = f"{minutes}m {seconds:02d}s" if minutes else f"{seconds}s"
    st.info(f"Loading saved data… {elapsed_label}")
