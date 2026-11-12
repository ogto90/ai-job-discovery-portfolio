# PairRole

**Job research and application tracking, with security controls for untrusted inputs.**

A personal workspace that discovers roles, evaluates them against CV evidence, and tracks applications through interview preparation. It combines Python/API automation, structured AI workflows and application security.

**My contribution:** product design, workflow direction and security requirements, using OpenAI Codex for implementation. The code and tests below show the controls, engineering choices and limitations behind the application.

This public portfolio copy uses synthetic candidate evidence and contains no live
credentials or CVs. Discovery and summary Actions run manually after a user
configures their own private database and environment secrets.

**Python · TypeScript · Streamlit · Supabase/PostgreSQL · OpenAI API · GitHub Actions**

[Security controls](#security) · [Engineering decisions](#engineering-decisions) · [Run locally](#run-locally)

## The workflow

<p>
  <img src="assets/readme/workflow.svg" width="100%" alt="Discover listings → check eligibility → review fit and evidence → track applications. You choose which jobs to evaluate and pursue.">
</p>

1. **Discover and check.** Search job portals and company hiring boards, merge duplicate listings, enrich descriptions, and flag unresolved location, language, or availability questions.
2. **Evaluate with evidence.** Rate selected jobs against a structured candidate profile, with separate fit, evidence coverage, confidence, and gap information.
3. **Prepare and track.** Tailor a CV, review its changes, export a PDF, track application stages, and save interview preparation with the relevant source context. Recurring skill gaps inform improvement recommendations.

## Engineering decisions

The central design constraint: **a skill mentioned on a CV is not proof of professional experience.** The [candidate evidence model](matching/candidate_profile.py) enforces that distinction, and [regression tests](tests/test_candidate_profile.py) check that fundamentals cannot become production ownership.

- **Separate acquisition from AI.** The [TypeScript discovery pipeline](tools/generic_discovery.ts) collects and checks listings independently of OpenAI. Users initiate evaluation; the app does not submit applications.
- **Treat incomplete data explicitly.** [ATS ingestion](tools/ats_job_ingestor.ts) distinguishes complete snapshots from partial or failed crawls, so a failed search is not evidence that a job has closed.
- **Preserve decision context.** Assessments retain profile-version context, while [interview preparation](docs/interview-prep-phase1.md) preserves source snapshots and submitted-CV provenance.
- **Control read volume.** [Dashboard summaries](ui/dashboard_summary.py) support paginated reads and on-demand details. [Request metrics](scripts/postgrest_egress_report.py) help inspect response volume without logging response content.
- **Sandbox generated documents.** [LaTeX compilation](matching/latex_sandbox.py) uses network isolation and resource limits, and fails closed when the sandbox is unavailable.

## Security

The security work focuses on the application's actual trust boundaries:

| Boundary | Control | Review the evidence |
| --- | --- | --- |
| Job-source HTTP requests | Destination validation, DNS pinning, redirect checks and response limits | [Client](tools/safe_http.ts) · [Tests](tests/safe_http.test.ts) |
| Uploaded and generated LaTeX | Network and filesystem isolation, disabled shell escape, resource limits and fail-closed compilation | [Sandbox](matching/latex_sandbox.py) · [Tests](tests/test_cv_artifact_safety.py) |
| User records | User-scoped authorization checks, database constraints and row-level security | [Database authorization tests](tests/security/test_database_authorization.py) |
| AI responses | Typed outputs, evidence-reference checks and rejection before downstream actions | [Safeguards and limitations](docs/security-threat-model.md#phase-46-deterministic-ai-safeguards) |
| Code delivery | Secret/dependency scans, CodeQL, pull-request dependency review and security regressions | [Workflows](.github/workflows/) |

**Verification scope:** CI runs portable sandbox-policy checks. Four real Bubblewrap/TeX integration tests run on a trusted local host because GitHub-hosted runners deny the required namespace setup. Offline AI tests verify validation and side effects; they do not establish prompt-injection resistance or model accuracy.

**Deployment boundary:** the app has no login and requires private ingress. The server uses a privileged Supabase credential, so application ownership checks remain essential. See the [implementation evidence](docs/security-implementation-plan.md), [threat model](docs/security-threat-model.md) and [vulnerability reporting policy](SECURITY.md).

## Inside the project

Streamlit provides the workspace; Python handles candidate evidence, matching, and CV workflows. TypeScript and Bun run discovery. Supabase persists listings, decisions, and assessments, with generated documents in private storage. GitHub Actions invokes the same discovery launcher used locally.

| Explore | Code |
| --- | --- |
| App and review workflows | [`app.py`](app.py) · [`ui/`](ui/) |
| Candidate evidence and AI evaluation | [`matching/`](matching/) |
| Discovery and source adapters | [`tools/`](tools/) · [`.agents/skills/`](.agents/skills/) |
| Database migrations | [`supabase/migrations/`](supabase/migrations/) |
| Python and TypeScript regression tests | [`tests/`](tests/) |

## Run locally

Use Python 3.12 (recommended), Bun for discovery, and a configured Supabase project with the repository's migrations applied. Set your project credentials and user UUID in `.env`; AI features also require an OpenAI API key.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Configure .env before starting.
streamlit run app.py
```

See the [technical guide](docs/technical-guide.md) for configuration and manual discovery. PDF generation requires Linux, TeX, and the [document sandbox dependencies](docs/cv-artifact-safety.md).

<details>
<summary><strong>Run the tests</strong></summary>

```bash
pip install -r requirements-dev.txt
pytest -q
bun test tests
```

Some integration checks require local sandbox dependencies. Source-specific CLI setup lives under `.agents/skills/<source>/cli/`.

</details>

**Scope:** A personal, server-configured app with no credential-free demo. Source availability depends on the provider, profile, and credentials; AI outputs need review. Keep credentials, CVs, and generated application documents outside version control.

[MIT License](LICENSE)
