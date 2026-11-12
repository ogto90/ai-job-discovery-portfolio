# Candidate-Level Discovery Tracing

## Rollout

Tracing is disabled unless `AI_JOB_SEARCH_TRACING_ENABLED=true`. Before turning
it on, apply the forward-only `discovery_candidate_traces` migration in the
target environment. The scheduled workflow leaves tracing disabled; manual runs
require the explicit opt-in input. A missing trace table or trace write failure
is reported in the run's `candidate_traces` summary and does not stop discovery.

Defaults and bounds:

- `AI_JOB_SEARCH_TRACE_MAX_CANDIDATES=5000` maximum source candidates retained
  per run; valid range is 1-50,000.
- `AI_JOB_SEARCH_TRACE_RETENTION_DAYS=30` trace retention; valid range is 1-365.
- `AI_JOB_SEARCH_TRACE_CLEANUP_BATCH=5000` maximum stale rows removed per
  enabled run; valid range is 1-5,000.
- Trace inserts are idempotent by `(search_run_id, candidate_identity)` and
  written in batches of 200. If the safety cap is reached, terminal rejected,
  failed, and skipped candidates take priority. `omitted_by_cap` reports any
  loss.
- Trace writes keep the 200-record batch size and have a 15-second total budget,
  with each request capped at 8 seconds and further capped by the remaining
  global budget. A timeout stops the sequence without retries; if the global
  deadline caused it, `budget_exhausted` is reported, otherwise it is a
  per-request `request_timeout`. The current batch remains an uncertain outcome
  because the server may have committed before the timeout.
- Retention cleanup remains independently bounded to 3 seconds, with each of
  its select/delete requests capped by the remaining cleanup budget. Cleanup is
  attempted on each trace-enabled persisted run, including runs with no
  candidates or failed trace writes. A cleanup failure is recorded in run-level
  trace stats and retried on a later eligible run.
- `candidate_traces.write` distinguishes selected records, prepared/attempted/
  successful/failed/unattempted batches, confirmed write failures, ambiguous
  request outcomes, budget-skipped records, failure kind, and elapsed write time.
  The counters reconcile as:
  `selected_for_persistence = records_persisted + records_failed_write + records_outcome_unknown + records_not_attempted`;
  and `records_not_attempted = records_skipped_after_failure + records_skipped_due_budget`.
- The legacy `candidate_traces.persistence_failures` field means records not
  confirmed persisted. It includes confirmed rejected writes, uncertain outcomes,
  and records skipped after a stop; it is not a count of individual database errors.
- A timeout or network loss can leave the current batch's commit status unknown.
  Writes use the unique `(search_run_id, candidate_identity)` conflict key, so an
  operator-approved replay of the same trace records is deduplicated by the database.
- Retention cleanup touches only `discovery_candidate_traces`; it never removes
  jobs, source observations, run associations, or job-history data.

The cap is per run, and cleanup is bounded per enabled run. Production volume
should be checked after a few runs before changing defaults.

## Read-Only Diagnostics

The CLI requires server-side `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. It only
issues GET requests. Use a specific filter and keep output local:

```bash
bun run scripts/query_discovery_candidate_traces.ts --run-id 47
bun run scripts/query_discovery_candidate_traces.ts --url 'https://jobs.example/jobs/123'
bun run scripts/query_discovery_candidate_traces.ts --company 'Example Inc' --reason-code LOCATION_INCOMPATIBLE
bun run scripts/query_discovery_candidate_traces.ts --ats-provider greenhouse --ats-board board-token --run-id 47
```

Supported filters include run ID, source, exact company, URL, query-reference
fingerprint, reason code, final outcome, and ATS board. Results are limited to
the configured retention window by default and capped at 100 rows. A missing
match is reported as `NOT OBSERVED IN AVAILABLE DISCOVERY TRACES`, not as proof
that a source rejected or never returned the job. Run-level trace aggregates
are printed when `--run-id` is supplied.

## Trace Semantics

Each record represents a source-scoped candidate identity for one search run.
Candidates from different providers remain distinct even if they later resolve
to the same `physical_job_id`. ATS records retain provider, board, requisition,
board outcome, and snapshot completeness. A weak, deterministic hash is used
only when a source ID and usable listing URL are absent; no ATS requisition ID
is invented. `raw_candidate_observations` counts rows emitted by provider
adapters after their existing same-source query deduplication;
`unique_source_candidates` counts trace identities; `unique_physical_jobs`
counts distinct linked job IDs, not source observations; and
`persisted_source_observations` counts trace records linked to a physical job.
Final eligibility facts also retain the existing deterministic work-model
classification (`remote`, `hybrid`, `onsite`, or `unknown`). The eligibility
engine folds work-model and geographic constraints into its location verdict,
so the trace does not invent a more specific rejection reason when the engine
only reports `ineligible`.

Queries are represented by a SHA-256 fingerprint, not raw search terms. URLs
have credentials, query strings, and fragments removed. The trace excludes
full job descriptions, SearchProfile/CandidateProfile contents, CVs, secrets,
cookies, and raw provider/HTTP exception bodies. The validation result includes
status, method, confidence, HTTP status when available, and a redacted reason.
The bounded stage history stores structured reason codes, not free-form
eligibility explanations.

Candidate-level tracing starts with candidates emitted by a provider adapter.
It cannot explain a listing the source never returned, internal provider-side
filtering, or individual malformed rows discarded inside a CLI parser unless
that adapter exposes those rows. Such cases remain source/board-level evidence
only; no missing candidate evidence is fabricated.

## Reason Codes

| Stage | Codes emitted by existing decisions |
| --- | --- |
| Acquisition | `SOURCE_SUCCESS`, `SOURCE_PARTIAL`, `SOURCE_RATE_LIMITED`, `SOURCE_TIMEOUT`, `SOURCE_FAILED` |
| Parsing | `PARSE_SUCCESS`, `MISSING_REQUIRED_FIELD`, `INVALID_JOB_URL` |
| Initial role screen | `ROLE_RELEVANT`, `ROLE_ADJACENT`, `ROLE_UNRELATED`, `ROLE_EXCLUDED`, `ROLE_UNCERTAIN` |
| Initial/final preferences | `LOCATION_ELIGIBLE`, `LOCATION_INCOMPATIBLE`, `LOCATION_UNRESOLVED`; equivalent `LANGUAGE_*`, `EMPLOYMENT_TYPE_*`, and `SENIORITY_*` codes |
| Verification | `LISTING_ACTIVE`, `LISTING_EXPIRED`, `LISTING_UNCERTAIN`, `LISTING_VALIDATION_FAILED`, `LISTING_UNVERIFIED`, `VALIDATION_NOT_ATTEMPTED` |
| JD hydration | `JD_AVAILABLE`, `JD_HYDRATION_UNRESOLVED`, `JD_HYDRATION_NOT_NEEDED_OR_NOT_SELECTED`, `JD_HYDRATION_NOT_ATTEMPTED` |
| Identity | `DUPLICATE_SOURCE_OBSERVATION`, `IDENTITY_UNRESOLVED`, `IDENTITY_RESOLUTION_ATTEMPTED`, `EXISTING_PHYSICAL_JOB_CANDIDATE`, `NEW_PHYSICAL_JOB`, `EXISTING_PHYSICAL_JOB`, `IDENTITY_CONFLICT` |
| Final eligibility | `ROLE_*_AFTER_EVIDENCE`, dimension-specific eligibility codes, `ELIGIBLE_FOR_REVIEW`, `RETAINED_FOR_REVIEW` |
| Persistence | `CREATED`, `UPDATED`, `SUPPRESSED`, `PERSISTENCE_FAILED`, `SUPPRESSION_CHECK_FAILED`, `RUN_ASSOCIATION_FAILED`, or the final role-filter reason |

Source outcomes with zero candidates remain in `candidate_traces.acquisition_sources`
and existing provider/ATS diagnostics. They do not create fabricated
candidate-trace rows.
