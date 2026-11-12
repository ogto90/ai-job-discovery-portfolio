from pathlib import Path
import sys
from unittest.mock import patch

import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.test_interview_preparation_pack import Adapter, PackClient, USER, _profile
import ui.interview_prep as interview_prep


client = PackClient()
client.tables["candidate_profiles"][0]["profile_json"] = _profile()
st.session_state.setdefault("client", client)
st.session_state.setdefault("interview_prep_job_id", 20)
st.session_state.setdefault("phase2_adapter", Adapter())

def mocked(client, **kwargs):
    from matching.interview_preparation_pack import generate_preparation_pack
    return generate_preparation_pack(client, adapter=st.session_state["phase2_adapter"], **kwargs)

with patch.object(st, "rerun", lambda **_kwargs: None):
    with patch.object(interview_prep, "generate_preparation_pack", mocked):
        @st.fragment
        def panel():
            interview_prep.render_interview_prep(st.session_state["client"], user_id=USER, job_id=20)
        panel()
