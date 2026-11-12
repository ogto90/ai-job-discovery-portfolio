import logging

import pytest

from ui.dashboard_summary import _rpc


@pytest.mark.parametrize("fail", [False, True])
def test_rpc_timing_preserves_result_and_does_not_log_private_data(caplog, fail):
    result = [{"private": "private-response"}]

    class Client:
        def json_request(self, method, path, payload):
            if fail:
                raise RuntimeError("private-error")
            return result

    with caplog.at_level(logging.INFO, logger="ui.dashboard_summary"):
        if fail:
            with pytest.raises(RuntimeError, match="private-error"):
                _rpc(Client(), "dashboard_job_page", {"p_user_id": "private-user"})
        else:
            assert _rpc(Client(), "dashboard_job_page", {"p_user_id": "private-user"}) is result
    assert "dashboard_rpc rpc=dashboard_job_page" in caplog.text
    assert ("outcome=error" if fail else "outcome=ok") in caplog.text
    assert "elapsed_ms=" in caplog.text
    assert "private-" not in caplog.text
