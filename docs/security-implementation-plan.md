# Security checks

[Security overview](security-threat-model.md) · [Project overview](../README.md)

The repository uses automated checks to catch regressions in specific controls. Passing results describe the code and cases tested, not a guarantee that a deployment is secure.

| Check | Where to look |
| --- | --- |
| Secrets in repository history and changes | [Secret-scanning workflow](../.github/workflows/secret-scanning.yml) |
| HTTP boundaries, document policy, application privacy and database authorization | [Security regressions](../.github/workflows/security-regressions.yml) |
| Source rules, dependency locks and vulnerability audits | [Code and dependency checks](../.github/workflows/code-dependencies.yml) |
| Additional source analysis and pull-request dependency review | [CodeQL](../.github/workflows/codeql.yml) and [dependency review](../.github/workflows/dependency-review.yml) |

The checks use synthetic inputs and disposable services rather than production data. Required regression cases fail if missing or skipped. Test fixtures verify that the scanners detect known unsafe examples.

## Run locally

Use the pinned tool versions in the workflows. Full document tests also need the [sandbox dependencies](cv-artifact-safety.md), and database tests need a local Docker daemon.

```bash
python3 scripts/security/scan_secrets.py history --gitleaks /path/to/gitleaks
python3 scripts/security/run_regressions.py http
python3 scripts/security/run_regressions.py python-portable
python3 scripts/security/run_regressions.py python
python3 scripts/security/run_regressions.py database
python3 scripts/security/check_dependency_locks.py
python3 scripts/security/check_code_dependencies.py canaries
python3 scripts/security/check_code_dependencies.py static
python3 scripts/security/check_code_dependencies.py dependencies
```

## Coverage and exceptions

Hosted CI checks document sandbox policy and fail-closed behavior. Four real Bubblewrap/TeX integration cases are excluded from the portable suite because hosted runners deny the required namespace setup. Run the full suite on a trusted, namespace-capable host after sandbox or compiler changes.

Database tests replay migrations in a disposable PostgreSQL container; they do not test hosted Supabase Auth or Storage. Offline AI tests cover validation and side effects, not real-model accuracy or prompt-injection resistance.

Known dependency exceptions are recorded in the [Python tool policy](../security/python-dependency-exceptions.json) and [Bun policy](../security/dependency-exceptions.json). Each specifies the affected dependency, rationale and expiry. An exception is a reviewed risk decision, not a patched dependency; expired or stale exceptions fail the audit.

PR checks run without application credentials. CodeQL has permission to upload security findings. Manual discovery and summary workflows are separate and require the operator's own configuration. Branch protection and environment review settings should be verified on GitHub before deployment.

## Security-tool dependency override

Semgrep 1.185.0 restricts OpenTelemetry to an older family. The isolated scanner
lock uses [explicit overrides](../security/overrides.txt) for the patched
1.45.2/0.66b2 family, addressing CVE-2026-114603 and CVE-2026-126360. This is a
project-tested combination outside Semgrep's declared dependency range.
Application dependencies are unchanged.

Regenerate the lock with:

```bash
uv pip compile security/requirements.in --override security/overrides.txt --python-version 3.12 --generate-hashes -o security/requirements.txt
```

Install the entire hashed closure with `pip install --require-hashes --no-deps -r
security/requirements.txt`, then run the lock check, `python
scripts/security/check_telemetry.py` and the scanner checks above. The telemetry
check permits only the named Semgrep pin conflicts and rejects other dependency
conflicts. It also exercises both malformed-header regressions with a timeout.
Remove the overrides when Semgrep supports a patched family directly; revalidate
before changing the scanner version. MCP exceptions remain separate.
