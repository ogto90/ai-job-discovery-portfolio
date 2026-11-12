import os
from pathlib import Path
import sys
from unittest.mock import patch

import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.test_interview_preparation_local import LocalClient, USER, _assert_disposable
from ui.interview_prep import render_interview_prep


_assert_disposable()
st.session_state.setdefault("client", LocalClient(os.environ["INTERVIEW_PREP_LOCAL_API"]))
with patch.object(st, "rerun", lambda **_kwargs: None):
    render_interview_prep(st.session_state["client"], user_id=USER, job_id=20)
