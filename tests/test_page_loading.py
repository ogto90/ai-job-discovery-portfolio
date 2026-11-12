from ui import page_loading
from ui import profile_data


def test_positions_read_model_is_cached_for_short_session_window(monkeypatch):
    from ui import dashboard

    calls = []
    expected = (["loaded"], 1, "user-1", 2, "cv-artifacts")
    monkeypatch.setattr(
        dashboard,
        "_load_dashboard_context_rows",
        lambda _client, _user_id, ui_state: (calls.append(dict(ui_state)) or expected),
    )
    page_loading._load_positions_cached.clear()
    client = type("Client", (), {"base_url": "https://project.example"})()

    first = page_loading._READ_EXECUTOR.submit(
        page_loading.load_positions, client, "user-1", {"7": "fingerprint"}, cache_window=123
    ).result()
    second = page_loading._READ_EXECUTOR.submit(
        page_loading.load_positions, client, "user-1", {"7": "fingerprint"}, cache_window=123
    ).result()

    assert first == second
    assert first[0] == expected
    assert len(calls) == 1
    assert "fit_failed_fingerprints" not in first[1]
    assert first[2]
    page_loading._load_positions_cached.clear()


def test_fallback_user_resolution_does_not_query_on_every_rerun(monkeypatch):
    from types import SimpleNamespace

    calls = []

    class Client:
        base_url = "https://project.example"

        def resolve_active_base_cv(self):
            calls.append(1)
            return SimpleNamespace(user_id="user-1")

    monkeypatch.delenv("AI_JOB_SEARCH_USER_ID", raising=False)
    profile_data._resolve_fallback_user_id_cached.clear()
    client = Client()

    assert profile_data.resolve_application_user_id(client) == "user-1"
    assert profile_data.resolve_application_user_id(client) == "user-1"
    assert len(calls) == 1
    profile_data._resolve_fallback_user_id_cached.clear()
