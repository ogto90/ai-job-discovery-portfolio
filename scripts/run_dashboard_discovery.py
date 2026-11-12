"""Run the existing generic discovery pipeline and update its local status file."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matching.candidate_profile_persistence import load_env_file  # noqa: E402


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


SENSITIVE_ENV_NAMES = {
    "SUPABASE_URL",
    "AI_JOB_SEARCH_USER_ID",
    "ADZUNA_APP_ID",
    "ADZUNA_APP_KEY",
    "JOOBLE_API_KEY_AT",
    "JOOBLE_API_KEY_DE",
    "JOOBLE_API_KEY_UK",
    "REED_API_KEY",
}
SENSITIVE_ENV_MARKERS = ("SECRET", "TOKEN", "PASSWORD", "API_KEY", "ACCESS_KEY", "PRIVATE_KEY")


def redact_sensitive_text(value: str, environment: dict[str, str] | None = None) -> str:
    environment = environment if environment is not None else os.environ
    sensitive_values = {
        item
        for name, item in environment.items()
        if item and (
            name.upper() in SENSITIVE_ENV_NAMES
            or any(marker in name.upper() for marker in SENSITIVE_ENV_MARKERS)
        )
    }
    patterns = {
        pattern
        for item in sensitive_values
        for pattern in (item, json.dumps(item, ensure_ascii=True)[1:-1])
    }
    for item in sorted(patterns, key=len, reverse=True):
        value = re.sub(
            rf"(?<![A-Za-z0-9]){re.escape(item)}(?![A-Za-z0-9])",
            "[REDACTED]",
            value,
        )
    return value


def write_status(path: Path, current: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    payload = redact_sensitive_text(json.dumps(current, indent=2))
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


def new_status() -> dict[str, Any]:
    return {
        "run_id": uuid4().hex,
        "passes": ["broad"],
        "status": "running",
        "stage": "starting",
        "started_at": now(),
        "finished_at": None,
        "result": None,
        "error": None,
    }


def load_or_initialize_status(path: Path) -> dict[str, Any]:
    try:
        raw_status = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return new_status()
    except OSError as exc:
        raise RuntimeError(f"Could not read discovery status file {path}: {exc}") from exc

    try:
        status = json.loads(raw_status)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Malformed discovery status file {path}: {exc.msg}") from exc
    if not isinstance(status, dict):
        raise ValueError(f"Discovery status file {path} must contain a JSON object.")
    if status.get("status") == "running":
        return status
    if status.get("status") in {"completed", "failed"}:
        return new_status()
    raise ValueError(f"Discovery status file {path} has no recognized run status.")


def bun_command() -> str:
    command = shutil.which("bun")
    if command:
        return command
    fallback = ROOT / ".agents" / "skills" / "jobnet-search" / "cli" / "node_modules" / ".bin" / "bun"
    if fallback.exists():
        return str(fallback)
    raise RuntimeError("Bun is required to run the discovery pipeline.")


def result_from_output(output: str, mode: str) -> dict | None:
    """Accept the CLI's pretty JSON output and line-delimited JSON safely."""
    decoder = json.JSONDecoder()
    try:
        payload = decoder.decode(output.strip())
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict) and payload.get("mode") == mode:
        return payload

    # Bun or a source CLI may print status text before a pretty-printed object.
    for offset, character in enumerate(output):
        if character != "{":
            continue
        try:
            candidate, _ = decoder.raw_decode(output, offset)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and candidate.get("mode") == mode:
            return candidate

    for line in reversed(output.splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and candidate.get("mode") == mode:
            return candidate
    return None


DISCOVERY_STAT_KEYS = (
    "source_count",
    "raw_discovered",
    "normalized",
    "new_jobs",
    "existing_jobs",
    "suppressed",
    "expired",
    "validation_failed",
    "unknown",
    "validation_skipped",
    "early_unrelated_exclusions",
    "early_preference_exclusions",
    "filtered_irrelevant",
    "filtered_ineligible",
    "preference_mismatches_retained",
    "eligibility_unclear_retained",
    "target_matches",
    "target_adjacent",
    "unrelated",
    "excluded",
    "location_ineligible",
    "location_unclear",
    "language_ineligible",
    "language_unclear",
    "employment_type_ineligible",
    "employment_type_unclear",
    "seniority_ineligible",
    "metadata_unresolved",
    "target_adjacent_sent_for_evidence",
    "location_unclear_sent_for_evidence",
    "liveness_failures",
    "jd_hydration_successes",
    "jd_hydration_failures",
    "role_resolved_after_jd",
    "location_resolved_after_jd",
    "final_actionable",
    "fit_ready",
    "active_actionable",
    "fit_calls",
    "cache_hits",
    "ats_boards_considered",
    "ats_boards_crawled",
    "ats_boards_success",
    "ats_boards_empty",
    "ats_boards_partial",
    "ats_boards_failed",
    "ats_boards_rate_limited",
    "ats_boards_skipped",
    "ats_boards_deferred_budget",
    "ats_boards_invalid_mapping",
    "ats_jobs_raw",
    "ats_jobs_unique",
    "ats_jobs_relevant",
    "ats_jobs_retained",
    "ats_jobs_actionable",
    "ats_jobs_preference_mismatch",
    "ats_jobs_unclear",
    "ats_historical_jobs_closed",
    "ats_job_rows_closed",
    "portal_candidates",
    "combined_unique_candidates",
    "validation_network_checks",
)


def aggregate_stats(results: list[dict]) -> dict[str, Any]:
    keys = DISCOVERY_STAT_KEYS
    totals = dict.fromkeys(keys, 0)
    totals["source_errors"] = 0
    totals["ats_provider_counts"] = {}
    totals["timings_ms"] = {}
    identity_modes: set[str] = set()
    for run in results:
        stats = run.get("stats")
        if not isinstance(stats, dict):
            continue
        for key in keys:
            value = stats.get(key, 0)
            if isinstance(value, int) and not isinstance(value, bool):
                totals[key] += value
        errors = stats.get("errors")
        if isinstance(errors, list):
            totals["source_errors"] += len(errors)
        timings = stats.get("timings_ms")
        if isinstance(timings, dict):
            for stage, duration in timings.items():
                if isinstance(stage, str) and isinstance(duration, int) and not isinstance(duration, bool):
                    totals["timings_ms"][stage] = totals["timings_ms"].get(stage, 0) + max(0, duration)
        provider_counts = stats.get("ats_provider_counts")
        if isinstance(provider_counts, dict):
            for provider, count in provider_counts.items():
                if isinstance(count, int) and not isinstance(count, bool):
                    totals["ats_provider_counts"][provider] = totals["ats_provider_counts"].get(provider, 0) + count
        mode = stats.get("physical_identity_mode")
        if isinstance(mode, str) and mode != "unknown":
            identity_modes.add(mode)
    totals["physical_identity_mode"] = next(iter(identity_modes)) if len(identity_modes) == 1 else "mixed" if identity_modes else "unknown"
    return totals


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status-file", type=Path, required=True)
    parser.add_argument("--log-file", type=Path, required=True)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    args.status_file = args.status_file.expanduser().absolute()
    args.log_file = args.log_file.expanduser().absolute()
    status: dict[str, Any] | None = None
    try:
        status = load_or_initialize_status(args.status_file)
        write_status(args.status_file, status)
        load_env_file(ROOT / ".env")
        load_env_file(ROOT / ".env.daily-job-report")
        args.log_file.parent.mkdir(parents=True, exist_ok=True)
        with args.log_file.open("w", encoding="utf-8") as log:
            results = []
            failures = []
            # Broad already contains the targeted terms; running both would
            # repeat every targeted portal query in the same search cycle.
            for mode in ("broad",):
                status["stage"] = f"{mode} search"
                write_status(args.status_file, status)
                command = [bun_command(), "run", "tools/generic_discovery.ts", mode, "--user-id", args.user_id]
                if args.limit is not None:
                    command.extend(["--limit", str(args.limit)])
                completed = subprocess.run(command, cwd=ROOT, env=os.environ.copy(), capture_output=True, text=True)
                output = completed.stdout or ""
                if completed.stderr:
                    output += completed.stderr
                log.write(redact_sensitive_text(f"--- {mode} discovery ---\n{output}\n"))
                result = result_from_output(completed.stdout or "", mode)
                if completed.returncode != 0:
                    result = None
                if result is not None:
                    results.append(result)
                else:
                    failures.append(mode)
            completed_returncode = 1 if failures else 0
        aggregate = {
            "runs": results,
            "failed_modes": failures,
            "stats": aggregate_stats(results),
        }
        status.update({
            "status": "completed" if completed_returncode == 0 else "failed",
            "stage": "completed" if completed_returncode == 0 else "failed",
            "finished_at": now(),
            "result": aggregate,
            "error": None if completed_returncode == 0 else f"Discovery failed for: {', '.join(failures)}. See the local discovery log.",
        })
        write_status(args.status_file, status)
        return completed_returncode
    except Exception as exc:
        if status is None:
            status = new_status()
        status.update({"status": "failed", "finished_at": now(), "result": None, "error": str(exc)})
        try:
            write_status(args.status_file, status)
        except OSError as write_exc:
            print(
                f"Discovery failed: {exc}; unable to write failure status: {write_exc}",
                file=sys.stderr,
            )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
