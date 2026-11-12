"""Local background runner for the dashboard's existing discovery pipeline."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]
STATUS_FILE = ROOT / ".diagnostics" / "dashboard-discovery.json"
LOG_FILE = ROOT / ".diagnostics" / "dashboard-discovery.log"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def format_elapsed(started_at: str | None, finished_at: str | None) -> str:
    """Format a discovery run's persisted timestamps as a concise duration."""
    if not started_at or not finished_at:
        return "duration unavailable"
    try:
        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        finished = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return "duration unavailable"
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    if finished.tzinfo is None:
        finished = finished.replace(tzinfo=timezone.utc)
    seconds = max(0, int((finished - started).total_seconds()))
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary.replace(path)


def read_discovery_status(path: Path = STATUS_FILE) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _bun_command() -> str:
    configured = shutil.which("bun")
    if configured:
        return configured
    fallback = ROOT / ".agents" / "skills" / "jobnet-search" / "cli" / "node_modules" / ".bin" / "bun"
    if fallback.exists():
        return str(fallback)
    raise RuntimeError("Bun is required to run the discovery pipeline.")


def start_discovery(*, user_id: str, limit: int | None = None) -> dict[str, Any]:
    """Start one combined discovery pass in a detached process."""
    if not user_id.strip():
        raise ValueError("A current user ID is required to start discovery.")
    current = read_discovery_status(STATUS_FILE)
    if current and current.get("status") == "running":
        return current

    run_id = uuid4().hex
    status = {
        "run_id": run_id,
        "passes": ["broad"],
        "status": "running",
        "stage": "starting",
        "started_at": _now(),
        "finished_at": None,
        "result": None,
        "error": None,
    }
    _write_json(STATUS_FILE, status)
    command = [sys.executable, str(ROOT / "scripts" / "run_dashboard_discovery.py"), "--status-file", str(STATUS_FILE), "--log-file", str(LOG_FILE), "--user-id", user_id]
    if limit is not None:
        command.extend(["--limit", str(limit)])
    environment = os.environ.copy()
    subprocess.Popen(
        command,
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return status
