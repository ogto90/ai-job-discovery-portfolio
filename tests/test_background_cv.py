from concurrent.futures import Future
from dataclasses import replace
from types import SimpleNamespace

import pytest

import ui.dashboard as dashboard
from matching.tailored_cv import TailoredCVError
from tests.test_dashboard_actions import _dashboard_job


@pytest.fixture
def setup(monkeypatch):
    state = {}
    submitted = []

    def submit(fn, *args, **kwargs):
        future = Future()
        submitted.append((future, fn, args, kwargs))
        return future

    monkeypatch.setattr(dashboard, "st", SimpleNamespace(session_state=state, error=lambda text: None))
    monkeypatch.setattr(dashboard, "_CV_EXECUTOR", SimpleNamespace(submit=submit))
    job = replace(_dashboard_job(8, "Engineer"), fit_score=78, review_status="rated", description_kind="full", description="Full JD")
    return state, submitted, job


def test_generation_submits_without_blocking_or_rerunning_and_deduplicates(setup):
    state, submitted, job = setup
    for _ in range(2):
        dashboard._generate_cv(job, object(), "user-1", 2, 7, "private", force=False)
    assert len(submitted) == 1
    future, fn, _, kwargs = submitted[0]
    assert not future.done()
    assert fn is dashboard.generate_or_reuse_tailored_cv
    assert kwargs["candidate_profile_id"] == 7
    assert dashboard._job_operation_busy(8)
    assert not dashboard._job_operation_busy(9)
    assert not dashboard._collect_cv_task("user-1", 8, "private")


def test_completion_patches_only_target_card_and_collects_once(setup):
    state, submitted, job = setup
    other = _dashboard_job(9, "Other")
    state["dashboard_jobs_snapshot_by_user"] = {"user-1": [job, other]}
    dashboard._generate_cv(job, object(), "user-1", 2, 7, "private", force=False)
    submitted[0][0].set_result({"row": {"id": 42, "pdf_file_path": "user-1/tailored/8/cv.pdf", "tex_file_path": "user-1/tailored/8/cv.tex"}})
    assert dashboard._collect_cv_task("user-1", 8, "private")
    updated, unchanged = state["dashboard_jobs_snapshot_by_user"]["user-1"]
    assert updated.tailored_cv_id == 42
    assert unchanged is other
    assert not dashboard._job_operation_busy(8)
    assert not dashboard._collect_cv_task("user-1", 8, "private")


def test_completed_cv_keeps_snapshot_valid_and_does_not_request_another_refresh(setup, monkeypatch):
    from matching.candidate_profile_persistence import supabase_data_revision

    state, submitted, job = setup
    other = _dashboard_job(9, "Other")
    context = ([job, other], 7, "user-1", 2, "private")
    dashboard.save_dashboard_context_snapshot("user-1", context, change_cursor="2026-10-08T00:00:00Z")
    revision = supabase_data_revision()
    dashboard._generate_cv(job, object(), "user-1", 2, 7, "private", force=False)
    submitted[0][0].set_result({"row": {"id": 42, "pdf_file_path": "user-1/tailored/8/cv.pdf"}})
    assert dashboard._collect_cv_task("user-1", 8, "private")
    updated = dashboard.get_dashboard_context_snapshot("user-1")
    assert updated is not None and updated[0][1] is other
    assert state["dashboard_context_revision_by_user"]["user-1"] == revision
    monkeypatch.setattr(dashboard, "_changed_job_ids_since", lambda *args: ({8}, False))
    monkeypatch.setattr(dashboard, "_load_dashboard_context_rows", lambda *args, **kwargs: ([updated[0][0]], *updated[1:]))
    client = SimpleNamespace(
        resolve_active_base_cv=lambda user: SimpleNamespace(id=2),
        list_profiles=lambda *args: [{"id": 7, "is_active": True}],
    )
    assert dashboard.sync_dashboard_context(client, "user-1") == 0
    assert dashboard.get_dashboard_context_snapshot("user-1")[0][1] is other


def test_failure_preserves_existing_cv_and_allows_retry(setup):
    state, submitted, job = setup
    job = replace(job, tailored_cv_id=4, tailored_pdf_path="old.pdf")
    state["dashboard_jobs_snapshot_by_user"] = {"user-1": [job]}
    dashboard._generate_cv(job, object(), "user-1", 2, 7, "private", force=True)
    submitted[0][0].set_exception(TailoredCVError("Compilation failed"))
    assert not dashboard._collect_cv_task("user-1", 8, "private")
    assert state["dashboard_jobs_snapshot_by_user"]["user-1"][0] is job
    assert state["tailored_cv_errors"][("user-1", 8)] == "Compilation failed"
    dashboard._generate_cv(job, object(), "user-1", 2, 7, "private", force=True)
    assert len(submitted) == 2
    assert not state["tailored_cv_errors"]


def test_different_cards_can_generate_independently(setup):
    _, submitted, job = setup
    for job_id in (8, 9):
        dashboard._generate_cv(replace(job, id=job_id), object(), "user-1", 2, 7, "private", force=False)
    assert len(submitted) == 2
    assert dashboard._job_operation_busy(8) and dashboard._job_operation_busy(9)


def test_poll_notifies_once_and_never_reloads_dashboard(setup, monkeypatch):
    _, submitted, job = setup
    notifications = []
    renders = []
    dashboard.st.toast = notifications.append
    monkeypatch.setattr(dashboard, "_render_cv_actions", lambda *args: renders.append(args[0].id))
    dashboard._generate_cv(job, object(), "user-1", 2, 7, "private", force=False)
    submitted[0][0].set_result({"row": {"id": 42, "pdf_file_path": "user-1/tailored/8/cv.pdf"}})
    poll = dashboard._poll_cv_controls.__wrapped__
    for _ in range(2):
        poll(job, object(), "user-1", 2, 7, "private")
    assert len(notifications) == 1
    assert renders == [8, 8]


def test_ready_download_is_read_once_and_keeps_existing_actions(setup, monkeypatch):
    from contextlib import nullcontext

    state, _, job = setup
    job = replace(job, tailored_cv_id=42, tailored_pdf_path="user-1/tailored/8/cv.pdf")
    downloads = []
    buttons = []
    reads = []
    dashboard.st.popover = lambda *args, **kwargs: nullcontext()
    dashboard.st.download_button = lambda *args, **kwargs: downloads.append(kwargs)
    dashboard.st.button = lambda label, **kwargs: buttons.append(label)
    dashboard.st.link_button = lambda label, *args, **kwargs: buttons.append(label)
    monkeypatch.setattr(dashboard, "_download_tailored_pdf_cached", lambda *args: reads.append(args) or b"%PDF-fake")
    for _ in range(2):
        dashboard._render_cv_actions(job, object(), "user-1", 2, 7, "private")
    assert len(reads) == 1
    assert all(item["data"] == b"%PDF-fake" and item["on_click"] == "ignore" for item in downloads)
    assert "Regenerate" in buttons and "View diff" in buttons


def test_streamlit_generate_click_only_reruns_cv_fragment(monkeypatch):
    from streamlit.testing.v1 import AppTest

    submitted = []
    def submit(*args, **kwargs):
        future = Future()
        submitted.append(future)
        return future
    monkeypatch.setattr(dashboard, "_CV_EXECUTOR", SimpleNamespace(submit=submit))
    app = AppTest.from_string('''
import streamlit as st
from dataclasses import replace
from tests.test_dashboard_actions import _dashboard_job
from ui.dashboard import _render_cv_controls
st.session_state["page_runs"] = st.session_state.get("page_runs", 0) + 1
job = replace(_dashboard_job(8, "Engineer"), fit_score=78, review_status="rated", description_kind="full", description="Full JD")
_render_cv_controls(job, object(), "user-1", 2, 7, "private")
''').run()
    assert not app.exception
    app.button(key="generate-cv-8").click().run()
    assert not app.exception
    assert len(submitted) == 1
    assert app.button(key="cv-progress-8").disabled
