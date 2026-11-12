import json
from unittest.mock import patch

from ui.discovery_runner import format_elapsed, read_discovery_status, start_discovery


def test_format_elapsed_shows_discovery_duration():
    assert format_elapsed("2026-10-06T08:00:00Z", "2026-10-06T08:02:09Z") == "2m 9s"
    assert format_elapsed("2026-10-06T08:00:00+02:00", "2026-10-06T09:01:00+02:00") == "1h 1m"
    assert format_elapsed("2026-10-06T08:00:00", "2026-10-06T08:00:06") == "6s"


def test_format_elapsed_handles_invalid_or_missing_timestamps():
    assert format_elapsed(None, "2026-10-06T08:00:00Z") == "duration unavailable"
    assert format_elapsed("bad", "also bad") == "duration unavailable"


def test_read_discovery_status_returns_saved_status(tmp_path):
    path = tmp_path / "status.json"
    path.write_text(json.dumps({"status": "completed", "run_id": "abc"}), encoding="utf-8")
    assert read_discovery_status(path) == {"status": "completed", "run_id": "abc"}


def test_read_discovery_status_handles_missing_or_invalid_file(tmp_path):
    assert read_discovery_status(tmp_path / "missing.json") is None
    invalid = tmp_path / "invalid.json"
    invalid.write_text("not json", encoding="utf-8")
    assert read_discovery_status(invalid) is None


def test_start_discovery_requires_and_forwards_resolved_user_id(monkeypatch, tmp_path):
    import ui.discovery_runner as runner

    monkeypatch.setattr(runner, "STATUS_FILE", tmp_path / "status.json")
    monkeypatch.setattr(runner, "LOG_FILE", tmp_path / "log.txt")
    with patch("ui.discovery_runner.subprocess.Popen") as popen:
        status = start_discovery(user_id="resolved-user")

    assert status["status"] == "running"
    assert status["passes"] == ["broad"]
    command = popen.call_args.args[0]
    assert command[-2:] == ["--user-id", "resolved-user"]
