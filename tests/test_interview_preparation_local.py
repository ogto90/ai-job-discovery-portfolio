"""Optional disposable PostgREST + PostgreSQL integration test.

Set INTERVIEW_PREP_LOCAL_API and INTERVIEW_PREP_LOCAL_PG to run this test.
Never point either variable at production.
"""

from __future__ import annotations

from datetime import datetime
import os
from pathlib import Path
import subprocess
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from streamlit.testing.v1 import AppTest

from matching.candidate_profile_persistence import PersistenceError, SupabaseRestClient
from matching.interview_preparation import (
    create_interview_preparation,
    get_interview_preparation,
    list_interview_preparations_for_application,
    update_interview_preparation,
)


USER = "11111111-1111-4111-8111-111111111111"
LOCAL_CONFIGURED = all(os.getenv(name) for name in (
    "INTERVIEW_PREP_LOCAL_API", "INTERVIEW_PREP_LOCAL_PG",
    "INTERVIEW_PREP_LOCAL_DB", "INTERVIEW_PREP_LOCAL_PG_PASSWORD",
))


def _assert_disposable() -> None:
    api = urlsplit(os.environ["INTERVIEW_PREP_LOCAL_API"])
    if api.scheme != "http" or api.hostname not in {"127.0.0.1", "localhost"}:
        raise ValueError("The interview preparation test API must be loopback HTTP.")
    if os.environ["INTERVIEW_PREP_LOCAL_PG"] not in {"127.0.0.1", "localhost"}:
        raise ValueError("The interview preparation test database must be loopback-only.")
    if not os.environ["INTERVIEW_PREP_LOCAL_DB"].startswith("phase1_"):
        raise ValueError("Use a dedicated disposable phase1_ database.")


class LocalClient(SupabaseRestClient):
    def __init__(self, url):
        super().__init__(url, "local-only")
        self.blobs = {"base.tex": b"Base CV", "tailored.pdf": b"Submitted CV"}

    def _request_unlocked(self, method, path, **kwargs):
        headers = {"Content-Type": kwargs.get("content_type") or "application/json"}
        if kwargs.get("prefer"):
            headers["Prefer"] = kwargs["prefer"]
        request = Request(self.base_url + path.removeprefix("/rest/v1"),
                          data=kwargs.get("body"), headers=headers, method=method)
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, response.read()
        except HTTPError as exc:
            raise PersistenceError(exc.read().decode()) from exc

    def download_storage_object(self, _bucket, path):
        return self.blobs[path]

    def upload_storage_object(self, _bucket, path, data, *, content_type):
        self.blobs[path] = data


def _sql(statement):
    _assert_disposable()
    host = os.environ["INTERVIEW_PREP_LOCAL_PG"]
    result = subprocess.run(
        ["psql", "-qAt", "-h", host, "-p", "55432", "-U", "postgres",
         "-d", os.environ["INTERVIEW_PREP_LOCAL_DB"],
         "-v", "ON_ERROR_STOP=1", "-c", statement],
        check=True, capture_output=True, text=True,
        env={**os.environ, "PGPASSWORD": os.environ["INTERVIEW_PREP_LOCAL_PG_PASSWORD"]},
    )
    return result.stdout.strip()


@pytest.mark.skipif(not LOCAL_CONFIGURED,
                    reason="disposable local PostgREST and PostgreSQL not configured")
def test_nebius_application_persists_two_rounds_and_frozen_sources():
    _assert_disposable()
    client = LocalClient(os.environ["INTERVIEW_PREP_LOCAL_API"])
    _sql("update public.applications set submitted_cv_version_id = null where id = 10")
    _sql("update public.jobs set description = 'Original JD', description_kind = 'full' where id = 20")
    _sql("update public.cv_versions set is_active = true where id = 30")
    initial_status = _sql("select status from public.applications where id = 10")
    first = create_interview_preparation(
        client, user_id=USER, application_id=10, idempotency_key=str(uuid4()),
        interview_type="technical", selected_cv_version_id=31, cv_confirmed=True,
    )
    assert first["submitted_cv_version_id"] == 31
    assert first["source_context"]["cv"]["artifact_status"] == "saved"
    assert first["candidate_profile_id"] == 40 and first["fit_assessment_id"] == 50
    assert first["interview_datetime"] is None
    reopened = get_interview_preparation(client, user_id=USER, preparation_id=first["id"])
    assert reopened["job_id"] == 20
    assert reopened["source_context"]["company"] == "Nebius"
    assert reopened["source_context"]["description"] == "Original JD"
    scheduled = datetime(2026, 11, 5, 14, 30, tzinfo=ZoneInfo("Europe/Vienna"))
    update_interview_preparation(
        client, user_id=USER, preparation_id=first["id"], interview_type="technical",
        interview_datetime=scheduled, interview_notes="Focus on architecture",
    )
    assert get_interview_preparation(client, user_id=USER, preparation_id=first["id"])["interview_notes"] == "Focus on architecture"
    second = create_interview_preparation(
        client, user_id=USER, application_id=10, idempotency_key=str(uuid4()),
        interview_type="hiring_manager",
    )
    assert second["id"] != first["id"]
    rounds = list_interview_preparations_for_application(client, user_id=USER, application_id=10)
    assert {first["id"], second["id"]}.issubset({row["id"] for row in rounds})
    _sql("update public.jobs set description = 'Changed JD' where id = 20")
    _sql("update public.cv_versions set is_active = false where id = 30")
    preserved = get_interview_preparation(client, user_id=USER, preparation_id=first["id"])
    assert preserved["source_context"]["description"] == "Original JD"
    assert preserved["source_context"]["cv"]["id"] == 31
    assert client.blobs[preserved["source_context"]["cv"]["snapshot_path"]] == b"Submitted CV"
    assert _sql("select status from public.applications where id = 10") == initial_status
    assert _sql("select submitted_cv_version_id from public.applications where id = 10") == "31"
    assert _sql("select count(*) from public.jobs where id = 20") == "1"


@pytest.mark.skipif(not LOCAL_CONFIGURED,
                    reason="disposable local PostgREST and PostgreSQL not configured")
def test_local_schema_blocks_browser_roles_source_edits_and_wrong_job():
    permissions = _sql(
        "select relrowsecurity, "
        "has_table_privilege('anon','public.interview_preparations','select'), "
        "has_table_privilege('authenticated','public.interview_preparations','select'), "
        "has_table_privilege('service_role','public.interview_preparations','select') "
        "from pg_class where oid='public.interview_preparations'::regclass"
    )
    assert permissions == "t|f|f|t"
    preparation_id = _sql("select id from public.interview_preparations where application_id=10 order by created_at desc limit 1")
    assert preparation_id
    _sql(
        "do $$ begin "
        "begin update public.interview_preparations set source_context = '{\"tampered\":true}' "
        f"where id = '{preparation_id}'; "
        "raise exception 'source edit was accepted'; "
        "exception when raise_exception then "
        "if sqlerrm = 'source edit was accepted' then raise; end if; end; "
        "begin insert into public.interview_preparations "
        "(user_id,application_id,job_id,idempotency_key,interview_type,source_context) "
        f"values ('{USER}',10,21,'{uuid4()}','technical','{{}}'); "
        "raise exception 'wrong job was accepted'; "
        "exception when foreign_key_violation then null; end; end $$"
    )


@pytest.mark.skipif(not LOCAL_CONFIGURED,
                    reason="disposable local PostgREST and PostgreSQL not configured")
def test_streamlit_create_edit_reopen_against_disposable_database():
    _assert_disposable()
    _sql("update public.applications set submitted_cv_version_id = null where id = 10")
    _sql("update public.jobs set description = 'Original JD', description_kind = 'full' where id = 20")
    fixture = Path(__file__).parent / "fixtures" / "interview_prep_local_app.py"
    at = AppTest.from_file(str(fixture), default_timeout=10).run()
    assert not at.exception
    next(item for item in at.selectbox if item.label == "CV sent with this application").select(31).run()
    next(item for item in at.checkbox if item.label.startswith("I confirm")).check().run()
    next(item for item in at.selectbox if item.label == "Interview type").select("technical")
    next(item for item in at.button if item.label == "Create preparation").click().run()
    assert not at.exception
    first_id = at.session_state["interview_prep_record_id"]
    assert _sql(f"select submitted_cv_version_id from public.interview_preparations where id='{first_id}'") == "31"
    assert _sql(f"select interview_type from public.interview_preparations where id='{first_id}'") == "technical"
    at.run()
    next(item for item in at.text_area if item.label == "Notes").set_value("Discuss Nebius architecture")
    next(item for item in at.button if item.label == "Save changes").click().run()
    assert _sql(f"select interview_notes from public.interview_preparations where id='{first_id}'") == "Discuss Nebius architecture"
    next(item for item in at.button if item.label == "New interview round").click().run()
    at.run()
    next(item for item in at.button if item.label == "Create preparation").click().run()
    second_id = at.session_state["interview_prep_record_id"]
    assert second_id != first_id
    assert _sql(f"select count(*) from public.interview_preparations where id in ('{first_id}','{second_id}')") == "2"
    at.run()
    labels = [item.label for item in at.button]
    assert any(item.startswith("Technical |") and first_id[:8] in item for item in labels), labels
    saved = next(item for item in at.button if item.label.startswith("Technical |") and first_id[:8] in item.label)
    saved.click().run()
    assert at.session_state["interview_prep_record_id"] == first_id
    assert _sql("select status from public.applications where id=10") == "applied"
