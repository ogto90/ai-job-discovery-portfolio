#!/usr/bin/env python3
"""Run a defined security suite and reject missing, skipped, or failed cases."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
SUITES = {
    "python": ["tests/test_cv_artifact_safety.py", "tests/test_postgrest_metrics.py",
               "tests/test_streamlit_local_binding.py", "tests/test_interview_preparation.py",
               "tests/test_cv_parser.py", "tests/test_holistic_matcher.py",
               "tests/test_tailored_cv.py", "tests/test_gap_generalization.py",
               "tests/test_gap_recommendations.py", "tests/test_manual_jd.py",
               "tests/test_interview_preparation_pack.py", "tests/test_interview_prep_ui.py",
               "tests/security/test_regression_gate.py"],
    "http": ["tests/safe_http.test.ts", "tests/postgrest_metrics.test.ts"],
    "database": ["tests/security/test_database_authorization.py"],
}
# These four cases launch a real Bubblewrap/TeX process. GitHub-hosted Ubuntu
# denies the unprivileged network namespace they require, so run them only on a
# trusted, namespace-capable local host. The portable gate deselects exactly
# these cases; the full Python suite still requires them.
LOCAL_SANDBOX_CASES = {
    "tests/test_cv_artifact_safety.py::test_real_sandbox_hides_environment_files_and_network",
    "tests/test_cv_artifact_safety.py::test_daily_report_helper_compiles_trusted_cv",
    "tests/test_cv_artifact_safety.py::test_daily_report_helper_contains_hostile_latex",
    "tests/test_tailored_cv.py::test_squads_luna_ampersand_regression_compiles_after_sanitization",
}
SUITES["python-portable"] = SUITES["python"]
# These acceptance cases must execute even if future test selection changes.
REQUIRED = {
    "python": {
        "test_real_sandbox_hides_environment_files_and_network",
        "test_daily_report_helper_contains_hostile_latex",
        "test_daily_report_helper_compiles_trusted_cv",
        "test_missing_sandbox_fails_closed",
        "test_sandbox_launch_failure_never_retries_unsandboxed",
        "test_uncertain_insert_never_deletes_artifacts",
        "test_client_records_bytes_once_without_private_data",
        "test_errors_and_empty_responses_are_measured_without_logging_error_content",
        "test_cross_user_reads_rejected_and_update_is_metadata_only",
        "test_streamlit_binds_to_loopback_by_default",
        "test_cv_injection_text_is_sent_as_untrusted_data_without_model_tools",
        "test_malformed_or_incomplete_output_is_rejected",
        "test_retrieved_job_injection_is_untrusted_evidence_and_has_no_model_tools",
        "test_oversized_manual_jd_is_rejected_before_database_or_model_side_effects",
        "test_oversized_tailored_model_output_is_rejected",
        "test_missing_tailored_model_output_never_compiles_or_persists",
        "test_responses_adapter_rejects_oversized_structured_fields",
        "test_generation_service_requires_explicit_private_context_consent",
        "test_invalid_candidate_and_source_references_are_rejected",
        "test_pack_requires_explicit_consent_and_generates_only_on_button",
    },
    "http": {
        "rejects private, special-use, mapped, and transition addresses",
        "rejects URL credentials, non-HTTP schemes, local hostnames, mixed and private DNS answers",
        "pins the connection lookup to validated answers instead of performing another DNS lookup",
        "validates once per request and sends redirects through a fresh validation",
        "decompresses gzip before enforcing the byte limit",
        "discovery records UTF-8 response bytes without filters, secrets or content",
    },
    "database": {
        "test_all_application_tables_enable_rls",
        "test_browser_roles_have_no_table_sequence_or_function_access",
        "test_rls_denies_browser_rows_even_with_accidental_select_grant",
        "test_service_role_can_read_but_is_not_a_superuser",
        "test_cross_user_cv_link_is_rejected",
        "test_mismatched_preparation_references_are_rejected",
        "test_frozen_interview_sources_cannot_be_rewritten",
        "test_generation_rpc_checks_owner_and_retry_identity",
        "test_cv_bucket_is_private",
    },
}
REQUIRED["python-portable"] = REQUIRED["python"] - {
    "test_real_sandbox_hides_environment_files_and_network",
    "test_daily_report_helper_contains_hostile_latex",
    "test_daily_report_helper_compiles_trusted_cv",
}


def verify_report(path: Path, required: set[str]) -> int:
    report = ET.parse(path)
    cases = report.findall(".//testcase")
    if not cases:
        raise ValueError("No security tests executed")
    if any(report.findall(f".//{tag}") for tag in ("skipped", "failure", "error")):
        raise ValueError("Security tests must pass without skips or expected failures")
    names = {case.attrib.get("name", "").split("[", 1)[0] for case in cases}
    missing = required - names
    if missing:
        raise ValueError("Required security cases did not execute: " + ", ".join(sorted(missing)))
    return len(cases)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", choices=SUITES)
    args = parser.parse_args()
    reports = ROOT / ".diagnostics/security-tests"
    reports.mkdir(parents=True, exist_ok=True)
    report = reports / f"{args.suite}.xml"
    report.unlink(missing_ok=True)
    environment = dict(os.environ)
    # Force the disposable database tests on; they cannot quietly skip in CI.
    environment["AI_JOB_SECURITY_DATABASE_TESTS"] = "1"
    environment.pop("PYTEST_ADDOPTS", None)
    if args.suite == "http":
        command = ["bun", "test", *SUITES[args.suite], "--reporter=junit", f"--reporter-outfile={report}"]
    else:
        command = [sys.executable, "-m", "pytest", "-q", "-s", "--tb=short", *SUITES[args.suite], f"--junitxml={report}"]
        if args.suite == "python-portable":
            for case in sorted(LOCAL_SANDBOX_CASES):
                command.extend(["--deselect", case])
    try:
        result = subprocess.run(command, cwd=ROOT, env=environment, timeout=900)
        if result.returncode:
            return 1
        count = verify_report(report, REQUIRED[args.suite])
    except (OSError, ValueError, ET.ParseError, subprocess.TimeoutExpired) as exc:
        print(f"Security gate failed: {exc}", file=sys.stderr)
        return 1
    summary = f"Security suite {args.suite}: {count} passed; 0 skipped; all required cases executed."
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write(summary + "\n\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
