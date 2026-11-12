import json
import os
import subprocess
import sys
from types import SimpleNamespace

from scripts.run_dashboard_discovery import aggregate_stats, result_from_output


def test_result_parser_accepts_pretty_json_document():
    payload = {"mode": "targeted", "stats": {"new_jobs": 3}}

    assert result_from_output(json.dumps(payload, indent=2), "targeted") == payload


def test_result_parser_skips_log_text_and_json_string_lines():
    payload = {"mode": "broad", "stats": {"new_jobs": 2}}
    output = 'starting discovery\n"informational line"\n' + json.dumps(payload, indent=2)

    assert result_from_output(output, "broad") == payload


def test_result_parser_accepts_json_lines_and_ignores_non_object_values():
    payload = {"mode": "targeted", "stats": {"new_jobs": 4}}
    output = '\n'.join([json.dumps("not a result object"), json.dumps(payload)])

    assert result_from_output(output, "targeted") == payload


def test_result_parser_rejects_other_modes_and_non_dict_stats_safely():
    assert result_from_output(json.dumps({"mode": "broad"}), "targeted") is None
    assert aggregate_stats([{"stats": "unexpected"}, {"stats": {"new_jobs": 2}}])["new_jobs"] == 2


def test_aggregate_stats_preserves_pipeline_breakdown_and_counts_source_errors():
    stats = aggregate_stats([
        {"stats": {
            "new_jobs": 2,
            "raw_discovered": 10,
            "fit_ready": 3,
            "location_unclear": 4,
            "filtered_irrelevant": 7,
            "filtered_ineligible": 2,
            "errors": [{"source": "one"}],
            "timings_ms": {"portal_sources_ms": 100, "run_associations_ms": 20},
        }},
        {"stats": {"new_jobs": 1, "fit_ready": 2, "errors": [], "timings_ms": {"portal_sources_ms": 250}}},
    ])

    assert stats["new_jobs"] == 3
    assert stats["raw_discovered"] == 10
    assert stats["fit_ready"] == 5
    assert stats["location_unclear"] == 4
    assert stats["filtered_irrelevant"] == 7
    assert stats["filtered_ineligible"] == 2
    assert stats["source_errors"] == 1
    assert stats["active_actionable"] == 0
    assert stats["timings_ms"] == {"portal_sources_ms": 350, "run_associations_ms": 20}


def _configure_launcher(monkeypatch, tmp_path, *, status_file=None, fake_run=None):
    import scripts.run_dashboard_discovery as runner

    working_directory = tmp_path / "clean-checkout-cwd"
    working_directory.mkdir(exist_ok=True)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir(exist_ok=True)
    status_file = status_file or runner_temp / "discovery-status.json"
    log_file = runner_temp / "discovery.log"
    commands = []

    monkeypatch.chdir(working_directory)
    monkeypatch.setattr(runner, "load_env_file", lambda _path: None)
    monkeypatch.setattr(runner, "bun_command", lambda: "bun")
    monkeypatch.setattr(runner.sys, "argv", [
        "run_dashboard_discovery.py",
        "--status-file", str(status_file),
        "--log-file", str(log_file),
        "--user-id", "user-1",
    ])

    if fake_run is None:
        fake_run = lambda _command, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"mode": "broad", "stats": {"new_jobs": 3}}),
            stderr="",
        )

    def run(command, **kwargs):
        commands.append((command, kwargs))
        return fake_run(command, **kwargs)

    monkeypatch.setattr(runner.subprocess, "run", run)
    return runner, status_file, log_file, commands


def test_dashboard_runner_executes_only_the_combined_broad_pass(monkeypatch, tmp_path):
    status_file = tmp_path / "runner-temp" / "discovery-status.json"
    status_file.parent.mkdir()
    status_file.write_text(json.dumps({
        "run_id": "existing-run",
        "status": "running",
        "started_at": "2026-10-06T00:00:00Z",
        "stage": "starting",
        "result": None,
        "error": None,
    }), encoding="utf-8")

    def fake_run(command, **_kwargs):
        return SimpleNamespace(returncode=0, stdout=json.dumps({"mode": "broad", "stats": {"new_jobs": 3}}), stderr="")

    runner, status_file, _log_file, commands = _configure_launcher(
        monkeypatch, tmp_path, status_file=status_file, fake_run=fake_run
    )
    assert runner.main() == 0

    assert len(commands) == 1
    command, options = commands[0]
    assert command[3] == "broad"
    assert options["cwd"] == runner.ROOT
    result = json.loads(status_file.read_text(encoding="utf-8"))
    assert result["run_id"] == "existing-run"
    assert result["started_at"] == "2026-10-06T00:00:00Z"
    assert [run["mode"] for run in result["result"]["runs"]] == ["broad"]


def test_fresh_github_runner_initializes_status_before_starting_discovery(monkeypatch, tmp_path):
    import scripts.run_dashboard_discovery as runner

    status_file = tmp_path / "runner-temp" / "discovery-status.json"
    observed = []

    def fake_run(command, **kwargs):
        status = json.loads(status_file.read_text(encoding="utf-8"))
        observed.append((status, command, kwargs))
        return SimpleNamespace(returncode=0, stdout=json.dumps({"mode": "broad", "stats": {}}), stderr="")

    runner, status_file, log_file, commands = _configure_launcher(
        monkeypatch, tmp_path, fake_run=fake_run
    )
    assert not status_file.exists()
    assert not (runner.ROOT / "company_registry" / "registry.json").exists()
    assert not (runner.ROOT / ".diagnostics" / "dashboard-discovery.json").exists()
    assert runner.main() == 0

    assert len(commands) == 1
    initial, command, kwargs = observed[0]
    assert initial["status"] == "running"
    assert initial["stage"] == "broad search"
    assert initial["passes"] == ["broad"]
    assert initial["started_at"]
    assert initial["finished_at"] is None
    assert initial["result"] is None
    assert command[3] == "broad"
    assert kwargs["cwd"] == runner.ROOT
    assert status_file.is_absolute()
    assert log_file.is_absolute()
    assert json.loads(status_file.read_text(encoding="utf-8"))["status"] == "completed"


def test_cli_entrypoint_starts_stub_bun_from_clean_runner_workspace(tmp_path):
    import scripts.run_dashboard_discovery as runner

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    bun_stub = fake_bin / "bun"
    bun_stub.write_text(
        "#!/bin/sh\n"
        "[ \"$1\" = run ] && [ \"$2\" = tools/generic_discovery.ts ] && "
        "[ \"$3\" = broad ] && [ \"$4\" = --user-id ] && [ \"$5\" = test-user ] || exit 64\n"
        "printf '%s\\n' '{\"mode\":\"broad\",\"stats\":{\"new_jobs\":2}}'\n",
        encoding="utf-8",
    )
    bun_stub.chmod(0o755)

    working_directory = tmp_path / "clean-runner-workspace"
    working_directory.mkdir()
    runner_temp = tmp_path / "runner-temp"
    status_file = runner_temp / "discovery-status.json"
    log_file = runner_temp / "discovery.log"
    environment = os.environ.copy()
    environment["PATH"] = f"{fake_bin}:{environment.get('PATH', '')}"
    for name in (
        "SUPABASE_URL",
        "SUPABASE_SECRET_KEY",
        "AI_JOB_SEARCH_USER_ID",
        "ADZUNA_APP_ID",
        "ADZUNA_APP_KEY",
        "JOOBLE_API_KEY_AT",
        "JOOBLE_API_KEY_DE",
        "JOOBLE_API_KEY_UK",
        "REED_API_KEY",
    ):
        environment.pop(name, None)

    completed = subprocess.run(
        [
            sys.executable,
            str(runner.ROOT / "scripts" / "run_dashboard_discovery.py"),
            "--status-file", str(status_file),
            "--log-file", str(log_file),
            "--user-id", "test-user",
        ],
        cwd=working_directory,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    status = json.loads(status_file.read_text(encoding="utf-8"))
    assert status["status"] == "completed"
    assert status["result"]["runs"][0]["stats"]["new_jobs"] == 2
    assert log_file.exists()
    assert not status_file.with_suffix(status_file.suffix + ".tmp").exists()
    assert not (runner.ROOT / "company_registry" / "registry.json").exists()
    assert not (runner.ROOT / ".diagnostics" / "dashboard-discovery.json").exists()


def test_malformed_status_fails_controlled_without_starting_discovery(monkeypatch, tmp_path):
    status_file = tmp_path / "runner-temp" / "discovery-status.json"
    status_file.parent.mkdir()
    status_file.write_text("{not-json", encoding="utf-8")
    runner, status_file, _log_file, commands = _configure_launcher(
        monkeypatch, tmp_path, status_file=status_file
    )

    assert runner.main() == 1
    status = json.loads(status_file.read_text(encoding="utf-8"))
    assert status["status"] == "failed"
    assert status["result"] is None
    assert "Malformed discovery status file" in status["error"]
    assert commands == []


def test_unreadable_status_fails_controlled_without_false_success(monkeypatch, tmp_path):
    from pathlib import Path

    status_file = tmp_path / "runner-temp" / "discovery-status.json"
    status_file.parent.mkdir()
    status_file.write_text(json.dumps({"status": "running"}), encoding="utf-8")
    runner, status_file, _log_file, commands = _configure_launcher(
        monkeypatch, tmp_path, status_file=status_file
    )
    original_read_text = Path.read_text

    def unreadable(path, *args, **kwargs):
        if path == status_file:
            raise PermissionError("read denied")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", unreadable)
    assert runner.main() == 1

    monkeypatch.setattr(Path, "read_text", original_read_text)
    status = json.loads(status_file.read_text(encoding="utf-8"))
    assert status["status"] == "failed"
    assert "Could not read discovery status file" in status["error"]
    assert "read denied" in status["error"]
    assert commands == []


def test_discovery_subprocess_failure_is_persisted_and_propagated(monkeypatch, tmp_path):
    failure = SimpleNamespace(returncode=7, stdout="partial output", stderr="source failed")
    runner, status_file, log_file, commands = _configure_launcher(
        monkeypatch, tmp_path, fake_run=lambda *_args, **_kwargs: failure
    )

    assert runner.main() == 1
    status = json.loads(status_file.read_text(encoding="utf-8"))
    assert status["status"] == "failed"
    assert status["result"]["failed_modes"] == ["broad"]
    assert status["result"]["runs"] == []
    assert len(commands) == 1
    assert "source failed" in log_file.read_text(encoding="utf-8")


def test_terminal_status_is_reinitialized_for_repeat_execution(monkeypatch, tmp_path):
    runner, status_file, _log_file, commands = _configure_launcher(monkeypatch, tmp_path)

    assert runner.main() == 0
    first = json.loads(status_file.read_text(encoding="utf-8"))
    monkeypatch.setattr(runner.sys, "argv", [
        "run_dashboard_discovery.py",
        "--status-file", str(status_file),
        "--log-file", str(tmp_path / "runner-temp" / "discovery.log"),
        "--user-id", "user-1",
    ])
    assert runner.main() == 0
    second = json.loads(status_file.read_text(encoding="utf-8"))

    assert len(commands) == 2
    assert first["run_id"] != second["run_id"]
    assert second["status"] == "completed"
    assert not status_file.with_suffix(status_file.suffix + ".tmp").exists()


def test_sensitive_environment_values_are_redacted_from_status_and_logs(monkeypatch, tmp_path):
    secrets = {
        "SUPABASE_URL": "https://private-project.supabase.co",
        "SUPABASE_SECRET_KEY": "secret-supabase-key-value",
        "AI_JOB_SEARCH_USER_ID": "private-user-identifier",
        "ADZUNA_APP_ID": "private-adzuna-id",
    }
    for name, value in secrets.items():
        monkeypatch.setenv(name, value)
    output_payload = {"mode": "broad", "stats": {"echo": list(secrets.values())}}
    fake = SimpleNamespace(
        returncode=0,
        stdout=json.dumps(output_payload),
        stderr="debug " + " ".join(secrets.values()),
    )
    runner, status_file, log_file, _commands = _configure_launcher(
        monkeypatch, tmp_path, fake_run=lambda *_args, **_kwargs: fake
    )

    assert runner.main() == 0
    saved = status_file.read_text(encoding="utf-8")
    logged = log_file.read_text(encoding="utf-8")
    for value in secrets.values():
        assert value not in saved
        assert value not in logged
    assert "[REDACTED]" in saved
    assert "[REDACTED]" in logged
