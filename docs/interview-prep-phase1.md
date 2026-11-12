# Interview Preparation Phase 1

Interview Prep is available on existing application cards in **Applications**. Open an application, select a saved round or create a new one, choose an interview type, and optionally add a date in Europe/Vienna time, interviewer details, and notes. Saved rounds reopen independently and metadata edits do not refresh their original source context.

The six interview types are recruiter screening, hiring manager, technical, behavioral, leadership/final, and custom. The schedule is optional. A round without essential source material is a draft; a missing Fit evaluation alone does not block creation.

## Submitted CV and source context

`applications.cv_version_id` is not reliable submitted-CV provenance: the existing **Mark applied** action records the active base CV. The new nullable `applications.submitted_cv_version_id` is set only after explicit confirmation in Interview Prep. If that value is absent, the UI offers the application's recorded CV and job-linked tailored versions, but selects none automatically. If no supported associated version is available, a draft can be created with an explicit missing-CV state.

Each preparation stores a private, immutable `source_context` snapshot of application status, company, job title, description, selected CV metadata, CandidateProfile data/version, and Fit evaluation version/score at creation. For an available selected CV, the server copies its artifact to a private `cv-artifacts/interview-preparations/` path and stores its SHA-256, bucket, and path. If the source artifact has already been removed or cannot be read, the round remains a draft and records that the artifact is unavailable. This retained copy is separate from routine tailored-CV expiry and archive cleanup. The service-role-only table must not be exposed to browser clients.

The snapshot is not changed by later base-CV changes, job-description edits, or interview metadata updates. Creating a round does not change the application's lifecycle status. A unique per-user request key makes retries and Streamlit reruns return the same round rather than creating duplicates. A different key creates a separate round.

## Database and security

Apply `supabase/migrations/20261022220000_interview_preparations.sql` **before** deploying the UI/backend code. It adds one nullable submitted-CV provenance column to `applications`, a composite ownership FK, and the `interview_preparations` table with application/job/CV/profile/Fit references, an idempotency constraint, an application-order index, and an update guard for frozen source fields. Application deletion is restricted while preparations exist; user deletion follows existing user-scoped cascade conventions. Job archive and CV deactivation do not remove preparation history.

RLS is enabled. `anon` and `authenticated` receive no table access; only `service_role` can read/write through the existing local-only Streamlit server. CV snapshots reside in the existing private `cv-artifacts` bucket. The UI renders source values as text and does not display credentials or raw CV contents.

## Verification and release

Run the Python and Bun suites, the Streamlit AppTest tests, and a fresh disposable PostgreSQL migration/RLS check. `tests/test_interview_preparation_local.py` exercises the real REST persistence path when `INTERVIEW_PREP_LOCAL_API`, `INTERVIEW_PREP_LOCAL_PG`, `INTERVIEW_PREP_LOCAL_DB`, and `INTERVIEW_PREP_LOCAL_PG_PASSWORD` point to **disposable loopback-only** services with synthetic data. The test refuses remote endpoints and requires a database name beginning `phase1_`; never point it at production. Verify the migration and storage bucket in the target environment before deploying the app. Production migration, code deployment, and any backfill require separate approval.

Phase 1 does not research companies, generate questions, conduct mock interviews, call OpenAI, or schedule calendar events. Historical CV provenance remains user-confirmed because the existing application record never proved the exact document sent. A missing/deleted source CV artifact cannot be reconstructed automatically. Supabase Storage objects are outside PostgreSQL cascades: when removing an entire user account, an operator must also remove that user's `interview-preparations/<user-id>/` objects from the private bucket.
