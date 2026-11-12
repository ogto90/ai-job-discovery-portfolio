#!/usr/bin/env python3
"""Build compact dashboard summaries in resumable batches of at most 50.

Run after applying the dashboard-summary migration and after profile changes.
This command is intentionally separate from Streamlit page requests.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from matching.candidate_profile_persistence import (
    PersistenceError,
    SupabaseRestClient,
)
from ui.dashboard_summary import build_dashboard_summaries


def discovery_job_ids(status_path: Path) -> list[int]:
    status = json.loads(status_path.read_text(encoding="utf-8"))
    runs = (status.get("result") or {}).get("runs") or []
    return sorted({
        int(job_id)
        for run in runs if isinstance(run, dict)
        for job_id in (run.get("processedJobIds") or [])
        if str(job_id).isdigit() and int(job_id) > 0
    })


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--supabase-url", required=True, help="Exact disposable or approved Supabase API URL to target.")
    parser.add_argument("--expected-project-ref", required=True, help="Expected Supabase project ref, or 'local' for localhost:54321.")
    parser.add_argument("--user-id", default=os.getenv("AI_JOB_SEARCH_USER_ID"))
    parser.add_argument("--max-batches", type=int, help="Stop after this many 50-job batches; rerun to resume.")
    parser.add_argument(
        "--discovery-status-file", type=Path,
        help="Prioritize processed job ids from a run_dashboard_discovery.py status file.",
    )
    parser.add_argument(
        "--require-complete", action="store_true",
        help="Return failure if selected summaries remain pending after this run.",
    )
    parser.add_argument("--retries", type=int, default=3, help="Retries after transient failures (default: 3).")
    parser.add_argument("--allow-production", action="store_true", help="Explicitly allow writes to a hosted Supabase project.")
    args = parser.parse_args()
    if args.max_batches is not None and args.max_batches < 1:
        parser.error("--max-batches must be positive")
    if args.retries < 0 or args.retries > 5:
        parser.error("--retries must be between 0 and 5")
    priority_job_ids = None
    if args.discovery_status_file is not None:
        try:
            priority_job_ids = discovery_job_ids(args.discovery_status_file)
        except (OSError, json.JSONDecodeError, AttributeError, TypeError, ValueError) as exc:
            parser.error(f"Could not read discovered job ids from the status file: {exc}")
    url = args.supabase_url.rstrip("/")
    secret = os.getenv("DASHBOARD_SUMMARY_SUPABASE_SECRET_KEY")
    if not args.user_id or not secret:
        parser.error("Set DASHBOARD_SUMMARY_SUPABASE_SECRET_KEY and AI_JOB_SEARCH_USER_ID or pass --user-id")
    parsed_url = urlparse(url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.hostname:
        parser.error("--supabase-url must be an explicit HTTP(S) API endpoint")
    if args.expected_project_ref == "local":
        if parsed_url.hostname not in {"127.0.0.1", "localhost"} or parsed_url.port != 54321:
            parser.error("The local target must be http(s)://localhost:54321")
    elif parsed_url.hostname != f"{args.expected_project_ref}.supabase.co":
        parser.error("--supabase-url host does not match --expected-project-ref")
    if args.expected_project_ref != "local" and not args.allow_production:
        parser.error("Refusing to write dashboard summaries to a hosted project without --allow-production")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    client = SupabaseRestClient(url, secret)
    for attempt in range(args.retries + 1):
        try:
            if client.base_url != url:
                raise PersistenceError("Builder client endpoint does not match the explicitly configured target.")
            result = build_dashboard_summaries(
                client, user_id=args.user_id, max_batches=args.max_batches,
                priority_job_ids=priority_job_ids,
            )
            break
        except (PersistenceError, ValueError) as exc:
            if attempt >= args.retries:
                logging.error("Dashboard summary build failed after %d attempt(s): %s", attempt + 1, exc)
                return 1
            delay = min(2 ** attempt, 8)
            logging.warning("Dashboard summary attempt %d failed; retrying in %ds: %s", attempt + 1, delay, exc)
            time.sleep(delay)
    print(f"Batches: {result['batches']} · saved: {result['saved']} · changed during build: {result['stale']}")
    if result["remaining"] or result["stale"]:
        print("Summaries remain pending or changed during construction. Rerun this command to resume safely.")
        if args.require_complete:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
