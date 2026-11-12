from dataclasses import replace
from pathlib import Path
import sys
from unittest.mock import patch

import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import ui.dashboard as dashboard
from tests.test_dashboard_actions import _dashboard_job
from tests.test_interview_preparation import FakeClient, USER


st.session_state.setdefault("client", FakeClient())
job = replace(_dashboard_job(20, "Security Solutions Engineer"),
              company="Nebius", review_status="applied", application_status="applied")
with (
    patch.object(dashboard, "_render_dashboard_change_notice", lambda *_args, **_kwargs: None),
    patch.object(dashboard, "_post_it_styles", lambda: None),
    patch.object(st, "rerun", lambda **_kwargs: None),
):
    dashboard.render_applications([job], None, st.session_state["client"],
                                  user_id=USER, cv_version_id=30, storage_bucket="private")
