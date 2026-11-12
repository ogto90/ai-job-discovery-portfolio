# Interview Preparation Phase 2

Phase 2 adds an explicitly generated, persistent preparation pack to a saved Interview Prep round. Opening or refreshing a round only reads saved state; it never calls OpenAI. Generation and regeneration require the user to confirm private-context transmission and click the action.

## Inputs and provenance

- The role and job description come from the immutable Phase 1 `source_context` snapshot, never the current `jobs` row.
- Fit strengths and gaps are loaded by the exact saved assessment ID and checked against the owning user. A missing reference is disclosed; a newer Fit result is never substituted.
- Candidate evidence comes from the saved CandidateProfile snapshot and is validated with `CandidateProfile`. Evidence IDs are retained for claim references.
- The saved submitted-CV artifact is retrieved only from the private server-side Storage path and checked against its saved SHA-256. Profile `source_cv_version_id` is compared with the submitted CV ID. Missing or mismatched provenance is disclosed; no other/latest CV is substituted.
- Company research receives only public company name and role title. Candidate profile, CV, JD, notes, and application context are sent only in the separate structured generation call after explicit consent.

## Research, citations, and output

The research call uses the OpenAI Responses API `web_search` tool, with a maximum of three tool calls and a bounded response. `OPENAI_API_KEY` is read server-side. `INTERVIEW_PREP_MODEL` selects the model; `OPENAI_MODEL` is the fallback. Configure a model/account that supports Responses `web_search` and Structured Outputs. Live compatibility is not established by mocked tests.

Only HTTPS citations returned as Responses search results or citation annotations are retained. Source IDs are deterministic hashes of retrieved title and URL; unsafe URLs, credentials in URLs, unknown source IDs, and verified company claims without citations are rejected. Structured output is Pydantic-validated and contains seven sections: company intelligence, JD analysis, personal experience mapping, stage-specific interview questions, knowledge-gap preparation, interviewer questions, and final briefing. Candidate evidence references must resolve to the saved profile. Structured output is not treated as proof of factual accuracy.

If public research fails, generation may continue as a clearly disclosed JD-grounded pack. Without source metadata, no company-specific claim can be labeled verified. The model does not author URL citations.

## Persistence and recovery

Migration: `supabase/migrations/20261027120937_interview_preparation_packs.sql`.

One private row per preparation stores the current successful pack, source fingerprint, model, safe research sources, timestamps, token usage, and attempt state. RLS is enabled; direct `anon` and `authenticated` grants are revoked; server-side `service_role` access and narrowly scoped security-definer RPCs handle ownership checks, generation claims, atomic completion, and failure state. A 15-minute lease allows recovery after an interrupted request. A failed regeneration changes attempt status but leaves the last successful `pack_json` intact. Only a matching active claim can replace it.

The fingerprint covers the round ID, frozen JD, CV/profile/Fit snapshots, interview type, interviewer role/notes, and prompt/schema versions. Changed metadata marks the displayed pack stale; refresh never regenerates it.

No credentials or prompts are persisted in diagnostics. Token counts are stored, not price estimates. API requests have bounded timeouts, no automatic retries, limited web calls, and bounded CV input (5 MiB; LaTeX text further limited to 30,000 characters).

## Testing and deployment

Focused mocked tests live in `tests/test_interview_preparation_pack.py` and `tests/test_interview_prep_ui.py`. They use synthetic records and do not call OpenAI. The optional disposable DB/RLS suite must run only against explicitly configured local loopback services. Apply the migration to the intended non-production/production Supabase project before enabling the UI action. This implementation does not apply migrations or change application/job lifecycle state.

## Limitations

- Live model, web-search, citation-annotation, and private PDF-input compatibility require a separately authorized synthetic API smoke test.
- RLS and RPC runtime behavior require migration execution against a disposable PostgreSQL/Supabase instance; static SQL review and mocked RPC tests do not prove database behavior.
- The generated content is preparation assistance, not verified company interview questions or a substitute for checking source material.
