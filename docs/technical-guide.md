# Technical guide

[Project overview](../README.md)

## How it fits together

Streamlit provides the workspace. Python handles candidate profiles, role comparisons and application documents; TypeScript and Bun collect job listings. Supabase stores records and private documents, and selected AI workflows call OpenAI.

Discovery and evaluation are separate: collecting listings does not automatically trigger an AI assessment. Search preferences describe the roles a user wants; the candidate profile records evidence from their CV. Users review uncertain listings and generated content before acting.

| Area | Starting point |
| --- | --- |
| App and review workflows | [app.py](../app.py) and [ui/](../ui/) |
| Candidate evidence and evaluation | [matching/](../matching/) |
| Discovery and source adapters | [tools/](../tools/) |
| Security boundaries | [Security overview](security-threat-model.md) |

## Local setup

This is a personal, server-configured application, not a public multi-user service or a credential-free demo. A fresh checkout needs a database, an owner identity, and profile data before the full workflow is usable.

### Prepare the deployment

1. Use Python 3.12 (recommended) and Bun for discovery. PDF compilation additionally needs Linux, TeX, Bubblewrap, and the dependencies described in [CV artifact safety](cv-artifact-safety.md).
2. Prepare your own Supabase project with the active [database migrations](../supabase/migrations/), a user identity for the application records, and private `cv-artifacts` storage. The [migration history](supabase-migration-history.md) explains the baseline and archived SQL; archived migrations are historical material, not an additional migration chain to replay.
3. Keep the Supabase secret key in trusted server configuration. The app selects its owner from server configuration rather than a browser-controlled user selector; that is not a public sign-in flow.

Database provisioning is a separate setup step. Starting Streamlit does not create the required schema, owner identity, or storage configuration.

### Install and configure

From the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --require-hashes -r requirements-lock.txt
cp .env.example .env
```

Fill in `.env` using your own values:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SECRET_KEY` | Server-side database and storage access |
| `AI_JOB_SEARCH_USER_ID` | Existing user UUID for this app instance |
| `OPENAI_API_KEY` | AI evaluation, CV parsing/tailoring, recommendations, and preparation packs |

Some job sources need additional API credentials and CLI dependencies. Consult the selected source's instructions under `.agents/skills/<source>/` and the [workflow configuration](../.github/workflows/job-discovery.yml).

```bash
streamlit run app.py
```

In **Profile**, upload and parse a LaTeX base CV, review the resulting candidate evidence, and save job preferences. Start discovery from **Settings**, then review the saved listings in **Jobs**. AI requests can incur API charges.

### Manual GitHub Actions runs and forks

The public portfolio copy disables automatic discovery and summary writes. The [discovery workflow](../.github/workflows/job-discovery.yml) and [summary-builder workflow](../.github/workflows/dashboard-summary-builder.yml) can be run manually after configuring your own project. The discovery workflow defines request budgets, optional tracing, source credentials, and ATS rotation settings.

A fork needs `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `AI_JOB_SEARCH_USER_ID` environment secrets, plus any selected source credentials. Set the `SUPABASE_PROJECT_REF` environment variable to the exact project ref. The jobs reference the **Job search** environment and expect a populated, verified ATS registry in Supabase.

Review the workflows and your environment's branch restrictions before running them. The summary-builder commands require `--expected-project-ref` and an explicit `--allow-production` flag for hosted writes. Adding secrets alone does not make these workflows portable.

## Verification

```bash
pip install --require-hashes -r requirements-lock.txt
pytest -q
bun test tests
```

Tests cover candidate evidence, discovery, application workflows and artifact handling. Some integration tests require a disposable local database or a host that supports the document sandbox. See [security checks](security-implementation-plan.md) for those requirements and the CI coverage boundary.

Source availability depends on provider access and credentials. AI output needs review. Keep real CVs, application records, credentials and diagnostics outside version control.
