#!/usr/bin/env python3
"""Run pinned Gitleaks without printing credentials or uploading reports."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

VERSION = "8.30.1"
CONFIG = Path(__file__).resolve().parents[2] / ".gitleaks.toml"


def git(repo: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)


def snapshot(repo: Path, destination: Path) -> None:
    """Scan tracked + nonignored new files, never private ignored workspace data."""
    names = git(repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    for name in set(names.split(b"\0")) - {b""}:
        relative = Path(os.fsdecode(name))
        source = repo / relative
        target = destination / relative
        if source.is_symlink():
            # Scan the link value, never read a file outside the snapshot.
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(os.readlink(source))
        elif source.is_file():
            if not source.resolve().is_relative_to(repo):
                raise ValueError("Tracked path escapes the repository")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        elif source.is_dir():
            raise ValueError("Nested repositories/submodules require a separate scan")
        # Deleted working-tree files are still covered by history/staged scans.


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("history", "staged", "worktree"))
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--gitleaks", default="gitleaks")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        repo = Path(os.fsdecode(git(args.repo, "rev-parse", "--show-toplevel")).strip()).resolve()
        binary = shutil.which(args.gitleaks)
        if not binary:
            raise ValueError("Install Gitleaks using scripts/security/install_gitleaks.sh")
        version = subprocess.run([binary, "version"], capture_output=True, text=True, check=True, timeout=15)
        if version.stdout.strip().removeprefix("v") != VERSION:
            raise ValueError(f"Gitleaks {VERSION} is required")
        if args.mode == "history" and git(repo, "rev-parse", "--is-shallow-repository").strip() != b"false":
            raise ValueError("History scanning requires a full clone (fetch-depth: 0 in Actions)")

        with tempfile.TemporaryDirectory(prefix="job-secret-scan-") as directory:
            temp = Path(directory)
            report = temp / "report.json"
            # Exceptions belong in reviewed configuration, not inline comments
            # or an implicitly discovered fingerprint baseline.
            ignore = temp / "empty-ignore"
            ignore.write_text("")
            common = ["--config", str(CONFIG), "--gitleaks-ignore-path", str(ignore),
                      "--ignore-gitleaks-allow", "--redact=100", "--no-banner", "--no-color",
                      "--log-level=error", "--report-format=json", "--report-path", str(report),
                      "--exit-code=10", "--timeout=300"]
            if args.mode == "worktree":
                tree = temp / "tree"
                tree.mkdir()
                snapshot(repo, tree)
                command = [binary, "dir", str(tree), *common]
            else:
                mode_flags = ["--log-opts=--all"] if args.mode == "history" else ["--pre-commit", "--staged"]
                command = [binary, "git", str(repo), *mode_flags, *common]
            result = subprocess.run(command, cwd=repo, capture_output=True, timeout=330)
            if result.returncode not in (0, 10):
                raise ValueError("Gitleaks could not complete the scan; check installation, Git access, and configuration")
            findings = json.loads(report.read_text())
            if not isinstance(findings, list):
                raise ValueError("Invalid scanner report")
            if (result.returncode == 10) != bool(findings):
                raise ValueError("Scanner status and report disagree")
            # Reports may still contain filenames and author metadata. Keep
            # them local and ignored; CI never publishes them as artifacts.
            report_dir = repo / ".diagnostics" / "security"
            report_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            report_dir.chmod(0o700)
            saved = report_dir / f"{args.mode}.json"
            saved.write_text(json.dumps(findings, indent=2) + "\n")
            saved.chmod(0o600)
            print(f"Secret scan ({args.mode}): {len(findings)} findings. Gitleaks {VERSION}.")
            if findings:
                print(f"Review the redacted local report: .diagnostics/security/{args.mode}.json")
                print("Do not publish the report. Revoke real credentials; document narrow false positives.")
                return 1
            return 0
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        # Subprocess output is deliberately excluded: even a failing scanner
        # must not turn CI output into another place where secrets are stored.
        message = str(exc) if isinstance(exc, ValueError) else type(exc).__name__
        print(f"Secret scan could not complete: {message}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
