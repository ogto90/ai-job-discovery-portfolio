# Security implementation and evidence

This public portfolio repository is a clean source snapshot with synthetic
candidate evidence. It does not contain the private application's Git history,
database, CVs, or deployment secrets. The [threat model](security-threat-model.md)
records the trust boundaries, abuse cases, controls, and residual risks.

| Phase | Implemented control | Evidence in this repository | Status |
| --- | --- | --- | --- |
| 1. Secrets | Pinned Gitleaks, full-history/current/staged scan modes, redacted local reports, synthetic detection canaries | [Scanner](../scripts/security/scan_secrets.py), [tests](../tests/test_secret_scanning.py), [CI](../.github/workflows/secret-scanning.yml) | Implemented; public CI verifies the published snapshot |
| 2. Security regressions | Required hosted gate for SSRF, HTTP privacy, document sandbox policy/fail-closed behavior, application privacy, and disposable database authorization; four real compiler-isolation cases run locally | [Runner](../scripts/security/run_regressions.py), [database tests](../tests/security/test_database_authorization.py), [CI](../.github/workflows/security-regressions.yml) | Hosted portable cases required; full 170-case Python suite verified locally on a namespace-capable host |
| 3. Code and dependencies | Required CodeQL workflow, Semgrep source rules, locked Python/Bun graphs, audit canaries, dependency review, bounded advisory exceptions, Dependabot | [CodeQL](../.github/workflows/codeql.yml), [rules](../security/semgrep.yml), [audit runner](../scripts/security/check_code_dependencies.py), [CI](../.github/workflows/code-dependencies.yml), [dependency review](../.github/workflows/dependency-review.yml) | Implemented; public CI verifies pull requests and the published snapshot |
| 4. Threat model and AI boundary | Assets, flows, eight abuse cases, control mapping, model-data inventory, offline AI safeguard tests | [Threat model](security-threat-model.md), [AI safeguard tests](../tests/test_interview_preparation_pack.py) | Documented and implemented within the stated limits |
| 5. Enforcement and presentation | Required CI, protected security files, private reporting route, accurate README | [Owner map](../.github/CODEOWNERS), [reporting policy](../SECURITY.md), [README](../README.md), [blocked probe](https://github.com/ogto90/pairrole/pulls?q=is%3Apr+is%3Aclosed+label%3Asecurity-probe) | Enforcement active; the unsafe-code probe PR was blocked and closed |

The three repository CI workflows run on pull requests and `main` pushes. They
use read-only tokens and no application secrets. The secret scan also runs
weekly; Gitleaks is pinned and checksum verified. The regression runner rejects
empty suites, skipped tests, and missing required cases. The database suite
replays committed migrations in a disposable local PostgreSQL container.

The source and dependency job scans tracked application and CLI source, checks
both hashed Python locks and all 21 Bun lockfiles, and audits advisory services.
Its canaries require a known unsafe source pattern and a vulnerable dependency
fixture to be detected. It does not claim complete static-analysis coverage.
Known temporary advisory exceptions are exact-version scoped and expire on
2026-12-11 in [Bun](../security/dependency-exceptions.json) and
[Python tool](../security/python-dependency-exceptions.json) policy files.

Run the main checks locally with the pinned tool versions in the workflows and
the [document sandbox dependencies](cv-artifact-safety.md) for the full Python
suite:

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

The full Python suite requires Bubblewrap and TeX on a host that permits
unprivileged namespace creation; its four real compiler cases are explicitly
deselected from the hosted `python-portable` suite. The hosted suite still
requires sandbox command-policy and fail-closed cases. Database authorization
requires a local Docker daemon. Each suite fails rather than silently skipping
its required cases. No live model, user CV, or production
database is needed. Local Gitleaks reports are ignored by Git and never uploaded
by CI. A zero-finding scan applies only to the scanned refs and detector rules.

## Phase 5 acceptance

The public repository has one sanitized root commit with a GitHub no-reply
author/committer address. Its initial Gitleaks history and worktree scans found
zero results. GitHub private vulnerability reporting, secret scanning, push
protection, Dependabot alerts and security updates are enabled. The pinned
CodeQL workflow covers Actions, JavaScript/TypeScript and Python on every PR;
the pinned dependency
review workflow checks pull requests.

Protected `main` requires a pull request, current passing results from nine
named checks, conversation resolution, and linear history. The rule applies to
administrators and disallows force pushes and deletion. A temporary
`eval(user_input)` [probe PR](https://github.com/ogto90/pairrole/pulls?q=is%3Apr+is%3Aclosed+label%3Asecurity-probe)
failed the required source scan, GitHub reported the PR blocked, and the PR was
closed without merging. CODEOWNERS requests security-file review, but the
single-owner repository requires zero independent approving reviews.

The `Job search` environment accepts only `main` and requires an owner review
before manual jobs can use any configured secrets, unless an administrator uses
GitHub's permitted bypass. Self-review is allowed and
no environment or repository application secrets are configured in this public
copy. Do not add production credentials without a separate ingress and
deployment review. CodeQL may flag the temporary TeX input file; review such findings in context
because the isolated compiler requires a plaintext source inside an owner-only
temporary directory that is removed after compilation. General local
diagnostics retention remains an A8 residual risk.

On 2026-11-11, the full Python regression suite passed locally as an ordinary
user with the real document sandbox: 170 passed, zero skipped. GitHub-hosted
Ubuntu 22.04 and 24.04 deny Bubblewrap's unprivileged network namespace setup
(`RTM_NEWADDR`), so the hosted gate runs the other 166 cases and records the
four real compiler cases as a separate local integration verification. This is
a coverage boundary, not proof that real compilation works on GitHub-hosted
runners. Re-run the full suite on a trusted, namespace-capable host before a
release and after changes to TeX, Bubblewrap, or sandbox configuration. Do not
attach a persistent self-hosted runner to public pull requests. Keep this section and the
[threat model](security-threat-model.md) current when repository settings
change.

Remaining application risks are explicit in the threat model: the Streamlit
deployment needs private ingress because it has no login (A1); AI content may
still mislead the model despite deterministic output checks (A3); privileged
workflows need a separate deployment review before credentials are added (A5); and general
Storage cleanup/account erasure are not complete (A8). The portfolio's CI
cannot establish hosted Supabase, provider retention, or live model behavior.
