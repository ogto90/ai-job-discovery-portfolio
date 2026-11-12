"""Offline regressions for compiler isolation and ambiguous Storage/DB saves."""

import subprocess
import os
import sys
from pathlib import Path

import pytest

from matching.candidate_profile_persistence import PersistenceError
from matching.latex_sandbox import sandbox_command
from matching.tailored_cv import TailoredCVError, compile_latex, generate_or_reuse_tailored_cv
from tests.test_tailored_cv import FakeTailoredAI, FakeTailoredClient, JOB

ROOT = Path(__file__).resolve().parents[1]
DAILY_REPORT_COMPILER = ROOT / "tools" / "compile_latex_sandbox.py"


def test_compiler_environment_and_command_are_restricted(tmp_path, monkeypatch):
    # Inspect the command policy without depending on host-installed tools.
    monkeypatch.setattr("matching.latex_sandbox.shutil.which", lambda name: "/usr/bin/" + name)
    monkeypatch.setenv("OPENAI_API_KEY", "dummy-secret")
    monkeypatch.setenv("LD_PRELOAD", "/untrusted/library.so")
    command, environment = sandbox_command("/usr/bin/lualatex", tmp_path)
    assert "OPENAI_API_KEY" not in environment
    assert "LD_PRELOAD" not in environment
    assert environment["HOME"] == "/work"
    assert "--unshare-all" in command
    assert "--share-net" not in command
    assert "--new-session" in command
    assert "-no-shell-escape" in command
    assert "--cpu=60" in command
    assert "--as=1610612736" in command
    assert "--fsize=33554432" in command
    assert "/home" not in command and "/etc" not in command


def test_missing_sandbox_fails_closed(monkeypatch):
    monkeypatch.setattr("matching.latex_sandbox.shutil.which", lambda name: None if name == "bwrap" else "/usr/bin/" + name)
    with pytest.raises(TailoredCVError, match="no unsandboxed fallback"):
        compile_latex(r"\documentclass{article}\begin{document}Test\end{document}")


def test_sandbox_launch_failure_never_retries_unsandboxed(monkeypatch):
    calls = []
    # The injected subprocess failure is the behavior under test; no compiler
    # or Bubblewrap process should be launched by this case.
    monkeypatch.setattr("matching.tailored_cv.shutil.which", lambda name: "/usr/bin/" + name)

    def denied(command, **kwargs):
        calls.append(command)
        kwargs["stdout"].write(b"bwrap: operation not permitted")
        return subprocess.CompletedProcess(command, 1)

    monkeypatch.setattr("matching.tailored_cv.subprocess.run", denied)
    with pytest.raises(TailoredCVError, match="operation not permitted"):
        compile_latex(r"\documentclass{article}\begin{document}Test\end{document}")
    assert len(calls) == 1
    assert calls[0][0].endswith("bwrap")


def test_real_sandbox_hides_environment_files_and_network(tmp_path, monkeypatch):
    secret = tmp_path / "host-secret.txt"
    secret.write_text("dummy-only")
    monkeypatch.setenv("OPENAI_API_KEY", "dummy-not-a-real-key")
    source = r"""\documentclass{article}
\begin{document}
\directlua{
  assert(os.getenv('OPENAI_API_KEY') == nil, 'credential visible')
  assert(io.open('HOSTFILE', 'r') == nil, 'host file visible')
  local routes = assert(io.open('/proc/net/route', 'r')):read('*a')
  assert(not string.find(routes, '00000000'), 'network route visible')
}
Sandbox test.
\end{document}
""".replace("HOSTFILE", str(secret))
    assert compile_latex(source).startswith(b"%PDF-")
    assert secret.read_text() == "dummy-only"


def test_daily_report_helper_compiles_trusted_cv(tmp_path):
    output = tmp_path / "trusted.pdf"
    result = subprocess.run(
        [sys.executable, str(DAILY_REPORT_COMPILER), str(ROOT / "tests/fixtures/base_cv.tex"), str(output)],
        capture_output=True, text=True, timeout=100,
    )
    assert result.returncode == 0, result.stderr
    assert output.read_bytes().startswith(b"%PDF-")


def test_daily_report_helper_contains_hostile_latex(tmp_path):
    secret = tmp_path / "host-secret.txt"
    secret.write_text("synthetic-only")
    source = tmp_path / "hostile.tex"
    source.write_text(r"""\documentclass{article}
\begin{document}
\directlua{
  assert(os.getenv('OPENAI_API_KEY') == nil, 'credential visible')
  assert(io.open('HOSTFILE', 'r') == nil, 'host file visible')
  local routes = assert(io.open('/proc/net/route', 'r')):read('*a')
  assert(not string.find(routes, '00000000'), 'network route visible')
}
Sandboxed report.
\end{document}
""".replace("HOSTFILE", str(secret)))
    output = tmp_path / "hostile.pdf"
    environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "OPENAI_API_KEY": "synthetic-test-key", "HOME": str(tmp_path)}
    result = subprocess.run(
        [sys.executable, str(DAILY_REPORT_COMPILER), str(source), str(output)],
        capture_output=True, text=True, env=environment, timeout=100,
    )
    assert result.returncode == 0, result.stderr
    assert output.read_bytes().startswith(b"%PDF-")
    assert secret.read_text() == "synthetic-only"


class FailureClient(FakeTailoredClient):
    def __init__(self, failure):
        super().__init__()
        self.failure = failure
        self.objects = {}
        self.deleted = []
        self.posted = False

    def upload_storage_object(self, bucket, path, data, *, content_type):
        self.objects[path] = data
        if self.failure == "upload" and path.endswith(".pdf"):
            raise PersistenceError("Upload response lost")

    def delete_storage_object(self, bucket, path):
        self.deleted.append(path)
        self.objects.pop(path, None)

    def json_request(self, method, path, payload, *, prefer=None):
        self.posted = True
        if self.failure in {"before_commit", "lookup_failure"}:
            raise PersistenceError("Insert outcome uncertain")
        if self.failure == "race":
            payload = dict(payload)
            for field in ("tex_file_path", "pdf_file_path", "file_path"):
                payload[field] = payload[field].replace("/tailored/8/", "/tailored/8/winner-")
                self.objects[payload[field]] = b"winner artifact"
        super().json_request(method, path, payload, prefer=prefer)
        raise PersistenceError("Response lost or duplicate insert")

    def get_json(self, path):
        if self.posted and self.failure == "lookup_failure":
            raise PersistenceError("Reconciliation unavailable")
        return super().get_json(path)


def generate(client, monkeypatch):
    monkeypatch.setattr("matching.tailored_cv.compile_latex", lambda source: b"%PDF-fake")
    return generate_or_reuse_tailored_cv(
        client, user_id="user-1", cv_version_id=2, candidate_profile_id=7,
        job_id=8, title=JOB.title, company=JOB.company,
        description=JOB.description, source_url=JOB.source_url,
        location=None, remote_scope=None, ai_client=FakeTailoredAI(),
    )


def test_lost_insert_response_preserves_committed_artifacts(monkeypatch):
    client = FailureClient("after_commit")
    result = generate(client, monkeypatch)
    assert result["created"] is True
    assert len(client.rows) == 1
    assert len(client.objects) == 2
    assert client.deleted == []
    assert result["row"]["pdf_file_path"] in client.objects
    assert generate(client, monkeypatch)["cache_hit"] is True


@pytest.mark.parametrize("failure", ["before_commit", "lookup_failure"])
def test_uncertain_insert_never_deletes_artifacts(failure, monkeypatch):
    client = FailureClient(failure)
    with pytest.raises(PersistenceError, match="retained for recovery"):
        generate(client, monkeypatch)
    assert len(client.objects) == 2
    assert not client.deleted


def test_race_loser_only_deletes_its_own_artifacts(monkeypatch):
    client = FailureClient("race")
    result = generate(client, monkeypatch)
    assert result["cache_hit"] is True
    assert len(client.rows) == 1
    assert len(client.objects) == 2
    assert len(client.deleted) == 2
    assert all(value == b"winner artifact" for value in client.objects.values())
    assert result["row"]["pdf_file_path"] in client.objects


def test_upload_failure_cleans_only_unreferenced_attempt(monkeypatch):
    client = FailureClient("upload")
    client.objects["unrelated-existing.pdf"] = b"keep"
    with pytest.raises(PersistenceError, match="Upload response lost"):
        generate(client, monkeypatch)
    assert not client.posted
    assert client.objects == {"unrelated-existing.pdf": b"keep"}


def test_retries_do_not_share_storage_paths(monkeypatch):
    client = FailureClient("before_commit")
    for _ in range(2):
        with pytest.raises(PersistenceError):
            generate(client, monkeypatch)
    assert len(client.objects) == 4
