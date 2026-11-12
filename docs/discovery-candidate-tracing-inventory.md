# Discovery Candidate Decision-Point Inventory

Baseline: `main` at `00047ba9ef5d1b8f07b7d2fb1f2f6e223fb36edf`.

This inventory describes the existing pipeline before candidate tracing. It is
diagnostic only; no eligibility rule or operation order is changed here.

| Stage | File / function | Decision and current evidence | Candidate survives? | Previously observable? |
| --- | --- | --- | --- | --- |
| Source selection | `tools/job_pipeline.ts` / `diagnoseSourceSelection`; `tools/source_capabilities.ts` | Selects providers by skill availability and required environment. Missing credentials and disabled/unavailable providers are summarized per source. | No candidate exists yet. | Run-level source selection only. |
| Portal acquisition | `tools/job_pipeline.ts` / `makeCliSourceRunnerWithCommand`; portal CLIs under `.agents/skills/*/cli` | Executes provider/query/page calls; records query/page counts, status, returned counts, and provider command error. Providers may prefilter results internally. | Returned candidates proceed. | Source-level details; provider-side candidate exclusions unavailable. |
| CLI result parsing | `tools/job_pipeline.ts` / `parseJobs` | A malformed JSON response or unrecognized payload fails the source result. Individual provider parser rules are inside portal CLIs. | Parsed rows proceed; parse failure yields no jobs from that response. | Source-level parser/error status, not per-candidate. |
| Same-source query dedupe | `tools/job_pipeline.ts` / `makeCliSourceRunnerWithCommand` | `uniqueKey` merges candidates across queries; query strings are accumulated in metadata, page/query is overwritten by the latest observation. | One candidate proceeds. | Counts only; merged observations not individually represented. |
| ATS registry and board rotation | `tools/ats_board_registry.ts` / `loadAtsCompanyRegistry`; `tools/ats_job_ingestor.ts` / `runAtsJobIngestion` | Loads mappings, validates them, applies deterministic selection/budget/freshness; records selected/deferred/invalid mappings and registry source. | Selected valid boards are fetched. | Board/run-level diagnostics. Invalid/unselected boards have no candidate. |
| ATS request and parsing | `tools/ats_job_ingestor.ts` / `fetchAtsBoard`, provider parsers, `runAtsJobIngestion` | Preserves board status, HTTP status, completeness, errors, and parsed `allJobs`. Per-row parse rejects are not consistently emitted by provider parsers. | Parsed postings proceed. | Board results and aggregate counts; dropped malformed rows generally not identifiable. |
| Normalization | `tools/generic_discovery.ts` / `normalizeDiscoveredJob` | Resolves metadata and defaults absent title/company to placeholders; returns `null` only when source is absent. | Almost all rows proceed, even with unresolved metadata. | Aggregate normalized count and metadata issue counts later. |
| Cross-query/same-source merge | `tools/generic_discovery.ts` / `mergeDiscoveredJobs` | Merges by source-scoped identity and prefers richer description; merges some acquisition query metadata. | One normalized candidate per identity. | Aggregate normalized count; individual merged observation not retained. |
| Initial role screen | `tools/generic_discovery.ts` / `verifyAndHydrateDiscoveredJobs` | `unrelated` and `excluded` roles do not enter `evidenceCandidates`. | No; skipped before liveness/JD work. | Aggregate exclusion counters only. |
| Early preference screen | `tools/generic_discovery.ts` / `verifyAndHydrateDiscoveredJobs` | Known-incompatible location, language, employment type, or seniority excludes the candidate from evidence work. Unknown values are not treated as incompatible. | No for known mismatch; yes otherwise. | Aggregate counters, not candidate-level. |
| Liveness verification | `tools/job_availability_validator.ts` / `validateJobs`, `validateJobAvailability` | Returns active/expired/uncertain/validation_failed with method, reason, status, and cache/network facts. Expired candidates are excluded from `results` but retained in `all`; the generic flow uses `all`. ATS API-verified active rows bypass another request. | All evidence candidates continue to classification; status remains attached. | Candidate result available in memory; run aggregate persisted. |
| JD hydration | `tools/job_detail_enrichment.ts` / `enrichJobs` | Active candidates with incomplete descriptions may be enriched; stats distinguish success/not-found/unsupported/failure/429/timeout by source. | Candidate remains with original/enriched description. | Aggregate per-source enrichment metrics; no durable per-candidate outcome. |
| Post-JD role screen | `tools/generic_discovery.ts` / `classifyTargetRoleAfterDescription`; `runGenericDiscovery` persistable filter | Reclassifies adjacent roles after JD, then removes unrelated/excluded roles from `persistableJobs`. | No for final unrelated/excluded; yes for target/adjacent and one unresolved-adjacent case. | Aggregate `filtered_irrelevant`; no per-candidate reason. |
| Existing-job / physical identity resolution | `tools/job_identity.ts`; `tools/generic_discovery.ts` / `SupabaseDiscoveryStore.upsertJob` | Resolves source observation and physical job through canonical identity RPC, or legacy source identity. URL collisions/conflicts are skipped. | Created/updated job, or identity conflict is skipped. | Persisted source observations and run-to-job associations for successful resolutions; conflicts only run errors. |
| Suppression | `tools/generic_discovery.ts` / `isSuppressed` | Application/history suppression is checked after upsert. | Suppressed records are associated to run but not treated actionable. | `search_run_jobs.discovery_context` for persisted jobs. |
| Final preference classification | `tools/generic_discovery.ts` / `evaluateFinalJobEligibility` | Separates role, location, language, employment, seniority, metadata, and actionable state. Mismatches/uncertainty are retained rather than filtered at this stage. | Yes, unless previously screened or final role filter excludes it. | Detailed context stored for successful run associations. |
| Lifecycle reconciliation | `tools/ats_job_ingestor.ts` and `tools/generic_discovery.ts` / `closeAtsJobs` | Only closed postings from complete ATS snapshots are reconciled; failed/partial snapshots do not assert absence. | Existing physical job lifecycle may change only on explicit complete-board absence evidence. | Search-run stats and lifecycle/source-observation data. |
| Run association and completion | `tools/generic_discovery.ts` / `associateRunJobs`, `finishSearchRun` | Persists one run-to-physical-job association with consolidated source context, then final status/stats. | — | Run-level stats and associations, but candidates rejected before upsert are absent. |

## Observability Boundary

No candidate record can be emitted for a job that a provider never returned.
Likewise, an upstream provider's own hidden filters, unavailable pages, or
individual malformed rows are only explainable if that provider exposes the
relevant data. Existing source/board statuses and counts can establish that a
source failed or a snapshot was incomplete, but they cannot prove why a
specific unreturned listing was absent.

The new trace model must therefore preserve each returned source observation,
including its source identity and query references, while separately linking
it to a physical job only after identity resolution. `search_run_jobs` remains
the physical-job association layer; it is not a substitute for traces of
pre-persistence candidates.
