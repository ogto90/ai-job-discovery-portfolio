from pathlib import Path
import sys
from unittest.mock import patch

import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.test_interview_preparation import FakeClient, USER
from ui.interview_prep import render_interview_prep


st.session_state.setdefault("client", FakeClient())
st.session_state.setdefault("interview_prep_job_id", 20)


@st.fragment
def panel():
    render_interview_prep(st.session_state["client"], user_id=USER, job_id=20)


# AppTest invokes a full rerun for fragment events; scope-limited rerun is unavailable there.
with patch.object(st, "rerun", lambda **_kwargs: None):
    panel()
