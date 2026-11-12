"""Real scanner regressions using disposable repositories and invalid canaries.

Run explicitly with GITLEAKS_BIN pointing to the pinned scanner; no network or
provider credential is used. The general pytest suite skips without that tool;
the dedicated CI unittest command requires it and fails if it is absent.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCANNER = Path(__file__).resolve().parents[1] / "scripts/security/scan_secrets.py"
BINARY = os.environ.get("GITLEAKS_BIN") or shutil.which("gitleaks")
# Construct a provider-shaped, never-issued token only inside disposable tests.
CANARY = "gh" + "p_" + hashlib.sha256(b"synthetic-secret-scanning-regression").hexdigest()[:36]


class SecretScanningTests(unittest.TestCase):
    def setUp(self):
        if not BINARY:
            if "pytest" in sys.modules:
                self.skipTest("Set GITLEAKS_BIN to run real scanner integration tests")
            self.fail("Set GITLEAKS_BIN to the pinned Gitleaks binary")
        self.temp = tempfile.TemporaryDirectory(prefix="secret-test-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Synthetic Test")
        self.git("config", "user.email", "synthetic@example.invalid")
        (self.repo / ".gitignore").write_text(".env\n.diagnostics/\n")
        (self.repo / "README.md").write_text("Synthetic test repository.\n")
        self.git("add", ".")
        self.git("commit", "-qm", "Synthetic clean baseline")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)

    def scan(self, mode, expected, *extra):
        result = subprocess.run([sys.executable, str(SCANNER), mode, "--repo", str(self.repo),
                                 "--gitleaks", str(BINARY), *extra], capture_output=True, text=True)
        # Never include scanner output in assertions until redaction is checked.
        self.assertTrue(CANARY not in result.stdout + result.stderr, "Scanner output exposed the synthetic credential")
        self.assertEqual(result.returncode, expected, result.stdout)
        return result

    def leak(self):
        (self.repo / "credential.txt").write_text(f"github_token = {CANARY}\n")

    def test_clean_history_and_worktree_pass(self):
        self.scan("history", 0)
        self.scan("worktree", 0)

    def test_deleted_historical_secret_is_detected_and_report_is_redacted(self):
        self.leak()
        self.git("add", "credential.txt")
        self.git("commit", "-qm", "Synthetic canary")
        self.git("rm", "credential.txt")
        self.git("commit", "-qm", "Remove canary from tip")
        self.scan("worktree", 0)
        self.scan("history", 1)
        report = self.repo / ".diagnostics/security/history.json"
        self.assertTrue(CANARY not in report.read_text(), "Report exposed the synthetic credential")
        self.assertTrue(any(x["RuleID"] == "github-pat" for x in json.loads(report.read_text())))
        self.assertEqual(report.stat().st_mode & 0o777, 0o600)

    def test_staged_secret_detected_even_if_worktree_is_clean(self):
        self.leak()
        self.git("add", "credential.txt")
        (self.repo / "credential.txt").write_text("No credential here.\n")
        self.scan("staged", 1)
        self.scan("worktree", 0)

    def test_untracked_nonignored_secret_is_detected(self):
        self.leak()
        self.scan("worktree", 1)

    def test_ignored_private_file_excluded_but_force_added_file_scanned(self):
        (self.repo / ".env").write_text(f"github_token = {CANARY}\n")
        self.scan("worktree", 0)
        self.git("add", "--force", ".env")
        self.scan("worktree", 1)
        self.scan("staged", 1)

    def test_inline_allow_comment_does_not_bypass_detection(self):
        (self.repo / "credential.txt").write_text(f"github_token = {CANARY} # gitleaks:allow\n")
        self.scan("worktree", 1)

    def test_missing_scanner_fails_closed(self):
        self.scan("history", 2, "--gitleaks", str(self.repo / "missing-binary"))

    def test_shallow_history_fails_closed(self):
        clone = Path(self.temp.name) / "shallow"
        subprocess.run(["git", "clone", "--quiet", "--depth=1", self.repo.as_uri(), str(clone)],
                       check=True, capture_output=True)
        self.repo = clone
        self.scan("history", 2)


if __name__ == "__main__":
    unittest.main()
