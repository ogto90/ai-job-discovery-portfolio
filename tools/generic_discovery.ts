import { recordPostgrestResponse } from "./postgrest_metrics"
/**
 * Profession-neutral SearchProfile-driven discovery and ingestion.
 *
 * This layer intentionally stops after acquisition, lifecycle validation,
 * suppression, and persistence. Matching, requirement extraction, and Fit
 * scoring belong to a later milestone.
 */

import { randomUUID } from "node:crypto"
import { makeCliSourceRunner, type PipelineOptions, type PipelineSourceStatus, type SourceRunResult } from "./job_pipeline"
import { diagnoseSourceSelection, type SourceRunDetail } from "./job_pipeline"
import type { SourceSelectionDiagnostic } from "./source_capabilities"
import { validateJobs, normalizeCacheUrl, type AvailabilityValidation, type NormalizedJob, type ValidationStats } from "./job_availability_validator"
import { emptyEnrichmentStats, enrichJobs, formatEnrichmentSummary, needsEnrichment, type EnrichmentStats } from "./job_detail_enrichment"
import { postingLanguage } from "./posting_language"
import { classifyJobDescription, isUsableFullJobDescription } from "./job_description_quality"
import { jobMetadataIssues, resolveJobMetadata } from "./job_metadata"
import { classifyWorkModel } from "./work_model"
import { sourceObservationFor, storageObservation } from "./job_identity"
import { DEFAULT_REGISTRY_PATH } from "./company_registry"
import { DEFAULT_JOB_HISTORY_PATH, type JsonJobHistoryStore } from "./job_history"
import type { HistoricalJob } from "./job_history"
import { runAtsJobIngestion, type AtsIngestionOptions, type AtsIngestionStats, type AtsFetchResult } from "./ats_job_ingestor"
import {
  appendTraceEvent,
  candidateTracingEnabled,
  capCandidateTraces,
  createCandidateTrace,
  sanitizeTraceReason,
  sanitizeTraceUrl,
  traceCleanupBatchSize,
  traceCandidateLimit,
  traceRetentionDays,
  traceSummary,
  type CandidateTraceEvent,
  type CandidateTraceRecord,
} from "./discovery_candidate_tracing"

export type DiscoveryMode = "targeted" | "broad"
export type DescriptionKind = "full" | "snippet" | "missing"
export type AssociationOutcome = "new" | "rediscovered" | "suppressed" | "expired" | "validation_failed" | "unknown"

export interface SearchProfileDefinition {
  target_titles?: string[]
  targetTitles?: string[]
  target_terms?: string[]
  targetTerms?: string[]
  target_adjacent_terms?: string[]
  role_families?: string[]
  roleFamilies?: string[]
  industries_or_domains?: string[]
  industriesOrDomains?: string[]
  locations?: string[]
  allowed_regions?: string[]
  allowed_countries?: string[]
  excluded_regions?: string[]
  excluded_countries?: string[]
  work_models?: string[]
  workModels?: string[]
  language_constraints?: Array<{ language?: string; required?: boolean }>
  languageConstraints?: Array<{ language?: string; required?: boolean }>
  accepted_languages?: string[]
  accepted_employment_types?: string[]
  excluded_employment_types?: string[]
  employment_types?: string[]
  target_seniority?: string[]
  accepted_seniority?: string[]
  excluded_seniority?: string[]
  remote_only?: boolean
  english_only?: boolean
  positive_concepts?: string[]
  positiveConcepts?: string[]
  excluded_title_patterns?: string[]
  excluded_titles?: string[]
  excluded_terms?: string[]
  excludedTitles?: string[]
  excluded_concepts?: string[]
  excludedConcepts?: string[]
  [key: string]: unknown
}

export interface SearchProfileRecord {
  id: number
  user_id: string
  name: string
  definition: SearchProfileDefinition
  min_fit_score: number
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface DiscoveredJob {
  source: string
  sourceJobId: string | null
  sourceUrl: string | null
  applicationUrl: string | null
  company: string
  title: string
  location: string | null
  remoteScope: string | null
  employmentType: string | null
  description: string | null
  descriptionKind: DescriptionKind
  postedAt: string | null
  raw: NormalizedJob
  validation?: AvailabilityValidation
  metadataIssues?: string[]
}

export interface DiscoveryStats {
  source_count: number
  raw_discovered: number
  normalized: number
  new_jobs: number
  existing_jobs: number
  suppressed: number
  expired: number
  validation_failed: number
  unknown: number
  validation_skipped: number
  early_unrelated_exclusions: number
  early_preference_exclusions: number
  filtered_irrelevant: number
  filtered_ineligible: number
  preference_mismatches_retained: number
  eligibility_unclear_retained: number
  target_matches: number
  target_adjacent: number
  unrelated: number
  excluded: number
  location_ineligible: number
  location_unclear: number
  language_ineligible: number
  language_unclear: number
  employment_type_ineligible: number
  employment_type_unclear: number
  seniority_ineligible: number
  metadata_unresolved?: number
  target_adjacent_sent_for_evidence: number
  location_unclear_sent_for_evidence: number
  liveness_failures: number
  jd_hydration_successes: number
  jd_hydration_failures: number
  jd_hydration?: EnrichmentStats
  jd_hydration_summary?: string
  role_resolved_after_jd: number
  location_resolved_after_jd: number
  final_actionable: number
  fit_ready: number
  active_actionable: number
  fit_calls: number
  cache_hits: number
  ats_boards_considered: number
  ats_boards_crawled: number
  ats_boards_success: number
  ats_boards_empty: number
  ats_boards_partial: number
  ats_boards_failed: number
  ats_boards_rate_limited: number
  ats_boards_skipped: number
  ats_boards_deferred_budget: number
  ats_rotation_slot?: number | null
  ats_selected_boards?: string[]
  ats_boards_invalid_mapping: number
  ats_jobs_raw: number
  ats_jobs_unique: number
  ats_jobs_relevant: number
  ats_jobs_retained: number
  ats_jobs_actionable: number
  ats_jobs_preference_mismatch: number
  ats_jobs_unclear: number
  ats_historical_jobs_closed: number
  ats_registry_source?: "local" | "supabase" | "unavailable"
  ats_registry_warning?: string
  ats_job_rows_closed: number
  portal_candidates: number
  combined_unique_candidates: number
  validation_network_checks: number
  timings_ms: Record<string, number>
  ats_provider_counts: Record<string, number>
  physical_identity_mode: "canonical" | "legacy_compatibility" | "unknown"
  errors: Array<{ source: string; message: string; category?: PipelineSourceStatus }>
  provider_selection?: SourceSelectionDiagnostic[]
  candidate_traces?: {
    enabled: boolean
    attempted: number
    persisted: number
    raw_candidate_observations?: number
    unique_source_candidates?: number
    unique_physical_jobs?: number
    persisted_source_observations?: number
    omitted_by_cap: number
    persistence_failures: number
    retention_pruned: number
    retention_failures: number
    retention_days: number
    write?: CandidateTraceWriteStats
    by_source?: Record<string, number>
    by_reason?: Record<string, number>
    acquisition_sources?: Array<{ source: string; status: string; jobs_returned: number }>
  }
}

export type CandidateTraceWriteFailureKind =
  | "http_4xx"
  | "http_5xx"
  | "http_unexpected"
  | "request_timeout"
  | "network_error"
  | "unsupported_store"
  | "store_error"
  | "budget_exhausted"
  | null

export interface CandidateTraceWriteStats {
  selected_for_persistence: number
  batches_prepared: number
  batches_attempted: number
  batches_succeeded: number
  batches_failed: number
  batches_not_attempted: number
  records_persisted: number
  records_failed_write: number
  records_outcome_unknown: number
  records_not_attempted: number
  records_skipped_after_failure: number
  records_skipped_due_budget: number
  write_budget_exhausted: boolean
  write_duration_ms: number
  write_failure_kind: CandidateTraceWriteFailureKind
  write_http_status?: number
  write_error_code?: string
}

export interface CandidateTracePersistenceResult {
  /** Legacy alias: records not confirmed persisted, including ambiguous and unattempted rows. */
  failures: number
  /** Legacy count: records in batches receiving successful HTTP responses. */
  persisted: number
  diagnostics?: CandidateTraceWriteStats
}

function emptyCandidateTraceWriteStats(selected = 0): CandidateTraceWriteStats {
  return {
    selected_for_persistence: selected,
    batches_prepared: 0,
    batches_attempted: 0,
    batches_succeeded: 0,
    batches_failed: 0,
    batches_not_attempted: 0,
    records_persisted: 0,
    records_failed_write: 0,
    records_outcome_unknown: 0,
    records_not_attempted: 0,
    records_skipped_after_failure: 0,
    records_skipped_due_budget: 0,
    write_budget_exhausted: false,
    write_duration_ms: 0,
    write_failure_kind: null,
  }
}

export interface DiscoveryRunResult {
  runId: number | string
  profile: SearchProfileRecord
  mode: DiscoveryMode
  queries: string[]
  stats: DiscoveryStats
  jobs: DiscoveredJob[]
  sourceDetails: DiscoverySourceDetail[]
  sourceSelection: SourceSelectionDiagnostic[]
  processedJobIds: Array<number | string>
  processedAt: string
}

export type DiscoverySourceDetail = Omit<SourceRunDetail, "normalizedJobs" | "finalActionableJobs"> & {
  target_matches: number
  target_adjacent: number
  final_actionable: number
}

export interface DiscoveryStore {
  getActiveSearchProfile(userId: string): Promise<SearchProfileRecord>
  createSearchRun(input: { profile: SearchProfileRecord; mode: DiscoveryMode; startedAt: string }): Promise<number | string>
  loadJobs(): Promise<Array<Record<string, unknown>>>
  isSuppressed(input: { userId: string; job: DiscoveredJob; jobId?: number | string }): Promise<boolean>
  upsertJob(input: { job: DiscoveredJob; existing: Record<string, unknown> | undefined; now: string; context?: Record<string, unknown> }): Promise<{ id: number | string | null; created: boolean; availabilityStatus?: string; identityConflict?: boolean; physicalIdentityMode?: "canonical" | "legacy_compatibility" }>
  associateRunJob(input: { runId: number | string; jobId: number | string; outcome: AssociationOutcome; context: Record<string, unknown> }): Promise<void>
  associateRunJobs?(inputs: Array<{ runId: number | string; jobId: number | string; outcome: AssociationOutcome; context: Record<string, unknown> }>): Promise<void>
  persistCandidateTraces?(records: CandidateTraceRecord[]): Promise<CandidateTracePersistenceResult>
  pruneCandidateTraces?(retentionDays: number, limit: number): Promise<number>
  finishSearchRun(input: { runId: number | string; status: "completed" | "partial" | "failed"; finishedAt: string; stats: DiscoveryStats; errorMessage?: string }): Promise<void>
  closeAtsJobs?(jobs: HistoricalJob[]): Promise<{ closed: number; errors: string[] }>
}

function values(definition: SearchProfileDefinition, snake: keyof SearchProfileDefinition, camel: keyof SearchProfileDefinition): string[] {
  const value = definition[snake] ?? definition[camel]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []
}

function unique(valuesToDeduplicate: string[]): string[] {
  return [...new Set(valuesToDeduplicate.map((value) => value.trim()).filter(Boolean))]
}

function acquisitionQueries(job: DiscoveredJob): string[] {
  const metadata = job.raw.metadata && typeof job.raw.metadata === "object"
    ? job.raw.metadata as Record<string, unknown>
    : {}
  const queries = metadata.acquisitionQueries
  if (Array.isArray(queries)) return unique(queries.filter((query): query is string => typeof query === "string"))
  const acquisition = metadata.acquisition && typeof metadata.acquisition === "object"
    ? metadata.acquisition as Record<string, unknown>
    : {}
  return typeof acquisition.query === "string" ? [acquisition.query] : []
}

export function queryGroupsForMatches(matchedQueries: string[], targetedQueries: string[]): { queries: string[]; groups: Array<"targeted" | "broad_only"> } {
  const targeted = new Set(targetedQueries)
  const queries = unique(matchedQueries)
  return {
    queries,
    groups: unique(queries.map((query) => targeted.has(query) ? "targeted" : "broad_only")) as Array<"targeted" | "broad_only">,
  }
}

export function consolidateRunJobObservationContexts(contexts: Record<string, unknown>[]): Record<string, unknown> {
  const last = contexts[contexts.length - 1] ?? {}
  return {
    ...last,
    source_observations: contexts.map((item) => item.identity_observation).filter(Boolean),
    observations: contexts,
  }
}

function weakDuplicateCandidates(job: DiscoveredJob, observation: ReturnType<typeof sourceObservationFor>, rows: Record<string, unknown>[]): number[] {
  const incomingHasStableIdentity = observation.identityKeys.length > 0
  return [...new Set(rows.flatMap((row) => {
    if (row.id === undefined || row.id === null || !Number.isFinite(Number(row.id))) return []
    if (normalized(row.company) !== normalized(job.company)
      || normalized(row.title) !== normalized(job.title)
      || normalized(row.location) !== normalized(job.location)) return []
    const sameSource = normalized(row.source) === normalized(job.source)
    const sameSourceId = Boolean(job.sourceJobId && String(row.source_job_id ?? "") === job.sourceJobId)
    const incomingUrl = normalizedUrl(job.sourceUrl) ?? normalizedUrl(job.applicationUrl)
    const storedUrl = normalizedUrl(typeof row.source_url === "string" ? row.source_url : null)
      ?? normalizedUrl(typeof row.application_url === "string" ? row.application_url : null)
    const sameSourceUrl = !job.sourceJobId && incomingUrl && incomingUrl === storedUrl
    if (sameSource && (sameSourceId || sameSourceUrl)) return []
    const rowObservation = sourceObservationFor({
      source: row.source,
      id: row.source_job_id,
      sourceJobId: row.source_job_id,
      sourceUrl: row.source_url,
      applicationUrl: row.application_url,
      title: row.title,
      company: row.company,
      location: row.location,
      sourceType: "unknown",
    } as NormalizedJob, String(row.source ?? "unknown"))
    const rowHasStableIdentity = rowObservation.identityKeys.length > 0
    if (incomingHasStableIdentity && rowHasStableIdentity) return []
    return [Number(row.id)]
  }))]
}

function weakDuplicateBucketKey(company: unknown, title: unknown, location: unknown): string {
  return JSON.stringify([normalized(company), normalized(title), normalized(location)])
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await operation(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return results
}

/** Deterministic profile terms plus whole-token domain synonyms. */
export function buildSearchQueries(profile: SearchProfileRecord, mode: DiscoveryMode): string[] {
  const definition = profile.definition ?? {}
  const titles = values(definition, "target_titles", "targetTitles")
  const adjacent = values(definition, "target_adjacent_terms", "target_adjacent_terms")
  const families = values(definition, "role_families", "roleFamilies")
  const domains = values(definition, "industries_or_domains", "industriesOrDomains")
  const positive = values(definition, "positive_concepts", "positiveConcepts")
  const precise = unique([...titles, ...values(definition, "target_terms", "targetTerms"), ...positive])
  if (mode === "targeted") return precise.length ? precise : unique(families)
  const broad = unique([...precise, ...adjacent, ...families, ...domains])
  const synonyms = broad.filter((term) => /\b(?:security|cybersecurity)\b/i.test(term)).map((term) =>
    /\bcybersecurity\b/i.test(term) ? term.replace(/\bcybersecurity\b/gi, "Security") : term.replace(/\bsecurity\b/gi, "Cybersecurity"))
  return unique([...broad, ...synonyms, ...(synonyms.length ? ["Cybersecurity"] : [])])
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalized(value: unknown): string {
  return text(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim()
}

function urlValue(...valuesToCheck: unknown[]): string | null {
  return valuesToCheck.find((value): value is string => typeof value === "string" && /^https?:\/\//i.test(value.trim()))?.trim() ?? null
}

function sourceId(raw: NormalizedJob): string | null {
  const ats = raw.ats && typeof raw.ats === "object" ? raw.ats as Record<string, unknown> : {}
  return text(ats.requisitionId) || text(raw.sourceJobId) || text(raw.id) || null
}

function descriptionKind(description: string | null): DescriptionKind {
  return classifyJobDescription(description)
}

export function normalizeDiscoveredJob(raw: NormalizedJob, sourceFallback: string): DiscoveredJob | null {
  const source = text(raw.portal ?? raw.source) || sourceFallback
  const metadata = resolveJobMetadata(raw)
  const company = metadata.company || "Unknown company"
  const title = metadata.title || "Untitled role"
  if (!source) return null
  const description = text(raw.description) || null
  return {
    source,
    sourceJobId: sourceId(raw),
    sourceUrl: urlValue(raw.sourceUrl, raw.canonicalUrl, raw.url),
    applicationUrl: urlValue(raw.applicationUrl, raw.applyUrl, raw.url, raw.canonicalUrl),
    company,
    title,
    metadataIssues: metadata.issues,
    location: text(raw.location) || null,
    remoteScope: text(raw.sourceType === "ats"
      ? raw.workplaceType ?? raw.remoteScope ?? raw.remote
      : raw.remoteScope ?? raw.workplaceType ?? raw.remote) || null,
    employmentType: text(raw.employmentType ?? raw.jobType ?? raw.commitment) || null,
    description,
    descriptionKind: descriptionKind(description),
    postedAt: text(raw.postedAt ?? raw.date) || null,
    raw,
    validation: raw.validation,
  }
}

function normalizedUrl(value: string | null): string | null {
  if (!value) return null
  try { return normalizeCacheUrl(value) } catch { return value }
}

export function discoveryKey(job: Pick<DiscoveredJob, "source" | "sourceJobId" | "sourceUrl" | "applicationUrl" | "company" | "title" | "location"> & { raw?: NormalizedJob }): string {
  const source = normalized(job.source)
  const atsKey = job.raw ? sourceObservationFor(job.raw, job.source).identityKeys.find((key) => key.basis === "ats_requisition")?.key : undefined
  if (job.sourceJobId) return `source:${source}:id:${job.sourceJobId}${atsKey ? `:${atsKey}` : ""}`
  const url = normalizedUrl(job.applicationUrl) ?? normalizedUrl(job.sourceUrl)
  if (url) return `source:${source}:url:${url}`
  return `source:${source}:weak:${normalized(job.company)}:${normalized(job.title)}:${normalized(job.location)}`
}

function quality(job: Pick<DiscoveredJob, "description" | "descriptionKind">): number {
  if (isUsableFullJobDescription(job.description)) return 2
  if (job.descriptionKind === "snippet" || job.description) return 1
  return 0
}

/** Merge duplicate observations without replacing a full description by a snippet. */
export function mergeDiscoveredJobs(jobs: DiscoveredJob[]): DiscoveredJob[] {
  const byKey = new Map<string, DiscoveredJob>()
  for (const job of jobs) {
    const key = discoveryKey(job)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, job)
      continue
    }
    const winner = quality(job) > quality(existing) ? job : existing
    const description = quality(job) > quality(existing) ? job.description : existing.description
    const winnerMetadata = winner.raw.metadata && typeof winner.raw.metadata === "object" ? winner.raw.metadata as Record<string, unknown> : {}
    const existingMetadata = existing.raw.metadata && typeof existing.raw.metadata === "object" ? existing.raw.metadata as Record<string, unknown> : {}
    const acquisitionQueries = [
      ...(Array.isArray(existingMetadata.acquisitionQueries) ? existingMetadata.acquisitionQueries : []),
      ...(Array.isArray(winnerMetadata.acquisitionQueries) ? winnerMetadata.acquisitionQueries : []),
    ].filter((query): query is string => typeof query === "string")
    byKey.set(key, {
      ...winner,
      description,
      descriptionKind: quality(job) > quality(existing) ? job.descriptionKind : existing.descriptionKind,
      sourceUrl: winner.sourceUrl ?? existing.sourceUrl,
      applicationUrl: winner.applicationUrl ?? existing.applicationUrl,
      location: winner.location ?? existing.location,
      remoteScope: winner.remoteScope ?? existing.remoteScope,
      postedAt: winner.postedAt ?? existing.postedAt,
      raw: {
        ...winner.raw,
        metadata: { ...existingMetadata, ...winnerMetadata, ...(acquisitionQueries.length ? { acquisitionQueries: unique(acquisitionQueries) } : {}) },
      },
    })
  }
  return [...byKey.values()]
}

export function mergePersistedJobPayload(job: DiscoveredJob, current: Record<string, unknown>, now: string): Record<string, unknown> {
  // Lifecycle is sourced only from the independent validation result below.
  // Missing/snippet descriptions describe data completeness, not liveness.
  const payload: Record<string, unknown> = {
    source: job.source,
    source_job_id: job.sourceJobId,
    source_url: job.sourceUrl,
    application_url: job.applicationUrl,
    company: job.company,
    title: job.title,
    location: job.location,
    remote_scope: job.remoteScope,
    employment_type: job.employmentType,
    description: job.description,
    description_kind: job.descriptionKind,
    posted_at: job.postedAt,
  }
  if (current.id !== undefined && current.id !== null) payload.last_seen_at = now
  if (job.validation) {
    payload.availability_status = job.validation.status === "uncertain" ? "unknown" : job.validation.status
  }
  const currentDescription = text(current.description)
  const currentKind = current.description_kind as DescriptionKind
  if (quality(job) < quality({ description: currentDescription || null, descriptionKind: currentKind })) {
    delete payload.description
    delete payload.description_kind
  }
  return payload
}

export const DEFAULT_DASHBOARD_ATS_BOARD_BUDGET = 8
export const DEFAULT_JD_ENRICHMENT_BUDGET = 30

export function configuredJdEnrichmentBudget(value = process.env.AI_JOB_SEARCH_JD_ENRICHMENT_MAX_ATTEMPTS): number {
  if (value === undefined || value.trim() === "") return DEFAULT_JD_ENRICHMENT_BUDGET
  if (value.trim() === "30" || value.trim() === "60") return Number(value.trim())
  throw new Error("AI_JOB_SEARCH_JD_ENRICHMENT_MAX_ATTEMPTS must be 30 or 60")
}

export function configuredDashboardAtsBoardBudget(value = process.env.AI_JOB_SEARCH_ATS_BOARD_BUDGET): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DASHBOARD_ATS_BOARD_BUDGET
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1) {
    throw new Error("AI_JOB_SEARCH_ATS_BOARD_BUDGET must be a positive integer")
  }
  return Number(value)
}

function excludedTitleTerms(profile: SearchProfileRecord): string[] {
  const definition = profile.definition ?? {}
  return unique([...values(definition, "excluded_title_patterns", "excludedTitles"), ...values(definition, "excluded_titles", "excluded_titles")]).map(normalized)
}

function excludedConceptTerms(profile: SearchProfileRecord): string[] {
  const definition = profile.definition ?? {}
  return unique([...values(definition, "excluded_terms", "excluded_terms"), ...values(definition, "excluded_concepts", "excludedConcepts")]).map(normalized)
}

function containsWholeTerm(haystack: string, term: string): boolean {
  const normalizeWords = (value: string) => normalized(value).replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\bcybersecurity\b/g, "security").trim()
  const body = ` ${normalizeWords(haystack)} `
  const needle = ` ${normalizeWords(term)} `
  return needle.trim().length > 0 && body.includes(needle)
}

export type RoleEligibility = "target_match" | "target_adjacent" | "unrelated" | "excluded" | "unclear"

function matchingTerms(profile: SearchProfileRecord, keys: Array<[keyof SearchProfileDefinition, keyof SearchProfileDefinition]>): string[] {
  return unique(keys.flatMap(([snake, camel]) => values(profile.definition ?? {}, snake, camel)))
}

function targetTerms(profile: SearchProfileRecord): string[] {
  return matchingTerms(profile, [["target_titles", "targetTitles"], ["target_terms", "target_terms"], ["role_families", "roleFamilies"], ["positive_concepts", "positiveConcepts"]])
}

export function classifyTargetRole(title: string, profile: SearchProfileRecord): RoleEligibility {
  if (excludedTitleTerms(profile).some((term) => containsWholeTerm(title, term)) || excludedConceptTerms(profile).some((term) => containsWholeTerm(title, term))) return "excluded"
  const adjacent = matchingTerms(profile, [["target_adjacent_terms", "target_adjacent_terms"]])
  if (adjacent.some((term) => containsWholeTerm(title, term))) return "target_adjacent"
  const targets = targetTerms(profile)
  if (!targets.length) return "unclear"
  if (targets.some((term) => containsWholeTerm(title, term))) return "target_match"
  return "unrelated"
}

export function classifyTargetRoleAfterDescription(title: string, description: string | null, profile: SearchProfileRecord): RoleEligibility {
  const preliminary = classifyTargetRole(title, profile)
  if (preliminary !== "target_adjacent") return preliminary
  const plain = (description ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")
  if (!plain) return "unclear"
  if (excludedConceptTerms(profile).some((term) => containsWholeTerm(plain, term))) return "excluded"
  return targetTerms(profile).some((term) => containsWholeTerm(plain, term)) ? "target_match" : "unrelated"
}

export type LocationEligibility = "eligible" | "ineligible" | "unclear"

export interface FinalJobEligibility {
  role: RoleEligibility
  location: LocationEligibility
  language: "eligible" | "ineligible" | "unclear"
  employmentType: "eligible" | "ineligible" | "unclear"
  seniority: "eligible" | "ineligible" | "unclear"
  metadata_unresolved: boolean
  metadata_issues: string[]
  actionable: boolean
}

function eligibleRegions(profile: SearchProfileRecord): string[] {
  const definition = profile.definition ?? {}
  const constraints = definition.eligibility_constraints
  const requested = constraints && typeof constraints === "object" ? String((constraints as Record<string, unknown>).remote_scope ?? "") : ""
  return unique([...values(definition, "allowed_regions", "allowed_regions"), ...values(definition, "allowed_countries", "allowed_countries"), ...values(definition, "locations", "locations"), ...requested.split(/[\/,]+/)]).filter(Boolean)
}

const LOCATION_REGIONS: Record<string, RegExp> = {
  europe: /\b(?:europe|european union|eu|eea|emea)\b/i,
  "north america": /\b(?:north america|united states|u\.s\.|usa|us|canada)\b/i,
  "latin america": /\b(?:latin america|latam|brazil|mexico|argentina)\b/i,
  apac: /\b(?:apac|asia pacific|india|singapore|china|japan|australia|new zealand|philippines|malaysia|vietnam|taiwan)\b/i,
}

const EUROPEAN_COUNTRY_CODES = new Set("AL AD AT BA BE BG BY CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM TR UA VA XK".split(" "))
const NORTH_AMERICAN_COUNTRY_CODES = new Set(["US", "CA"])
const LATIN_AMERICAN_COUNTRY_CODES = new Set("AR BO BR CL CO CR CU DO EC GT HN HT JM MX NI PA PE PR PY SV UY VE".split(" "))

const EMPLOYMENT_COUNTRIES: Record<string, string[]> = {
  Austria: ["Austria", "AT", "Vienna"], Germany: ["Germany", "DE"], Poland: ["Poland", "PL"],
  "United States": ["United States", "US", "USA", "U.S.", "U.S.A.", "San Francisco Bay Area", "San Francisco"], "United Kingdom": ["United Kingdom", "UK", "GB", "Britain", "London"],
  France: ["France", "FR"], Portugal: ["Portugal", "PT", "Lisbon"], Spain: ["Spain", "ES"], Italy: ["Italy", "IT"],
  Ireland: ["Ireland", "IE"], Netherlands: ["Netherlands", "NL"], Belgium: ["Belgium", "BE"], Denmark: ["Denmark", "DK"],
  Sweden: ["Sweden", "SE"], Norway: ["Norway", "NO"], Finland: ["Finland", "FI"], Switzerland: ["Switzerland", "CH"],
  Czechia: ["Czechia", "Czech Republic", "CZ"], Romania: ["Romania", "RO"], Bulgaria: ["Bulgaria", "BG"],
  Croatia: ["Croatia", "HR"], Greece: ["Greece", "GR"], Hungary: ["Hungary", "HU"], Lithuania: ["Lithuania", "LT"],
  Latvia: ["Latvia", "LV"], Estonia: ["Estonia", "EE"], Slovakia: ["Slovakia", "SK"], Slovenia: ["Slovenia", "SI"],
  Cyprus: ["Cyprus", "CY"], Malta: ["Malta", "MT"], Iceland: ["Iceland", "IS"], Liechtenstein: ["Liechtenstein", "LI"],
  Canada: ["Canada", "CA"], India: ["India", "IN"], Australia: ["Australia", "AU"], Japan: ["Japan", "JP"],
  Singapore: ["Singapore", "SG"], Brazil: ["Brazil", "BR"], Mexico: ["Mexico", "MX"],
  Malaysia: ["Malaysia", "MY"], "New Zealand": ["New Zealand", "NZ"], Argentina: ["Argentina", "AR"],
  "South Africa": ["South Africa", "ZA"], "United Arab Emirates": ["United Arab Emirates", "UAE", "AE"],
  Israel: ["Israel", "IL"], "Saudi Arabia": ["Saudi Arabia", "KSA", "SA"], Luxembourg: ["Luxembourg", "LU"],
}

function employmentCountries(text: string): string[] {
  return Object.entries(EMPLOYMENT_COUNTRIES).filter(([, aliases]) => aliases.some((alias) =>
    alias.length === 2 ? new RegExp(`(?<![\\p{L}])${alias}(?![\\p{L}])`, /^(US|UK|GB)$/i.test(alias) ? "iu" : "u").test(text) : containsWholeTerm(text, alias)
  )).map(([country]) => country)
}

function countryScopeCompatibility(text: string, allowed: string[]): boolean | null | undefined {
  const countries = employmentCountries(text)
  const broad = /\b(?:europe|european union|eu|eea|emea|worldwide|global|anywhere)\b/i.test(text)
  if (!countries.length || (broad && !/\bonly\b|\brestricted\b|\blimited\b/i.test(text))) return undefined
  const anchors = allowed.flatMap((value) => Object.entries(EMPLOYMENT_COUNTRIES)
    .filter(([, aliases]) => aliases.some((alias) => normalized(alias) === normalized(value))).map(([country]) => country))
  if (anchors.length) return countries.some((country) => anchors.includes(country))
  if (allowed.some((value) => geographyMatches(text, [value]))) return true
  return allowed.every((value) => /^(?:worldwide|global|anywhere)$/i.test(value)) ? null : false
}

const EMPLOYER_SCOPE = /(?:remote(?:ly)?\s+(?:(?:within|in|from|across)\b|(?:position|role|job)\s+(?:is\s+)?based\s+in)|(?:must|need\s+to|required\s+to)\s+(?:(?:be|reside|live|work)\s+)*(?:based|located|reside|live|work)?\s*(?:in|within)\b|(?:candidates|applicants|you)\s+(?:(?:must|need\s+to|are\s+required\s+to|can|may)\s+)?(?:be\s+)?(?:based|located|residing|resident)\s+(?:in|within)\b|(?:if\s+you\s+are\s+based\s+in)\b|(?:possibility\s+to\s+work\s+remotely\s*\(?if\s+you\s+are\s+based\s+in)\b|(?:only|exclusively)\s+(?:for\s+)?(?:candidates\s+)?(?:based|located|residing)\s+in\b)[^.!?\n]{0,160}/gi
const EMPLOYER_COUNTRY_ONLY = new RegExp(`\\b(?:${Object.keys(EMPLOYMENT_COUNTRIES).map((country) => country.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[- ]only\\b[^.!?\\n]{0,160}`, "gi")

function employerGeography(description: string, title: string, allowed: string[]): LocationEligibility | undefined {
  const phrases = [...description.matchAll(EMPLOYER_SCOPE), ...description.matchAll(EMPLOYER_COUNTRY_ONLY)].map((match) => match[0])
  if (/\b(?:excluding|except|not\s+available\s+in)\s+Austria\b/i.test(description)
    && allowed.some((value) => /^(?:austria|at|vienna)$/i.test(value))) return "ineligible"
  // The title is a fallback when the JD does not state an employer scope.
  if (!phrases.length) phrases.push(...[...title.matchAll(EMPLOYER_SCOPE)].map((match) => match[0]))
  const known = phrases.flatMap((phrase) => {
    if (!employmentCountries(phrase).length && !/\b(?:europe|european union|eu|eea|emea|worldwide|global|anywhere)\b/i.test(phrase)) return []
    const country = countryScopeCompatibility(phrase, allowed)
    return [country === undefined ? geographyMatches(phrase, allowed) : country]
  })
  if (known.includes(null) || (known.includes(true) && known.includes(false))) return "unclear"
  if (known.includes(false)) return "ineligible"
  if (known.includes(true)) return "eligible"
  return phrases.some((phrase) => /^(?:must|need|required|candidates|applicants|if|only|exclusively|remote(?:ly)?\s+(?:within|in))\b/i.test(phrase)) ? "unclear" : undefined
}

function locationCountryCodes(value: string | null | undefined): string[] {
  if (!value) return []
  const tokens = value.split(",").map((token) => token.trim().toUpperCase())
  return tokens.length >= 3 && tokens.every((token) => /^[A-Z]{2}$/.test(token)) ? tokens : []
}

function geographyMatches(text: string, allowed: string[], countryCodes: string[] = []): boolean {
  const permitted = allowed.join(" ")
  const named = employmentCountries(text)
  const requested = employmentCountries(permitted)
  if (named.some((country) => requested.includes(country))) return true
  if (/\b(?:europe|european union|eu|eea|emea)\b/i.test(text)
    && requested.some((country) => EMPLOYMENT_COUNTRIES[country]?.some((alias) => EUROPEAN_COUNTRY_CODES.has(alias)))) return true
  if (/(?:europe|\beu\b|\beea\b|emea)/i.test(text) && /(?:europe|\beu\b|\beea\b|emea)/i.test(permitted)) return true
  if (/(?:europe|\beu\b|\beea\b|emea)/i.test(permitted) && countryCodes.some((code) => EUROPEAN_COUNTRY_CODES.has(code))) return true
  if (/north america/i.test(permitted) && countryCodes.some((code) => NORTH_AMERICAN_COUNTRY_CODES.has(code))) return true
  if (/(?:latin america|\blatam\b)/i.test(permitted) && countryCodes.some((code) => LATIN_AMERICAN_COUNTRY_CODES.has(code))) return true
  for (const [region, pattern] of Object.entries(LOCATION_REGIONS)) {
    if (pattern.test(text) && pattern.test(permitted)) return true
    if (region === "europe" && /\b(?:austria|germany|france|poland|ireland|netherlands|spain|italy|portugal|sweden|finland|denmark|belgium|switzerland|norway|uk|united kingdom)\b/i.test(text)
      && /(?:europe|\beu\b|\beea\b|emea)/i.test(permitted)) return true
  }
  return false
}

export function classifyLocationEligibility(job: DiscoveredJob, profile: SearchProfileRecord): LocationEligibility {
  const definition = profile.definition ?? {}
  const workModels = values(definition, "work_models", "workModels").map((value) => normalized(value).replace(/[- ]/g, ""))
  if (definition.remote_only === true && !workModels.includes("remote")) workModels.push("remote")
  const scope = (job.remoteScope ?? "").toLowerCase()
  const location = (job.location ?? "").toLowerCase()
  const description = (job.description ?? "").replace(/<[^>]*>/g, " ")
  const workModel = classifyWorkModel({
    title: job.title, location: job.location, remoteScope: job.remoteScope, description,
    structuredWorkModel: job.raw.sourceType === "ats" ? text(job.raw.workplaceType) : null,
  })
  const workUnclear = workModels.length > 0 && workModel === "unknown"
  if (workModels.length && workModel !== "unknown" && !workModels.includes(workModel)) return "ineligible"
  const allowed = eligibleRegions(profile)
  const excluded = unique([
    ...values(definition, "excluded_regions", "excluded_regions"),
    ...values(definition, "excluded_countries", "excluded_countries"),
  ])
  const countryCodes = locationCountryCodes(job.location)
  if (/\b(?:excluding|except|not\s+available\s+in)\s+Austria\b/i.test(`${job.remoteScope ?? ""} ${job.location ?? ""} ${description}`)
    && allowed.some((value) => /^(?:austria|at|vienna)$/i.test(value))) return "ineligible"
  const employerScope = allowed.length ? employerGeography(description, job.title, allowed) : undefined
  if (employerScope === "ineligible" || employerScope === "unclear") return employerScope
  if (excluded.length && geographyMatches(`${scope} ${location} ${description}`, excluded, countryCodes)) return "ineligible"
  if (employerScope === "eligible") return workUnclear ? "unclear" : "eligible"
  const explicitRestrictions = /(?:remote(?:ly)?\s+(?:within|in|from|only in|only within)|(?:united states|u\.s\.|usa|us|united kingdom|uk|germany|poland|india|canada|australia|eu|eea|europe|emea)[- ]only|(?:united states|u\.s\.|usa|us|united kingdom|uk|germany|poland|india|canada|australia)[- ]based candidates only|(?:remote\s+)?(?:position|role|work)\s+(?:is\s+)?(?:restricted|limited)\s+to|(?:must|need to|required to)\s+(?:be\s+)?(?:based|located|reside|live)\s+(?:in|within)|(?:candidates|applicants)\s+(?:(?:must|need to|are required to)\s+)?(?:be\s+)?(?:based|located|residing|resident)\s+(?:in|within)|(?:only|exclusively)\s+(?:for\s+)?(?:candidates\s+)?(?:based|located|residing)\s+in)[^.!?\n]{0,100}/gi
  const restrictions = [...description.matchAll(explicitRestrictions)].map((match) => match[0])
  let compatibleRestriction = false
  if (restrictions.length) {
    if (allowed.length) {
      const hasKnownGeography = (value: string) => Object.values(LOCATION_REGIONS).some((pattern) => pattern.test(value)) || employmentCountries(value).length > 0
      const outcomes = restrictions.filter(hasKnownGeography).map((value) => {
        const country = countryScopeCompatibility(value, allowed)
        return country === undefined ? geographyMatches(value, allowed) : country
      })
      if (outcomes.includes(null)) return "unclear"
      if (outcomes.some(Boolean) && outcomes.some((matches) => !matches)) return "unclear"
      if (outcomes.length && !outcomes.some(Boolean)) return "ineligible"
      compatibleRestriction = outcomes.length > 0 && outcomes.every(Boolean)
    }
  }

  const listingScope = `${scope} ${location}`
  // A broad remote scope may describe office locations separately; a named
  // country-only employment scope must include the profile's explicit country.
  const countryCompatibility = countryScopeCompatibility(`${job.remoteScope ?? ""} ${job.location ?? ""}`, allowed)
  if (allowed.length && countryCompatibility === false) return "ineligible"
  if (allowed.length && countryCompatibility === null) return "unclear"
  if (countryCompatibility === true) return workUnclear ? "unclear" : "eligible"
  if (/\b(?:worldwide|global(?:ly)?|anywhere)\b/i.test(listingScope) && !restrictions.length) return workUnclear ? "unclear" : "eligible"
  const hasExplicitGeo = Object.values(LOCATION_REGIONS).some((pattern) => pattern.test(listingScope))
    || /\b(?:austria|germany|france|poland|ireland|netherlands|spain|italy|portugal|sweden|finland|denmark|belgium|switzerland|norway|uk|united kingdom|czechia|romania|bulgaria|croatia|greece|hungary|lithuania|latvia|estonia|slovakia|slovenia)\b/i.test(listingScope)
    || countryCodes.length > 0
  if (hasExplicitGeo && allowed.length && !geographyMatches(listingScope, allowed, countryCodes)) return "ineligible"
  if (hasExplicitGeo && (!allowed.length || geographyMatches(listingScope, allowed, countryCodes))) return workUnclear ? "unclear" : "eligible"
  if (compatibleRestriction) return workUnclear ? "unclear" : "eligible"
  if (!allowed.length) return workUnclear ? "unclear" : "eligible"
  if (allowed.length && /\b(?:worldwide|anywhere in the world|anywhere)\b/i.test(`${listingScope} ${description}`) && !restrictions.length) return workUnclear ? "unclear" : "eligible"
  return "unclear"
}

export function classifyLanguageEligibility(job: DiscoveredJob, profile: SearchProfileRecord): "eligible" | "ineligible" | "unclear" {
  const definition = profile.definition ?? {}
  const constraints = Array.isArray(definition.language_constraints) ? definition.language_constraints : []
  const accepted = [
    ...values(definition, "accepted_languages", "accepted_languages"),
    ...constraints.filter((item) => item && item.required !== false).map((item) => String(item.language ?? "")),
    ...(definition.english_only === true ? ["English"] : []),
  ].map(normalized).filter(Boolean)
  if (!accepted.length) return "eligible"
  const languageAliases: Record<string, string[]> = { english: ["english"], german: ["german", "deutsch"], french: ["french", "français", "francais"], spanish: ["spanish", "español", "espanol"] }
  const description = (job.description ?? "").replace(/<[^>]*>/g, " ")
  const required = Object.entries(languageAliases).filter(([, names]) => names.some((name) => new RegExp(`\\b${name}\\b.*\\b(required|essential|mandatory|fluent|proficient)\\b`, "i").test(description))).map(([language]) => language)
  if (/\bDeutschkenntnisse|Deutsch erforderlich|fließend Deutsch\b/i.test(description)) required.push("german")
  if (required.length) return required.every((language) => accepted.some((item) => item.includes(language))) ? "eligible" : "ineligible"
  const detected = postingLanguage(description)
  if (detected === "english") return accepted.some((item) => item.includes("english")) ? "eligible" : "ineligible"
  if (detected === "non_english") {
    const markers: Record<string, Set<string>> = {
      german: new Set("der die das und mit für fuer ist sind werden wir sie eine einen auf im von zu den dem auch nicht erforderlich kenntnisse bewerbung ihre unser".split(" ")),
      french: new Set("les des une dans avec pour nous vous votre notre sont est équipe equipe poste travail".split(" ")),
      spanish: new Set("los las una para con nuestro nuestra experiencia equipo trabajo requisitos".split(" ")),
    }
    const words = description.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? []
    const likely = Object.entries(markers).filter(([, wordsForLanguage]) => words.filter((word) => wordsForLanguage.has(word)).length >= 6).map(([language]) => language)
    if (!likely.length) return "unclear"
    return likely.some((language) => accepted.some((item) => item.includes(language))) ? "eligible" : "ineligible"
  }
  return "unclear"
}

export function classifyEmploymentType(job: DiscoveredJob, profile: SearchProfileRecord): "eligible" | "ineligible" | "unclear" {
  const definition = profile.definition ?? {}
  const accepted = [...values(definition, "accepted_employment_types", "accepted_employment_types"), ...values(definition, "employment_types", "employment_types")].map(normalized)
  const excluded = values(definition, "excluded_employment_types", "excluded_employment_types").map(normalized)
  const text = `${job.employmentType ?? ""} ${job.description ?? ""}`.toLocaleLowerCase()
  const aliases: Record<string, string[]> = { contract: ["contract", "contractor", "b2b", "freelance", "independent contractor"], permanent: ["permanent", "indefinite"], full_time: ["full time", "full-time", "fulltime"], part_time: ["part time", "part-time", "parttime"], temporary: ["temporary", "fixed term", "fixed-term"], internship: ["internship", "intern"] }
  const found = Object.entries(aliases).filter(([, terms]) => terms.some((term) => containsWholeTerm(text, term))).map(([kind]) => kind)
  if (found.some((kind) => excluded.some((term) => term.replace(/[ -]/g, "_") === kind))) return "ineligible"
  if (!accepted.length) return "eligible"
  if (!found.length) return "unclear"
  return found.some((kind) => accepted.some((term) => term.replace(/[ -]/g, "_") === kind)) ? "eligible" : "ineligible"
}

export function classifySeniority(title: string, profile: SearchProfileRecord): "eligible" | "ineligible" | "unclear" {
  const definition = profile.definition ?? {}
  const accepted = unique([
    ...values(definition, "target_seniority", "target_seniority"),
    ...values(definition, "accepted_seniority", "accepted_seniority"),
  ]).map(normalized)
  const excluded = values(definition, "excluded_seniority", "excluded_seniority").map(normalized)
  const aliases: Record<string, string[]> = { intern: ["intern", "internship"], junior: ["junior", "entry level", "graduate"], mid: ["mid", "mid-level", "intermediate"], senior: ["senior"], staff: ["staff"], principal: ["principal"], lead: ["lead"], manager: ["manager"], director: ["director"], executive: ["vice president", "vp", "chief"] }
  const found = Object.entries(aliases).filter(([, terms]) => terms.some((term) => containsWholeTerm(title, term))).map(([level]) => level)
  if (found.some((level) => excluded.includes(level))) return "ineligible"
  if (!accepted.length) return "eligible"
  if (!found.length) return "unclear"
  return found.some((level) => accepted.includes(level)) ? "eligible" : "ineligible"
}

/** Final post-hydration gate; lifecycle, JD completeness, and user eligibility remain separate. */
export function evaluateFinalJobEligibility(job: DiscoveredJob, profile: SearchProfileRecord): FinalJobEligibility {
  const role = classifyTargetRoleAfterDescription(job.title, job.descriptionKind === "full" ? job.description : null, profile)
  const location = classifyLocationEligibility(job, profile)
  const language = classifyLanguageEligibility(job, profile)
  const employmentType = classifyEmploymentType(job, profile)
  const seniority = classifySeniority(job.title, profile)
  const metadataIssues = job.metadataIssues ?? jobMetadataIssues(job.company, job.title)
  const metadataUnresolved = metadataIssues.length > 0
  return {
    role,
    location,
    language,
    employmentType,
    seniority,
    metadata_unresolved: metadataUnresolved,
    metadata_issues: metadataIssues,
    actionable: job.validation?.status === "active"
      && !metadataUnresolved
      && role === "target_match"
      && location === "eligible"
      && language === "eligible"
      && employmentType === "eligible"
      && seniority === "eligible",
  }
}

/** Apply only user/profile discovery constraints; this is not candidate matching. */
export function passesSearchProfile(job: DiscoveredJob, profile: SearchProfileRecord): boolean {
  const result = evaluateFinalJobEligibility(job, profile)
  return result.role !== "unrelated" && result.role !== "excluded"
    && result.location !== "ineligible"
    && result.language !== "ineligible"
    && result.employmentType !== "ineligible"
    && result.seniority !== "ineligible"
}

function statusFor(job: DiscoveredJob): AssociationOutcome {
  if (job.validation?.status === "expired") return "expired"
  if (job.validation?.status === "validation_failed") return "validation_failed"
  if (job.validation?.status === "uncertain") return "unknown"
  return "rediscovered"
}

function findSuppressedExistingJob(
  rows: Array<Record<string, unknown>>,
  job: DiscoveredJob,
): Record<string, unknown> | undefined {
  const sourceJobId = job.sourceJobId == null ? null : String(job.sourceJobId)
  const sourceUrl = job.sourceUrl ?? job.applicationUrl ?? null
  if (sourceJobId) {
    const sameSourceIdentity = rows.find((row) =>
      String(row.source ?? "") === job.source
      && row.source_job_id != null
      && String(row.source_job_id) === sourceJobId,
    )
    if (sameSourceIdentity) return sameSourceIdentity
  }
  if (sourceUrl) {
    const sameUrl = rows.find((row) => row.source_url === sourceUrl || row.application_url === sourceUrl)
    if (sameUrl) return sameUrl
  }
  if (!sourceJobId && !sourceUrl) {
    const normalize = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase()
    return rows.find((row) =>
      row.source_job_id == null
      && row.source_url == null
      && normalize(row.company) === normalize(job.company)
      && normalize(row.title) === normalize(job.title),
    )
  }
  return undefined
}

export interface GenericDiscoveryOptions {
  mode: DiscoveryMode
  profile?: SearchProfileRecord
  userId?: string
  sourceNames?: string[]
  sourceRunners?: Array<(options: PipelineOptions) => Promise<SourceRunResult>>
  validator?: (jobs: NormalizedJob[]) => Promise<{ all: NormalizedJob[]; results: NormalizedJob[]; stats?: Pick<ValidationStats, "cacheHits" | "networkValidations"> }>
  enricher?: (jobs: NormalizedJob[]) => Promise<{ jobs: NormalizedJob[]; stats: EnrichmentStats }>
  store?: DiscoveryStore
  now?: Date
  dryRun?: boolean
  limit?: number
  candidateTracing?: boolean
  candidateTraceLimit?: number
  atsRunner?: (options: AtsIngestionOptions) => Promise<{ stats: AtsIngestionStats; results: AtsFetchResult[]; jobs: NormalizedJob[]; history?: JsonJobHistoryStore; registrySource?: "local" | "supabase"; registryWarning?: string }>
  atsRegistryPath?: string
  atsRegistrySource?: "auto" | "local" | "supabase"
  atsRotationSlot?: number
  atsHistoryPath?: string
  atsBoardBudget?: number
}

export interface EvidenceGatheringResult {
  jobs: DiscoveredJob[]
  initialRoleClassifications: Map<string, RoleEligibility>
  roleClassifications: Map<string, RoleEligibility>
  candidateEvents: Map<string, CandidateTraceEvent[]>
  candidateFacts: Map<string, Record<string, unknown>>
  stats: {
    earlyUnrelatedExclusions: number
    earlyPreferenceExclusions: number
    targetMatches: number
    targetAdjacent: number
    unrelated: number
    excluded: number
    locationIneligible: number
    locationUnclear: number
    languageIneligible: number
    languageUnclear: number
    employmentTypeIneligible: number
    employmentTypeUnclear: number
    seniorityIneligible: number
    metadataUnresolved: number
    targetAdjacentSentForEvidence: number
    locationUnclearSentForEvidence: number
    livenessFailures: number
    jdHydrationSuccesses: number
    jdHydrationFailures: number
    jdHydration: EnrichmentStats
    roleResolvedAfterJd: number
    locationResolvedAfterJd: number
    finalActionable: number
    fitReady: number
    validationCacheHits: number
    validationNetworkChecks: number
    validationMs: number
    hydrationMs: number
    screeningMs: number
    classificationMs: number
  }
}

export function evidenceValidationOptions(now: Date, forceRevalidate = false): { includeUnvalidated: true; now: Date; useCache: boolean } {
  return { includeUnvalidated: true, now, useCache: !forceRevalidate }
}

/** Verify profile-targeted/adjacent jobs, hydrate only live missing JDs, then re-evaluate preferences. */
export async function verifyAndHydrateDiscoveredJobs(
  inputJobs: DiscoveredJob[],
  profile: SearchProfileRecord,
  options: {
    now?: Date
    forceRevalidate?: boolean
    traceCandidates?: boolean
    traceCandidateKeys?: ReadonlySet<string>
    validator?: (jobs: NormalizedJob[]) => Promise<{ all: NormalizedJob[]; results: NormalizedJob[]; stats?: Pick<ValidationStats, "cacheHits" | "networkValidations"> }>
    enricher?: (jobs: NormalizedJob[]) => Promise<{ jobs: NormalizedJob[]; stats: EnrichmentStats }>
  } = {},
): Promise<EvidenceGatheringResult> {
  const now = options.now ?? new Date()
  const tracingEnabled = options.traceCandidates === true
  const candidateEvents = new Map<string, CandidateTraceEvent[]>()
  const candidateFacts = new Map<string, Record<string, unknown>>()
  const initialEligibilityByKey = new Map<string, FinalJobEligibility>()
  const shouldTrace = (job: DiscoveredJob) => tracingEnabled
    && (!options.traceCandidateKeys || options.traceCandidateKeys.has(discoveryKey(job)))
  const addEvent = (job: DiscoveredJob, event: CandidateTraceEvent) => {
    if (!shouldTrace(job)) return
    const key = discoveryKey(job)
    candidateEvents.set(key, [...(candidateEvents.get(key) ?? []), event])
  }
  const screeningStartedAt = performance.now()
  const initialRoleClassifications = new Map(inputJobs.map((job) => [discoveryKey(job), classifyTargetRole(job.title, profile)]))
  const initialLocationByKey = new Map(inputJobs.map((job) => [discoveryKey(job), classifyLocationEligibility(job, profile)]))
  if (tracingEnabled) for (const job of inputJobs) {
    if (!shouldTrace(job)) continue
    const role = initialRoleClassifications.get(discoveryKey(job)) ?? "unclear"
    const roleCode = role === "target_match" ? "ROLE_RELEVANT"
      : role === "target_adjacent" ? "ROLE_ADJACENT"
        : role === "unrelated" ? "ROLE_UNRELATED"
          : role === "excluded" ? "ROLE_EXCLUDED" : "ROLE_UNCERTAIN"
    addEvent(job, {
      stage: "role_screen",
      decision: role === "unrelated" || role === "excluded" ? "rejected" : role === "unclear" ? "unknown" : "passed",
      reasonCode: roleCode,
      evidenceStatus: job.title ? "present" : "missing",
    })
    const initialEligibility = evaluateFinalJobEligibility(job, profile)
    initialEligibilityByKey.set(discoveryKey(job), initialEligibility)
    for (const [dimension, state] of [
      ["location", initialEligibility.location],
      ["language", initialEligibility.language],
      ["employment_type", initialEligibility.employmentType],
      ["seniority", initialEligibility.seniority],
    ] as const) {
      const reasonCode = state === "eligible" ? `${dimension.toUpperCase()}_ELIGIBLE`
        : state === "ineligible" ? `${dimension.toUpperCase()}_INCOMPATIBLE`
          : `${dimension.toUpperCase()}_UNRESOLVED`
      addEvent(job, {
        stage: "preference_screen",
        decision: state === "eligible" ? "passed" : state === "ineligible" ? "rejected" : "unknown",
        reasonCode,
        evidenceStatus: state === "unclear" ? "missing" : "present",
      })
    }
  }
  const earlyUnrelatedExclusions = inputJobs.filter((job) => initialRoleClassifications.get(discoveryKey(job)) === "unrelated").length
  const earlyPreferenceExclusions = inputJobs.filter((job) => initialRoleClassifications.get(discoveryKey(job)) === "excluded").length
  const evidenceCandidates = inputJobs.filter((job) => {
    const role = initialRoleClassifications.get(discoveryKey(job))
    if (role !== "target_match" && role !== "target_adjacent") return false
    const final = initialEligibilityByKey.get(discoveryKey(job)) ?? evaluateFinalJobEligibility(job, profile)
    if (final.location === "ineligible" || final.language === "ineligible" || final.employmentType === "ineligible" || final.seniority === "ineligible") return false
    return true
  })
  const evidenceCandidateKeys = tracingEnabled
    ? new Set(evidenceCandidates.filter(shouldTrace).map(discoveryKey))
    : new Set<string>()
  if (tracingEnabled) for (const job of inputJobs) {
    if (!shouldTrace(job)) continue
    if (!evidenceCandidateKeys.has(discoveryKey(job))) {
      addEvent(job, { stage: "verification", decision: "not_attempted", reasonCode: "VALIDATION_NOT_ATTEMPTED", evidenceStatus: "not_checked" })
      addEvent(job, { stage: "jd_hydration", decision: "not_attempted", reasonCode: "JD_HYDRATION_NOT_ATTEMPTED", evidenceStatus: "not_checked" })
    }
  }
  const screeningMs = Math.max(0, Math.round(performance.now() - screeningStartedAt))
  const validator = options.validator ?? (async (jobs: NormalizedJob[]) => {
    const result = await validateJobs(jobs, evidenceValidationOptions(now, options.forceRevalidate))
    return { all: result.all, results: result.results, stats: result.stats }
  })
  const boardVerified = evidenceCandidates.filter((job) => job.raw.sourceType === "ats" && job.validation?.status === "active" && job.validation.method === "ats_api")
  const needsListingVerification = evidenceCandidates.filter((job) => !boardVerified.includes(job))
  const validationStartedAt = performance.now()
  const validated = await validator(needsListingVerification.map((job) => ({ ...job.raw, validation: undefined })))
  const validationMs = Math.max(0, Math.round(performance.now() - validationStartedAt))
  const byKey = new Map(validated.all.flatMap((raw) => {
    const normalizedJob = normalizeDiscoveredJob(raw, String(raw.source ?? "unknown"))
    return normalizedJob ? [[discoveryKey(normalizedJob), raw.validation] as const] : []
  }))
  const liveJobs = inputJobs.map((job) => ({
    ...job,
    validation: job.raw.sourceType === "ats" && job.validation?.status === "active" && job.validation.method === "ats_api"
      ? job.validation
      : byKey.get(discoveryKey(job)),
  }))
  const liveJobsByKey = new Map(tracingEnabled
    ? liveJobs.filter(shouldTrace).map((job) => [discoveryKey(job), job] as const)
    : [])
  if (tracingEnabled) for (const job of evidenceCandidates) {
    if (!shouldTrace(job)) continue
    const checked = liveJobsByKey.get(discoveryKey(job))
    const validation = checked?.validation
    const status = validation?.status
    const reasonCode = status === "active" ? "LISTING_ACTIVE"
      : status === "expired" ? "LISTING_EXPIRED"
        : status === "validation_failed" ? "LISTING_VALIDATION_FAILED"
          : status === "uncertain" ? "LISTING_UNCERTAIN" : "LISTING_UNVERIFIED"
    addEvent(job, {
      stage: "verification",
      decision: status === "active" ? "passed" : status === "expired" ? "rejected" : status === "validation_failed" ? "failed" : "unknown",
      reasonCode,
      evidenceStatus: status ? "present" : "missing",
    })
    if (validation) candidateFacts.set(discoveryKey(job), {
      ...(candidateFacts.get(discoveryKey(job)) ?? {}),
      verification: {
        status: validation.status,
        method: validation.method,
        confidence: validation.confidence,
        ...(Number.isSafeInteger(validation.httpStatus) ? { http_status: validation.httpStatus } : {}),
        ...(sanitizeTraceReason(validation.reason) ? { reason: sanitizeTraceReason(validation.reason) } : {}),
        ...(sanitizeTraceUrl(validation.finalUrl) ? { final_url: sanitizeTraceUrl(validation.finalUrl) } : {}),
        checked_at: validation.checkedAt,
      },
    })
  }
  const liveForHydration = liveJobs.filter((job) =>
    job.validation?.status === "active"
    && (job.descriptionKind !== "full" || (options.forceRevalidate === true && needsEnrichment(job.raw)))
  )
  const enrichmentBudget = configuredJdEnrichmentBudget()
  const hydrationStartedAt = performance.now()
  const enrichmentResult = liveForHydration.length
    ? await (options.enricher ?? ((items) => enrichJobs(items, { now, maxJobs: enrichmentBudget })))(liveForHydration.map((job) => ({
      ...job.raw,
      description: job.description ?? undefined,
      location: job.location ?? undefined,
      remoteScope: job.remoteScope ?? undefined,
    })))
    : { jobs: [], stats: emptyEnrichmentStats(enrichmentBudget) }
  const hydrationMs = Math.max(0, Math.round(performance.now() - hydrationStartedAt))
  const enrichedByKey = new Map(enrichmentResult.jobs.flatMap((raw) => {
    const enriched = normalizeDiscoveredJob(raw, String(raw.source ?? "unknown"))
    return enriched ? [[discoveryKey(enriched), enriched] as const] : []
  }))
  const jobs = liveJobs.map((job) => {
    const enriched = enrichedByKey.get(discoveryKey(job))
    return enriched ? { ...enriched, validation: job.validation } : job
  })
  if (tracingEnabled) for (const job of liveForHydration) {
    if (!shouldTrace(job)) continue
    const hydrated = enrichedByKey.get(discoveryKey(job))
    const full = hydrated?.descriptionKind === "full"
    const detail = hydrated?.raw.metadata && typeof hydrated.raw.metadata === "object"
      ? (hydrated.raw.metadata as Record<string, unknown>).detailEnrichment as Record<string, unknown> | undefined
      : undefined
    const detailStatus = typeof detail?.status === "string" ? detail.status : "unknown"
    addEvent(job, {
      stage: "jd_hydration",
      decision: full ? "passed" : detailStatus === "deferred" || detailStatus === "not_supported" ? "not_attempted" : "unknown",
      reasonCode: full ? "JD_AVAILABLE" : `JD_HYDRATION_${detailStatus.toUpperCase()}`,
      evidenceStatus: full ? "present" : "partial",
    })
    candidateFacts.set(discoveryKey(job), {
      ...(candidateFacts.get(discoveryKey(job)) ?? {}),
      jd_hydration: {
        status: detailStatus,
        attempted: Boolean(detail && !detail.cacheHit && !["deferred", "not_supported", "not_needed"].includes(detailStatus)),
        selected_by_budget: Boolean(detail && !detail.cacheHit && !["deferred", "not_supported", "not_needed"].includes(detailStatus)),
        result: full ? "full_description" : "description_incomplete",
      },
    })
  }
  const hydrationKeys = new Set(tracingEnabled ? liveForHydration.filter(shouldTrace).map(discoveryKey) : [])
  if (tracingEnabled) for (const job of liveJobs) {
    if (!shouldTrace(job)) continue
    if (!hydrationKeys.has(discoveryKey(job)) && job.validation?.status === "active") {
      addEvent(job, {
        stage: "jd_hydration",
        decision: job.descriptionKind === "full" ? "passed" : "not_attempted",
        reasonCode: job.descriptionKind === "full" ? "JD_AVAILABLE" : "JD_HYDRATION_NOT_NEEDED_OR_NOT_SELECTED",
        evidenceStatus: job.descriptionKind === "full" ? "present" : job.descriptionKind === "snippet" ? "partial" : "missing",
      })
    }
  }
  if (tracingEnabled) for (const job of liveJobs) {
    if (!shouldTrace(job)) continue
    if (evidenceCandidateKeys.has(discoveryKey(job)) && job.validation?.status !== "active") {
      addEvent(job, { stage: "jd_hydration", decision: "not_attempted", reasonCode: "JD_HYDRATION_NOT_ATTEMPTED", evidenceStatus: "not_checked" })
    }
  }
  const classificationStartedAt = performance.now()
  const classifiedJobs = jobs.map((job) => ({ job, eligibility: evaluateFinalJobEligibility(job, profile) }))
  if (tracingEnabled) for (const { job, eligibility } of classifiedJobs) {
    if (!shouldTrace(job)) continue
    const role = eligibility.role
    addEvent(job, {
      stage: "final_eligibility",
      decision: role === "unrelated" || role === "excluded" ? "rejected" : role === "unclear" ? "unknown" : "passed",
      reasonCode: role === "target_match" ? "ROLE_RELEVANT_AFTER_EVIDENCE"
        : role === "target_adjacent" ? "ROLE_ADJACENT_AFTER_EVIDENCE"
          : role === "unrelated" ? "ROLE_UNRELATED_AFTER_EVIDENCE"
            : role === "excluded" ? "ROLE_EXCLUDED_AFTER_EVIDENCE" : "ROLE_UNCERTAIN_AFTER_EVIDENCE",
      evidenceStatus: job.descriptionKind === "full" ? "present" : job.descriptionKind === "snippet" ? "partial" : "missing",
    })
    candidateFacts.set(discoveryKey(job), {
      ...(candidateFacts.get(discoveryKey(job)) ?? {}),
      final_eligibility: {
        role: eligibility.role,
        location: eligibility.location,
        language: eligibility.language,
        employment_type: eligibility.employmentType,
        seniority: eligibility.seniority,
        metadata_unresolved: eligibility.metadata_unresolved,
        metadata_issue_codes: eligibility.metadata_issues,
        actionable: eligibility.actionable,
        description_kind: job.descriptionKind,
        work_model: classifyWorkModel({
          title: job.title,
          location: job.location,
          remoteScope: job.remoteScope,
          description: job.description,
          structuredWorkModel: job.raw.sourceType === "ats" ? text(job.raw.workplaceType) : null,
        }),
      },
    })
    for (const [dimension, state] of [
      ["location", eligibility.location],
      ["language", eligibility.language],
      ["employment_type", eligibility.employmentType],
      ["seniority", eligibility.seniority],
    ] as const) {
      addEvent(job, {
        stage: "final_eligibility",
        decision: state === "eligible" ? "passed" : state === "ineligible" ? "rejected" : "unknown",
        reasonCode: state === "eligible" ? `${dimension.toUpperCase()}_ELIGIBLE`
          : state === "ineligible" ? `${dimension.toUpperCase()}_INCOMPATIBLE`
            : `${dimension.toUpperCase()}_UNRESOLVED`,
        evidenceStatus: state === "unclear" ? "missing" : "present",
      })
    }
  }
  const finalEligibilityByKey = new Map(classifiedJobs.map(({ job, eligibility }) => [discoveryKey(job), eligibility]))
  const roleClassifications = new Map(classifiedJobs.map(({ job, eligibility }) => [discoveryKey(job), eligibility.role]))
  const jobsByKey = new Map(jobs.map((job) => [discoveryKey(job), job]))
  const livenessFailures = evidenceCandidates.filter((candidate) => jobsByKey.get(discoveryKey(candidate))?.validation?.status !== "active").length
  const jdHydrationSuccesses = liveForHydration.filter((job) => enrichedByKey.get(discoveryKey(job))?.descriptionKind === "full").length
  const roleResolvedAfterJd = inputJobs.filter((job) => initialRoleClassifications.get(discoveryKey(job)) === "target_adjacent" && roleClassifications.get(discoveryKey(job)) !== "target_adjacent" && roleClassifications.get(discoveryKey(job)) !== "unclear").length
  const locationResolvedAfterJd = inputJobs.filter((job) =>
    initialLocationByKey.get(discoveryKey(job)) === "unclear"
    && finalEligibilityByKey.get(discoveryKey(job))?.location !== "unclear"
  ).length
  const finalActionableJobs = classifiedJobs.filter(({ eligibility }) => eligibility.actionable).map(({ job }) => job)
  const classificationMs = Math.max(0, Math.round(performance.now() - classificationStartedAt))
  const eligibilityRows = classifiedJobs.map(({ eligibility }) => eligibility)
  const eligibilityStats = {
    locationIneligible: eligibilityRows.filter((item) => item.location === "ineligible").length,
    locationUnclear: eligibilityRows.filter((item) => item.location === "unclear").length,
    languageIneligible: eligibilityRows.filter((item) => item.language === "ineligible").length,
    languageUnclear: eligibilityRows.filter((item) => item.language === "unclear").length,
    employmentTypeIneligible: eligibilityRows.filter((item) => item.employmentType === "ineligible").length,
    employmentTypeUnclear: eligibilityRows.filter((item) => item.employmentType === "unclear").length,
    seniorityIneligible: eligibilityRows.filter((item) => item.seniority === "ineligible").length,
    metadataUnresolved: eligibilityRows.filter((item) => item.metadata_unresolved).length,
  }
  return {
    jobs,
    initialRoleClassifications,
    roleClassifications,
    candidateEvents,
    candidateFacts,
    stats: {
      earlyUnrelatedExclusions,
      earlyPreferenceExclusions,
      targetMatches: [...roleClassifications.values()].filter((value) => value === "target_match").length,
      targetAdjacent: [...roleClassifications.values()].filter((value) => value === "target_adjacent").length,
      unrelated: [...roleClassifications.values()].filter((value) => value === "unrelated").length,
      excluded: [...roleClassifications.values()].filter((value) => value === "excluded").length,
      ...eligibilityStats,
      targetAdjacentSentForEvidence: evidenceCandidates.filter((job) => initialRoleClassifications.get(discoveryKey(job)) === "target_adjacent").length,
      locationUnclearSentForEvidence: evidenceCandidates.filter((job) => classifyLocationEligibility(job, profile) === "unclear").length,
      livenessFailures,
      jdHydrationSuccesses,
      jdHydrationFailures: Math.max(0, liveForHydration.length - jdHydrationSuccesses),
      jdHydration: enrichmentResult.stats,
      roleResolvedAfterJd,
      locationResolvedAfterJd,
      finalActionable: finalActionableJobs.length,
      fitReady: finalActionableJobs.filter((job) => job.descriptionKind === "full").length,
      validationCacheHits: validated.stats?.cacheHits ?? 0,
      validationNetworkChecks: validated.stats?.networkValidations ?? 0,
      validationMs,
      hydrationMs,
      screeningMs,
      classificationMs,
    },
  }
}

export async function runGenericDiscovery(options: GenericDiscoveryOptions): Promise<DiscoveryRunResult> {
  const pipelineStartedAt = performance.now()
  const timings: Record<string, number> = {}
  const recordTiming = (name: string, startedAt: number) => {
    timings[name] = Math.max(0, Math.round(performance.now() - startedAt))
  }
  const now = options.now ?? new Date()
  const tracingEnabled = options.candidateTracing ?? candidateTracingEnabled()
  const store = options.store
  const userId = options.userId?.trim() || process.env.AI_JOB_SEARCH_USER_ID?.trim()
  const profile = options.profile ?? (store
    ? await store.getActiveSearchProfile(userId || (() => { throw new Error("userId is required to load a SearchProfile") })())
    : (() => { throw new Error("profile or store is required") })())
  if (userId && profile.user_id !== userId) throw new Error("SearchProfile owner does not match the requested user")
  if (store instanceof SupabaseDiscoveryStore && !options.dryRun) {
    await store.detectPhysicalIdentityMode(profile.user_id)
  }
  const queries = buildSearchQueries(profile, options.mode)
  const targetedQueries = buildSearchQueries(profile, "targeted")
  if (!queries.length) throw new Error("SearchProfile contains no usable discovery terms")
  const sourceSelection = await diagnoseSourceSelection(".agents/skills", profile)
  const eligibleSources = sourceSelection.filter((item) => item.selected).map((item) => item.provider)
  const sourceNames = options.sourceNames
    ? eligibleSources.filter((source) => options.sourceNames!.includes(source))
    : eligibleSources
  const runners = options.sourceRunners ?? sourceNames.map((source) => makeCliSourceRunner(source))
  const startedAt = now.toISOString()
  const runId = store && !options.dryRun ? await store.createSearchRun({ profile, mode: options.mode, startedAt }) : `dry-run-${randomUUID()}`
  recordTiming("profile_and_source_setup_ms", pipelineStartedAt)
  const definition = profile.definition ?? {}
  const constraints = definition.eligibility_constraints
  const configuredScope = constraints && typeof constraints === "object" ? String((constraints as Record<string, unknown>).remote_scope ?? "") : ""
  const locations = unique([
    ...values(definition, "locations", "locations"),
    ...values(definition, "allowed_regions", "allowed_regions"),
    ...values(definition, "allowed_countries", "allowed_countries"),
    ...configuredScope.split(/[\/,]+/),
  ])
  const workModels = values(definition, "work_models", "workModels")
  if (definition.remote_only === true && !workModels.includes("remote")) workModels.push("remote")
  const portalStartedAt = performance.now()
  const sourceResults = await Promise.all(runners.map(async (runner, index) => {
    try {
      return await runner({
        discoveryQueries: queries,
        discoveryLocations: locations,
        discoveryWorkModels: workModels,
        limit: options.limit,
        now,
      })
    } catch (error) {
      const source = sourceNames[index] ?? `source-${index + 1}`
      return {
        detail: {
          name: source,
          attempted: true,
          success: false,
          status: "failed" as const,
          errorCategory: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
          runtimeMs: 0,
          jobsReturned: 0,
          normalizedJobs: 0,
          expiredJobs: 0,
          validationFailures: 0,
          uniqueJobs: 0,
          duplicateJobs: 0,
          finalActionableJobs: 0,
        },
        jobs: [],
      }
    }
  }))
  recordTiming("portal_sources_ms", portalStartedAt)
  const errors = sourceResults.flatMap((result) => result.detail.error ? [{
    source: result.detail.name,
    message: result.detail.error,
    ...(result.detail.errorCategory ? { category: result.detail.errorCategory } : {}),
  }] : [])
  let atsResult: { stats: AtsIngestionStats; results: AtsFetchResult[]; jobs: NormalizedJob[]; history?: JsonJobHistoryStore; registrySource?: "local" | "supabase"; registryWarning?: string } | null = null
  const shouldEnumerateAts = Boolean(options.atsRunner || store instanceof SupabaseDiscoveryStore)
  if (shouldEnumerateAts) {
    try {
      const atsStartedAt = performance.now()
      const atsRunner = options.atsRunner ?? runAtsJobIngestion
      atsResult = await atsRunner({
        registryPath: options.atsRegistryPath ?? DEFAULT_REGISTRY_PATH,
        registrySource: options.atsRegistrySource,
        rotationSlot: options.atsRotationSlot,
        historyPath: options.atsHistoryPath ?? DEFAULT_JOB_HISTORY_PATH,
        boardBudget: options.atsBoardBudget ?? configuredDashboardAtsBoardBudget(),
        deferSuccessfulFreshness: Boolean(store && !options.dryRun),
        dryRun: options.dryRun,
        noHistory: options.dryRun,
        now,
      })
      recordTiming("ats_ingestion_ms", atsStartedAt)
    } catch (error) {
      errors.push({ source: "ats-registry", message: error instanceof Error ? error.message : String(error) })
      if (!timings.ats_ingestion_ms) timings.ats_ingestion_ms = 0
    }
  }
  if (atsResult?.registryWarning) errors.push({ source: "ats-registry", message: atsResult.registryWarning })
  errors.push(...(atsResult?.stats.errors ?? [])
    .filter((item) => item.companyId === "history")
    .map((item) => ({ source: "ats-history", message: item.error })))
  const atsSourceResults: SourceRunResult[] = (atsResult?.results ?? []).map((result) => ({
    detail: {
      name: `ats:${result.provider}:${result.identifier}`,
      attempted: true,
      success: result.success,
      status: result.boardStatus === "rate_limited" ? "rate_limited"
        : result.boardStatus === "invalid_mapping" ? "validation_failure"
          : result.boardStatus === "partial" ? "partial"
            : result.boardStatus === "empty" ? "zero_results"
          : result.success ? "success" : "provider_error",
      errorCategory: !result.success ? (result.boardStatus === "rate_limited" ? "rate_limited" : "provider_error") : undefined,
      error: result.error ?? (result.boardStatus === "partial" ? "Board pagination budget reached; snapshot is incomplete." : undefined),
      runtimeMs: 0,
      jobsReturned: result.allJobs.length,
      normalizedJobs: result.jobs.length,
      expiredJobs: 0,
      validationFailures: result.boardStatus === "invalid_mapping" ? 1 : 0,
      uniqueJobs: result.jobs.length,
      duplicateJobs: Math.max(0, result.allJobs.length - result.jobs.length),
      finalActionableJobs: 0,
    },
    jobs: result.jobs,
  }))
  const allSourceResults = [...sourceResults, ...atsSourceResults]
  const atsBoardContextByKey = new Map<string, Record<string, unknown>>()
  if (tracingEnabled) {
    for (const result of atsResult?.results ?? []) {
      for (const raw of result.allJobs) {
        const normalizedJob = normalizeDiscoveredJob(raw, `ats:${result.provider}:${result.identifier}`)
        if (!normalizedJob) continue
        atsBoardContextByKey.set(discoveryKey(normalizedJob), {
          ats_snapshot_complete: result.snapshotComplete,
          ats_board_status: result.boardStatus,
          ...(Number.isSafeInteger(result.httpStatus) ? { ats_http_status: result.httpStatus } : {}),
        })
      }
    }
  }
  const traceByDiscoveryKey = new Map<string, CandidateTraceRecord>()
  const traceLimit = options.candidateTraceLimit ?? traceCandidateLimit()
  let traceRecordsSeen = 0
  let traceCollectionOmitted = 0
  if (tracingEnabled) {
    for (const result of allSourceResults) {
      for (const raw of result.jobs) {
        const normalizedJob = normalizeDiscoveredJob(raw, result.detail.name)
        if (!normalizedJob) continue
        const key = discoveryKey(normalizedJob)
        const trace = createCandidateTrace(
          raw,
          result.detail.name,
          runId,
          startedAt,
          atsBoardContextByKey.get(key) ?? {},
        )
        const acquisitionCode = result.detail.status === "rate_limited" ? "SOURCE_RATE_LIMITED"
          : result.detail.status === "timeout" ? "SOURCE_TIMEOUT"
            : result.detail.status === "partial" ? "SOURCE_PARTIAL"
              : result.detail.success ? "SOURCE_SUCCESS" : "SOURCE_FAILED"
        let withAcquisition = appendTraceEvent(trace, {
          stage: "acquisition",
          decision: result.detail.success ? "passed" : result.detail.jobsReturned ? "unknown" : "failed",
          reasonCode: acquisitionCode,
          evidenceStatus: result.detail.success ? "present" : "partial",
        })
        const missingRequired = !text(raw.title) || !text(raw.company)
        withAcquisition = appendTraceEvent(withAcquisition, {
          stage: "parsing",
          decision: missingRequired ? "unknown" : "passed",
          reasonCode: missingRequired ? "MISSING_REQUIRED_FIELD" : "PARSE_SUCCESS",
          evidenceStatus: missingRequired ? "partial" : "present",
        })
        const rawUrl = raw.sourceUrl ?? raw.canonicalUrl ?? raw.url ?? raw.applicationUrl ?? raw.applyUrl
        if (typeof rawUrl === "string" && rawUrl.trim() && !sanitizeTraceUrl(rawUrl)) {
          withAcquisition = appendTraceEvent(withAcquisition, {
            stage: "parsing",
            decision: "unknown",
            reasonCode: "INVALID_JOB_URL",
            evidenceStatus: "conflicting",
          })
        }
        const sourceIdPresent = raw.sourceType === "ats"
          ? Boolean((raw.ats as Record<string, unknown> | undefined)?.requisitionId)
          : Boolean(raw.sourceJobId ?? raw.id)
        if (!sourceIdPresent && !sanitizeTraceUrl(rawUrl)) {
          withAcquisition = appendTraceEvent(withAcquisition, {
            stage: "identity",
            decision: "unknown",
            reasonCode: "IDENTITY_UNRESOLVED",
            evidenceStatus: "missing",
          })
        }
        const initialRole = classifyTargetRole(normalizedJob.title, profile)
        const initialEligibility = evaluateFinalJobEligibility(normalizedJob, profile)
        const initialPreferenceStates = [initialEligibility.location, initialEligibility.language, initialEligibility.employmentType, initialEligibility.seniority]
        const initialRejected = initialRole === "unrelated" || initialRole === "excluded" || initialPreferenceStates.includes("ineligible")
        const initialUnknown = initialRole === "unclear" || initialPreferenceStates.includes("unclear")
        withAcquisition = {
          ...withAcquisition,
          metadata: { ...withAcquisition.metadata, trace_selection_priority: initialRejected ? 0 : initialUnknown ? 1 : 2 },
        }
        if (!traceByDiscoveryKey.has(key)) traceByDiscoveryKey.set(key, withAcquisition)
        else {
          traceByDiscoveryKey.set(key, appendTraceEvent(traceByDiscoveryKey.get(key)!, {
            stage: "identity",
            decision: "merged",
            reasonCode: "DUPLICATE_SOURCE_OBSERVATION",
            evidenceStatus: "present",
          }))
        }
        if (!traceByDiscoveryKey.has(key)) continue
        if (traceByDiscoveryKey.get(key) === withAcquisition) traceRecordsSeen += 1
        if (traceByDiscoveryKey.size > traceLimit + 256) {
          const capped = capCandidateTraces([...traceByDiscoveryKey.values()], traceLimit)
          traceCollectionOmitted += capped.omitted
          const selectedIdentities = new Set(capped.records.map((record) => record.candidate_identity))
          for (const [candidateKey, record] of traceByDiscoveryKey) {
            if (!selectedIdentities.has(record.candidate_identity)) traceByDiscoveryKey.delete(candidateKey)
          }
        }
      }
    }
  }
  const rawCount = allSourceResults.reduce((sum, result) => sum + result.jobs.length, 0)
  errors.push(...atsSourceResults.flatMap((result) => result.detail.error ? [{ source: result.detail.name, message: result.detail.error }] : []))
  const evidenceStartedAt = performance.now()
  const normalizedJobs = mergeDiscoveredJobs(allSourceResults.flatMap((result) => result.jobs.flatMap((job) => normalizeDiscoveredJob(job, result.detail.name) ?? [])))
  const evidence = await verifyAndHydrateDiscoveredJobs(normalizedJobs, profile, {
    now,
    validator: options.validator,
    enricher: options.enricher,
    traceCandidates: tracingEnabled,
    traceCandidateKeys: tracingEnabled ? new Set(traceByDiscoveryKey.keys()) : undefined,
  })
  const jobs = evidence.jobs
  const initialRoleClassifications = evidence.initialRoleClassifications
  const roleClassifications = evidence.roleClassifications
  if (tracingEnabled) {
    for (const [key, events] of evidence.candidateEvents) {
      let trace = traceByDiscoveryKey.get(key)
      if (!trace) continue
      for (const event of events) trace = appendTraceEvent(trace, event)
      traceByDiscoveryKey.set(key, trace)
    }
    for (const [key, facts] of evidence.candidateFacts) {
      const trace = traceByDiscoveryKey.get(key)
      if (trace) traceByDiscoveryKey.set(key, { ...trace, metadata: { ...trace.metadata, ...facts } })
    }
  }
  let filteredIrrelevant = 0
  const persistableJobs = jobs.filter((job) => {
    const role = roleClassifications.get(discoveryKey(job)) ?? "unclear"
    const initialRole = initialRoleClassifications.get(discoveryKey(job))
    if (role !== "target_match" && role !== "target_adjacent" && !(role === "unclear" && initialRole === "target_adjacent")) {
      filteredIrrelevant += 1
      return false
    }
    return true
  })
  if (tracingEnabled) {
    const persistableKeys = new Set(persistableJobs.map(discoveryKey))
    for (const job of jobs) {
      const key = discoveryKey(job)
      if (persistableKeys.has(key)) continue
      const role = roleClassifications.get(key) ?? "unclear"
      const trace = traceByDiscoveryKey.get(key)
      if (trace) traceByDiscoveryKey.set(key, {
        ...appendTraceEvent(trace, {
          stage: "persistence",
          decision: role === "unrelated" || role === "excluded" ? "rejected" : "unknown",
          reasonCode: role === "excluded" ? "ROLE_EXCLUDED" : role === "unrelated" ? "ROLE_UNRELATED" : "ROLE_UNCERTAIN",
          evidenceStatus: role === "unclear" ? "missing" : "present",
        }),
        final_outcome: role === "excluded" ? "rejected_role_exclusion" : role === "unrelated" ? "rejected_unrelated_role" : "not_persisted_role_uncertain",
      })
    }
    for (const job of persistableJobs) {
      const key = discoveryKey(job)
      const trace = traceByDiscoveryKey.get(key)
      if (trace) traceByDiscoveryKey.set(key, { ...trace, final_outcome: "awaiting_identity_resolution" })
    }
  }
  recordTiming("normalization_validation_and_hydration_ms", evidenceStartedAt)
  timings.validation_ms = evidence.stats.validationMs
  timings.jd_hydration_ms = evidence.stats.hydrationMs
  timings.pre_evidence_screening_ms = evidence.stats.screeningMs
  timings.final_eligibility_classification_ms = evidence.stats.classificationMs
  const stats: DiscoveryStats = {
    source_count: allSourceResults.length,
    raw_discovered: rawCount,
    normalized: normalizedJobs.length,
    new_jobs: 0,
    existing_jobs: 0,
    suppressed: 0,
    expired: jobs.filter((job) => job.validation?.status === "expired").length,
    validation_failed: jobs.filter((job) => job.validation?.status === "validation_failed").length,
    unknown: jobs.filter((job) => job.validation?.status === "uncertain").length,
    validation_skipped: jobs.filter((job) => !job.validation).length,
    early_unrelated_exclusions: evidence.stats.earlyUnrelatedExclusions,
    early_preference_exclusions: evidence.stats.earlyPreferenceExclusions,
    filtered_irrelevant: filteredIrrelevant,
    filtered_ineligible: 0,
    preference_mismatches_retained: 0,
    eligibility_unclear_retained: 0,
    target_matches: evidence.stats.targetMatches,
    target_adjacent: evidence.stats.targetAdjacent,
    unrelated: evidence.stats.unrelated,
    excluded: evidence.stats.excluded,
    location_ineligible: evidence.stats.locationIneligible,
    location_unclear: evidence.stats.locationUnclear,
    language_ineligible: evidence.stats.languageIneligible,
    language_unclear: evidence.stats.languageUnclear,
    employment_type_ineligible: evidence.stats.employmentTypeIneligible,
    employment_type_unclear: evidence.stats.employmentTypeUnclear,
    seniority_ineligible: evidence.stats.seniorityIneligible,
    metadata_unresolved: evidence.stats.metadataUnresolved,
    target_adjacent_sent_for_evidence: evidence.stats.targetAdjacentSentForEvidence,
    location_unclear_sent_for_evidence: evidence.stats.locationUnclearSentForEvidence,
    liveness_failures: evidence.stats.livenessFailures,
    jd_hydration_successes: evidence.stats.jdHydrationSuccesses,
    jd_hydration_failures: evidence.stats.jdHydrationFailures,
    jd_hydration: evidence.stats.jdHydration,
    jd_hydration_summary: formatEnrichmentSummary(evidence.stats.jdHydration),
    role_resolved_after_jd: evidence.stats.roleResolvedAfterJd,
    location_resolved_after_jd: evidence.stats.locationResolvedAfterJd,
    final_actionable: 0,
    fit_ready: 0,
    active_actionable: 0,
    fit_calls: 0,
    cache_hits: evidence.stats.validationCacheHits,
    ats_boards_considered: atsResult?.stats.boardsConsidered ?? 0,
    ats_boards_crawled: atsResult?.stats.boardsCrawled ?? 0,
    ats_boards_success: atsResult?.stats.successfulBoards ?? 0,
    ats_boards_empty: atsResult?.stats.emptyBoards ?? 0,
    ats_boards_partial: atsResult?.stats.partialBoards ?? 0,
    ats_boards_failed: atsResult?.stats.failedBoards ?? 0,
    ats_boards_rate_limited: atsResult?.stats.rateLimitedBoards ?? 0,
    ats_boards_skipped: atsResult?.stats.boardsSkippedFresh ?? 0,
    ats_boards_deferred_budget: atsResult?.stats.boardsDeferredBudget ?? 0,
    ats_rotation_slot: atsResult?.stats.rotationSlot ?? null,
    ats_selected_boards: atsResult?.stats.selectedBoardIds ?? [],
    ats_boards_invalid_mapping: atsResult?.stats.invalidMappings ?? 0,
    ats_jobs_raw: atsResult?.stats.totalJobsFetched ?? 0,
    ats_jobs_unique: atsResult?.jobs.length ?? 0,
    ats_jobs_relevant: 0,
    ats_jobs_retained: 0,
    ats_jobs_actionable: 0,
    ats_jobs_preference_mismatch: 0,
    ats_jobs_unclear: 0,
    ats_historical_jobs_closed: atsResult?.stats.historicalJobsClosed ?? 0,
    ats_registry_source: atsResult?.registrySource ?? (shouldEnumerateAts ? "unavailable" : undefined),
    ats_registry_warning: atsResult?.registryWarning,
    ats_job_rows_closed: 0,
    portal_candidates: sourceResults.reduce((count, result) => count + result.jobs.length, 0),
    combined_unique_candidates: normalizedJobs.length,
    validation_network_checks: evidence.stats.validationNetworkChecks,
    timings_ms: timings,
    ats_provider_counts: atsResult?.stats.providerDistribution ?? {},
    physical_identity_mode: store instanceof SupabaseDiscoveryStore ? store.physicalIdentityMode : "unknown",
    errors,
    provider_selection: sourceSelection,
    candidate_traces: {
      enabled: tracingEnabled,
      attempted: tracingEnabled ? traceRecordsSeen : 0,
      persisted: 0,
      omitted_by_cap: 0,
      persistence_failures: 0,
      retention_pruned: 0,
      retention_failures: 0,
      retention_days: traceRetentionDays(),
      raw_candidate_observations: rawCount,
      ...(tracingEnabled ? traceSummary([...traceByDiscoveryKey.values()]) : {}),
      acquisition_sources: allSourceResults.map(({ detail }) => ({
        source: detail.name,
        status: detail.status,
        jobs_returned: detail.jobsReturned,
      })),
    },
  }
  let candidateTraceFlushAttempted = false
  const flushCandidateTraces = async (persist: boolean): Promise<void> => {
    if (!tracingEnabled || candidateTraceFlushAttempted) return
    candidateTraceFlushAttempted = true
    const records = [...traceByDiscoveryKey.values()]
    const capped = capCandidateTraces(records, options.candidateTraceLimit ?? traceCandidateLimit())
    const summary = traceSummary(records)
    Object.assign(stats.candidate_traces!, summary, {
      attempted: traceRecordsSeen,
      omitted_by_cap: traceCollectionOmitted + capped.omitted,
      persisted: 0,
      persistence_failures: 0,
      retention_pruned: 0,
      retention_failures: 0,
    })
    if (!persist) return
    const persistableTraceRecords = capped.records.map((record) => {
      const metadata = { ...record.metadata }
      delete metadata.trace_selection_priority
      return { ...record, metadata }
    })
    stats.candidate_traces!.write = emptyCandidateTraceWriteStats(persistableTraceRecords.length)
    if (persistableTraceRecords.length) {
      if (!store.persistCandidateTraces) {
        stats.candidate_traces!.persistence_failures = persistableTraceRecords.length
        stats.candidate_traces!.write = {
          ...emptyCandidateTraceWriteStats(persistableTraceRecords.length),
          records_not_attempted: persistableTraceRecords.length,
          records_skipped_after_failure: persistableTraceRecords.length,
          write_failure_kind: "unsupported_store",
        }
        process.stderr.write("[discovery-tracing] Trace persistence is not supported by this store.\n")
      } else {
        try {
          const result = await store.persistCandidateTraces(persistableTraceRecords)
          stats.candidate_traces!.persisted = result.persisted
          stats.candidate_traces!.persistence_failures = result.failures
          stats.candidate_traces!.write = result.diagnostics ?? {
            ...emptyCandidateTraceWriteStats(persistableTraceRecords.length),
            records_persisted: result.persisted,
            records_outcome_unknown: result.failures,
            write_failure_kind: result.failures ? "store_error" : null,
          }
          if (result.failures) process.stderr.write("[discovery-tracing] Some candidate traces could not be stored; discovery continued.\n")
        } catch {
          stats.candidate_traces!.persistence_failures = persistableTraceRecords.length
          stats.candidate_traces!.write = {
            ...emptyCandidateTraceWriteStats(persistableTraceRecords.length),
            records_outcome_unknown: persistableTraceRecords.length,
            write_failure_kind: "store_error",
          }
          process.stderr.write("[discovery-tracing] Candidate trace storage failed; discovery continued.\n")
        }
      }
    }
    if (store.pruneCandidateTraces) {
      try {
        stats.candidate_traces!.retention_pruned = await store.pruneCandidateTraces(traceRetentionDays(), traceCleanupBatchSize())
      } catch {
        stats.candidate_traces!.retention_failures = 1
        process.stderr.write("[discovery-tracing] Retention cleanup failed; discovery continued.\n")
      }
    }
  }
  const atsJobs = persistableJobs.filter((job) => job.raw.sourceType === "ats")
  stats.ats_jobs_relevant = atsJobs.length
  stats.ats_jobs_retained = atsJobs.length
  stats.ats_jobs_actionable = atsJobs.filter((job) => evaluateFinalJobEligibility(job, profile).actionable).length
  stats.ats_jobs_preference_mismatch = atsJobs.filter((job) => {
    const eligibility = evaluateFinalJobEligibility(job, profile)
    return [eligibility.location, eligibility.language, eligibility.employmentType, eligibility.seniority].includes("ineligible")
  }).length
  stats.ats_jobs_unclear = atsJobs.filter((job) => {
    const eligibility = evaluateFinalJobEligibility(job, profile)
    return [eligibility.location, eligibility.language, eligibility.employmentType, eligibility.seniority].includes("unclear") || eligibility.role === "unclear"
  }).length
  if (!store || options.dryRun) {
    await flushCandidateTraces(false)
    stats.active_actionable = evidence.stats.finalActionable
    stats.final_actionable = evidence.stats.finalActionable
    stats.fit_ready = evidence.stats.fitReady
  }
  const sourceDetails = allSourceResults.map(({ detail, jobs: sourceJobs }) => {
    const { normalizedJobs: _normalizedCount, finalActionableJobs: _legacyEligible, ...genericDetail } = detail
    const sourceDiscoveredJobs = sourceJobs.flatMap((job) => normalizeDiscoveredJob(job, detail.name) ?? [])
    const roleStates = sourceDiscoveredJobs.map((job) => roleClassifications.get(discoveryKey(job)))
    const resolvedByKey = new Map(jobs.map((job) => [discoveryKey(job), job]))
    const finalActionable = sourceDiscoveredJobs.filter((job) => {
      const resolved = resolvedByKey.get(discoveryKey(job))
      return resolved?.validation?.status === "active" && evaluateFinalJobEligibility(resolved, profile).actionable
    }).length
    return { ...genericDetail, target_matches: roleStates.filter((role) => role === "target_match").length, target_adjacent: roleStates.filter((role) => role === "target_adjacent").length, final_actionable: finalActionable }
  })
  if (store && !options.dryRun) {
    let atsPersistenceComplete = true
    const runStoreOperation = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation()
      } catch (error) {
        const message = discoveryFailureMessage(stage, error)
        if (stage !== "finish search run") await markSearchRunFailed(store, { runId, stats, errorMessage: message })
        if (tracingEnabled && stage !== "finish search run" && !stage.startsWith("upserting job from ")) {
          const associationFailure = stage.startsWith("associating discovered")
          const suppressionFailureKey = stage.startsWith("checking application suppression for ")
            ? stage.slice("checking application suppression for ".length)
            : null
          for (const [key, trace] of traceByDiscoveryKey) {
            const alreadyPersisted = ["created", "updated", "suppressed"].includes(trace.final_outcome)
            const affected = suppressionFailureKey
              ? key === suppressionFailureKey && ["created", "updated"].includes(trace.final_outcome)
              : associationFailure
                ? alreadyPersisted
                : ["processing", "awaiting_identity_resolution"].includes(trace.final_outcome)
            if (!affected) continue
            const reasonCode = suppressionFailureKey ? "SUPPRESSION_CHECK_FAILED"
              : associationFailure ? "RUN_ASSOCIATION_FAILED" : "PERSISTENCE_FAILED"
            traceByDiscoveryKey.set(key, {
              ...appendTraceEvent(trace, {
                stage: "persistence",
                decision: "failed",
                reasonCode,
                evidenceStatus: "partial",
              }),
              final_outcome: suppressionFailureKey ? "suppression_check_failed"
                : associationFailure ? "run_association_failed" : "persistence_failed",
            })
          }
          await flushCandidateTraces(true)
          try {
            await store.finishSearchRun({
              runId,
              status: "failed",
              finishedAt: new Date().toISOString(),
              stats,
              errorMessage: message,
            })
          } catch {
            // Preserve the original persistence failure; diagnostics are best effort.
          }
        }
        throw new Error(message)
      }
    }
    const closedHistory = (atsResult?.results ?? []).flatMap((result) => result.closedJobs ?? [])
    const atsLifecycleStartedAt = performance.now()
    if (closedHistory.length && store.closeAtsJobs) {
      const closeResult = await runStoreOperation("persisting ATS lifecycle updates", () => store.closeAtsJobs!(closedHistory))
      stats.ats_job_rows_closed = closeResult.closed
      if (closeResult.errors.length) atsPersistenceComplete = false
      stats.errors.push(...closeResult.errors.map((message) => ({ source: "ats-lifecycle", message })))
    }
    recordTiming("ats_lifecycle_persistence_ms", atsLifecycleStartedAt)
    const processedJobIds: Array<number | string> = []
    const runAssociations = new Map<string, { jobId: number | string; outcome: AssociationOutcome; contexts: Record<string, unknown>[] }>()
    const loadJobsStartedAt = performance.now()
    const existingRows = [...await runStoreOperation("loading existing jobs", () => store.loadJobs())]
    recordTiming("load_existing_jobs_ms", loadJobsStartedAt)
    const existingByKey = new Map<string, Record<string, unknown>>()
    const existingByWeakIdentity = new Map<string, Record<string, unknown>[]>()
    for (const row of existingRows) {
      const existing = normalizeDiscoveredJob({
        source: row.source,
        sourceJobId: row.source_job_id,
        sourceUrl: row.source_url,
        applicationUrl: row.application_url,
        company: row.company,
        title: row.title,
        location: row.location,
        remoteScope: row.remote_scope,
        employmentType: row.employment_type,
        description: row.description,
        descriptionKind: row.description_kind,
        postedAt: row.posted_at,
      }, String(row.source))
      if (existing) existingByKey.set(discoveryKey(existing), row)
      const weakKey = weakDuplicateBucketKey(row.company, row.title, row.location)
      const bucket = existingByWeakIdentity.get(weakKey) ?? []
      bucket.push(row)
      existingByWeakIdentity.set(weakKey, bucket)
    }
    const persistJobsStartedAt = performance.now()
    const persistedCandidates: Array<{
      job: DiscoveredJob
      existing: Record<string, unknown> | undefined
      observation: ReturnType<typeof sourceObservationFor>
      sourceContext: Record<string, unknown>
      persisted: { id: number | string; created: boolean; availabilityStatus?: string }
    }> = []
    for (const job of persistableJobs) {
      const existing = existingByKey.get(discoveryKey(job))
      const identityRaw: NormalizedJob = {
        ...job.raw, source: job.source, portal: job.source, sourceJobId: job.sourceJobId ?? undefined,
        sourceUrl: job.sourceUrl ?? undefined, applicationUrl: job.applicationUrl ?? undefined,
        title: job.title, company: job.company, location: job.location ?? undefined,
        remoteScope: job.remoteScope ?? undefined, employmentType: job.employmentType ?? undefined,
        description: job.description ?? undefined, validation: job.validation,
      }
      const observation = sourceObservationFor(identityRaw, job.source)
      const sourceContext = {
        mode: options.mode,
        discovery_method: job.raw.sourceType === "ats" ? "ats" : "portal",
        ats_provider: job.raw.sourceType === "ats" ? (job.raw.ats as Record<string, unknown> | undefined)?.provider : undefined,
        ats_board_identifier: job.raw.sourceType === "ats" ? (job.raw.ats as Record<string, unknown> | undefined)?.companyIdentifier : undefined,
        ats_requisition_id: job.raw.sourceType === "ats" ? (job.raw.ats as Record<string, unknown> | undefined)?.requisitionId : undefined,
        ats_registry_source: job.raw.sourceType === "ats" && job.raw.metadata && typeof job.raw.metadata === "object"
          ? (job.raw.metadata as Record<string, unknown>).registrySource
          : undefined,
        physical_identity_mode: stats.physical_identity_mode,
        query_terms: queries,
        query_matches: queryGroupsForMatches(acquisitionQueries(job), targetedQueries),
        possible_duplicate_job_ids: weakDuplicateCandidates(
          job,
          observation,
          existingByWeakIdentity.get(weakDuplicateBucketKey(job.company, job.title, job.location)) ?? [],
        ),
      }
      const traceKey = discoveryKey(job)
      if (tracingEnabled) {
        const trace = traceByDiscoveryKey.get(traceKey)
        if (trace) traceByDiscoveryKey.set(traceKey, appendTraceEvent(trace, {
          stage: "identity",
          decision: existing ? "unknown" : "not_attempted",
          reasonCode: existing ? "EXISTING_PHYSICAL_JOB_CANDIDATE" : "IDENTITY_RESOLUTION_ATTEMPTED",
          evidenceStatus: existing ? "present" : "partial",
        }))
      }
      let persisted: Awaited<ReturnType<typeof store.upsertJob>>
      try {
        persisted = await runStoreOperation(`upserting job from ${job.source}`, () => store.upsertJob({ job, existing, now: new Date().toISOString(), context: sourceContext }))
      } catch (error) {
        if (tracingEnabled) {
          const trace = traceByDiscoveryKey.get(traceKey)
          if (trace) traceByDiscoveryKey.set(traceKey, {
            ...appendTraceEvent(trace, { stage: "persistence", decision: "failed", reasonCode: "PERSISTENCE_FAILED", evidenceStatus: "present" }),
            final_outcome: "persistence_failed",
          })
          await flushCandidateTraces(true)
          try {
            await store.finishSearchRun({
              runId,
              status: "failed",
              finishedAt: new Date().toISOString(),
              stats,
              errorMessage: error instanceof Error ? error.message : "Discovery persistence failed",
            })
          } catch {
            // Keep the original business-persistence failure authoritative.
          }
        }
        throw error
      }
      if (persisted.physicalIdentityMode) {
        stats.physical_identity_mode = persisted.physicalIdentityMode
        sourceContext.physical_identity_mode = persisted.physicalIdentityMode
      }
      if (persisted.identityConflict || persisted.id === null) {
        if (job.raw.sourceType === "ats") atsPersistenceComplete = false
        stats.errors.push({ source: job.source, message: "Physical identity conflict or source URL collision; listing skipped for reconciliation." })
        if (tracingEnabled) {
          const trace = traceByDiscoveryKey.get(traceKey)
          if (trace) traceByDiscoveryKey.set(traceKey, {
            ...appendTraceEvent(trace, { stage: "identity", decision: "skipped", reasonCode: "IDENTITY_CONFLICT", evidenceStatus: "conflicting" }),
            final_outcome: "identity_conflict",
          })
        }
        continue
      }
      if (tracingEnabled) {
        const trace = traceByDiscoveryKey.get(traceKey)
        if (trace) traceByDiscoveryKey.set(traceKey, {
          ...appendTraceEvent(trace, {
            stage: "identity",
            decision: "passed",
            reasonCode: persisted.created ? "NEW_PHYSICAL_JOB" : "EXISTING_PHYSICAL_JOB",
            evidenceStatus: "present",
          }),
          physical_job_id: persisted.id,
          final_outcome: persisted.created ? "created" : "updated",
        })
      }
      const persistedRow = {
        id: persisted.id,
        source: job.source,
        source_job_id: job.sourceJobId,
        source_url: job.sourceUrl,
        application_url: job.applicationUrl,
        company: job.company,
        title: job.title,
        location: job.location,
      }
      const weakKey = weakDuplicateBucketKey(persistedRow.company, persistedRow.title, persistedRow.location)
      const bucket = existingByWeakIdentity.get(weakKey) ?? []
      bucket.push(persistedRow)
      existingByWeakIdentity.set(weakKey, bucket)
      processedJobIds.push(persisted.id)
      if (persisted.created) stats.new_jobs += 1
      else stats.existing_jobs += 1
      persistedCandidates.push({ job, existing, observation, sourceContext, persisted })
    }
    recordTiming("job_upserts_and_identity_context_ms", persistJobsStartedAt)
    const suppressionStartedAt = performance.now()
    const suppressionResults = await mapWithConcurrency(persistedCandidates, 8, (candidate) =>
      runStoreOperation(`checking application suppression for ${discoveryKey(candidate.job)}`, () => store.isSuppressed({
        userId: profile.user_id,
        job: candidate.job,
        jobId: candidate.persisted.id,
      })),
    )
    recordTiming("suppression_checks_ms", suppressionStartedAt)
    const associationContextStartedAt = performance.now()
    for (const [index, candidate] of persistedCandidates.entries()) {
      const { job, existing, observation, sourceContext, persisted } = candidate
      const suppressed = suppressionResults[index]
      if (suppressed) {
        stats.suppressed += 1
        if (tracingEnabled) {
          const trace = traceByDiscoveryKey.get(discoveryKey(job))
          if (trace) traceByDiscoveryKey.set(discoveryKey(job), {
            ...appendTraceEvent(trace, { stage: "persistence", decision: "suppressed", reasonCode: "SUPPRESSED", evidenceStatus: "present" }),
            physical_job_id: persisted.id,
            final_outcome: "suppressed",
          })
        }
        runAssociations.set(String(persisted.id), {
          jobId: persisted.id,
          outcome: "suppressed",
          contexts: [...(runAssociations.get(String(persisted.id))?.contexts ?? []), {
            ...sourceContext, source: job.source, source_job_id: job.sourceJobId,
            identity_observation: storageObservation(observation, sourceContext),
            eligibility_outcome: "suppressed_history",
          }],
        })
        continue
      }
      const eligibility = evaluateFinalJobEligibility(job, profile)
      if (tracingEnabled) {
        const trace = traceByDiscoveryKey.get(discoveryKey(job))
        if (trace) traceByDiscoveryKey.set(discoveryKey(job), appendTraceEvent(trace, {
          stage: "final_eligibility",
          decision: eligibility.actionable ? "passed" : "unknown",
          reasonCode: eligibility.actionable ? "ELIGIBLE_FOR_REVIEW" : "RETAINED_FOR_REVIEW",
          evidenceStatus: eligibility.metadata_unresolved ? "partial" : "present",
        }))
      }
      const preferenceStates = {
        location: eligibility.location,
        language: eligibility.language,
        employment_type: eligibility.employmentType,
        seniority: eligibility.seniority,
      }
      const mismatches = Object.entries(preferenceStates).filter(([, state]) => state === "ineligible").map(([field]) => field)
      const unclear = Object.entries(preferenceStates).filter(([, state]) => state === "unclear").map(([field]) => field)
      if (eligibility.role !== "target_match") unclear.push("role")
      if (eligibility.metadata_unresolved) unclear.push("metadata")
      const eligibilityOutcome = mismatches.length ? "preference_mismatch"
        : unclear.length ? "eligibility_unclear"
        : eligibility.actionable ? "actionable" : "verification_pending"
      if (eligibility.actionable) {
        stats.active_actionable += 1
        stats.final_actionable += 1
        if (job.descriptionKind === "full") stats.fit_ready += 1
      }
      if (mismatches.length) stats.preference_mismatches_retained += 1
      else if (unclear.length) stats.eligibility_unclear_retained += 1
      const canonicalLifecycle = persisted.availabilityStatus
        ?? (job.validation?.status === "uncertain" ? "unknown" : job.validation?.status)
        ?? text(existing?.availability_status)
      const lifecycleOutcome: AssociationOutcome = canonicalLifecycle === "expired" ? "expired"
        : canonicalLifecycle === "validation_failed" ? "validation_failed"
        : canonicalLifecycle === "active" ? (persisted.created ? "new" : "rediscovered")
        : "unknown"
      const outcome = lifecycleOutcome !== "rediscovered"
          ? lifecycleOutcome
          : persisted.created ? "new" : "rediscovered"
      const context = {
          mode: options.mode,
          discovery_method: job.raw.sourceType === "ats" ? "ats" : "portal",
          ats_provider: job.raw.sourceType === "ats" ? (job.raw.ats as Record<string, unknown> | undefined)?.provider : undefined,
          ats_board_identifier: job.raw.sourceType === "ats" ? (job.raw.ats as Record<string, unknown> | undefined)?.companyIdentifier : undefined,
          ats_requisition_id: job.raw.sourceType === "ats" ? (job.raw.ats as Record<string, unknown> | undefined)?.requisitionId : undefined,
          ats_registry_source: job.raw.sourceType === "ats" && job.raw.metadata && typeof job.raw.metadata === "object"
            ? (job.raw.metadata as Record<string, unknown>).registrySource
            : undefined,
          physical_identity_mode: stats.physical_identity_mode,
          query_terms: queries,
          query_matches: queryGroupsForMatches(acquisitionQueries(job), targetedQueries),
          source: job.source,
          source_job_id: job.sourceJobId,
          eligibility_outcome: eligibilityOutcome,
          preference_mismatch_fields: mismatches,
          eligibility_unclear_fields: unclear,
          work_model_verdict: classifyWorkModel({
            title: job.title,
            location: job.location,
            remoteScope: job.remoteScope,
            description: job.description,
            structuredWorkModel: job.raw.sourceType === "ats" ? text(job.raw.workplaceType) : null,
          }),
          role_eligibility: eligibility.role,
          location_eligibility: eligibility.location,
          language_eligibility: eligibility.language,
          employment_type_eligibility: eligibility.employmentType,
          seniority_eligibility: eligibility.seniority,
          metadata_unresolved: eligibility.metadata_unresolved,
          metadata_issues: eligibility.metadata_issues,
          identity_observation: storageObservation(observation, sourceContext),
        }
      const previousAssociation = runAssociations.get(String(persisted.id))
      if (tracingEnabled) {
        const trace = traceByDiscoveryKey.get(discoveryKey(job))
        if (trace) traceByDiscoveryKey.set(discoveryKey(job), {
          ...appendTraceEvent(trace, {
            stage: "persistence",
            decision: "persisted",
            reasonCode: persisted.created ? "CREATED" : "UPDATED",
            evidenceStatus: "present",
          }),
          physical_job_id: persisted.id,
          final_outcome: persisted.created ? "created" : "updated",
        })
      }
      runAssociations.set(String(persisted.id), {
        jobId: persisted.id,
        outcome: previousAssociation?.outcome === "suppressed" ? "suppressed" : outcome,
        contexts: [...(previousAssociation?.contexts ?? []), context],
      })
    }
    recordTiming("association_context_classification_ms", associationContextStartedAt)
    const associationStartedAt = performance.now()
    const associationInputs = [...runAssociations.values()].map((association) => {
      const allContexts = association.contexts
      return {
        runId,
        jobId: association.jobId,
        outcome: association.outcome,
        context: {
          ...consolidateRunJobObservationContexts(allContexts),
        },
      }
    })
    if (store.associateRunJobs) {
      await runStoreOperation("associating discovered jobs with search run", () => store.associateRunJobs!(associationInputs))
    } else {
      for (const association of associationInputs) {
        await runStoreOperation("associating discovered job with search run", () => store.associateRunJob(association))
      }
    }
    recordTiming("run_associations_ms", associationStartedAt)
    await flushCandidateTraces(true)
    const failedSources = allSourceResults.filter((result) => !result.detail.success).length
    const status = failedSources === 0 && stats.errors.length === 0 ? "completed" : jobs.length || stats.errors.length ? "partial" : "failed"
    timings.pipeline_pre_finalize_ms = Math.max(0, Math.round(performance.now() - pipelineStartedAt))
    const finalizeStartedAt = performance.now()
    await runStoreOperation("finish search run", () => store.finishSearchRun({ runId, status, finishedAt: new Date().toISOString(), stats, errorMessage: errors.length ? errors.map((item) => `${item.source}: ${item.message}`).join("; ") : undefined }))
    recordTiming("finish_search_run_ms", finalizeStartedAt)
    if (status !== "failed" && atsPersistenceComplete && atsResult?.history) {
      try {
        await atsResult.history.commitSuccessfulFetches(atsResult.results)
      } catch {
        // Keep retryable history if committing the successful freshness write fails.
      }
    }
    timings.pipeline_total_ms = Math.max(0, Math.round(performance.now() - pipelineStartedAt))
    const uniqueProcessedIds = [...new Map(processedJobIds.map((id) => [String(id), id])).values()]
    return { runId, profile, mode: options.mode, queries, stats, jobs: persistableJobs, sourceDetails, sourceSelection, processedJobIds: uniqueProcessedIds, processedAt: startedAt }
  }
  timings.pipeline_total_ms = Math.max(0, Math.round(performance.now() - pipelineStartedAt))
  return { runId, profile, mode: options.mode, queries, stats, jobs: persistableJobs, sourceDetails, sourceSelection, processedJobIds: [], processedAt: startedAt }
}

function jsonBody(value: unknown): BodyInit { return JSON.stringify(value) }

class SupabaseRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly databaseMessage: string | undefined,
    readonly method: string,
    readonly table: string,
    readonly constraint: string | undefined,
  ) {
    const constraintLabel = constraint ? `, constraint ${constraint}` : ""
    super(`Supabase ${method} ${table} failed (HTTP ${status}${code ? `, SQLSTATE ${code}` : ""}${constraintLabel})`)
  }
}

function safeDatabaseConstraint(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined
  return message.match(/\bconstraint\s+"([A-Za-z0-9_]+)"/i)?.[1]
}

function discoveryFailureMessage(stage: string, error: unknown): string {
  if (error instanceof SupabaseRequestError) {
    return `Discovery persistence failed during ${stage}: ${error.message}`
  }
  const kind = error instanceof Error ? error.name : "Error"
  return `Discovery persistence failed during ${stage} (${kind})`
}

async function markSearchRunFailed(store: DiscoveryStore, input: {
  runId: number | string
  stats: DiscoveryStats
  errorMessage: string
}): Promise<void> {
  try {
    await store.finishSearchRun({
      runId: input.runId,
      status: "failed",
      finishedAt: new Date().toISOString(),
      stats: input.stats,
      errorMessage: input.errorMessage,
    })
  } catch {
    // Preserve the original persistence failure; a failed status update is best effort.
  }
}

function isMissingPhase1ESchema(error: unknown): boolean {
  return error instanceof SupabaseRequestError
    && (
      error.code === "PGRST202"
      || (error.code === "42P01" && /job_source_observations|job_identity_keys/i.test(error.databaseMessage ?? ""))
    )
}

function isJobSourceUrlCollision(error: unknown): boolean {
  return error instanceof SupabaseRequestError
    && error.code === "23505"
    && error.constraint === "jobs_source_source_url_key"
}

type SuppressionRetryDependencies = {
  now: () => number
  sleep: (durationMs: number) => Promise<void>
  random: () => number
  timeoutSignal: (durationMs: number) => AbortSignal
}

function isRetryableSuppressionError(error: unknown): boolean {
  // A 500 may be a deterministic SQL/function exception; only gateway/service 5xx are retried.
  if (error instanceof SupabaseRequestError) return [502, 503, 504].includes(error.status)
  if (!(error instanceof Error)) return false
  return error instanceof TypeError || error.name === "AbortError" || error.name === "TimeoutError"
}

function safeSuppressionErrorDetails(error: unknown): { status: number | null; code: string | null } {
  if (error instanceof SupabaseRequestError) {
    return {
      status: error.status,
      code: error.code && /^[A-Za-z0-9_-]{1,32}$/.test(error.code) ? error.code : null,
    }
  }
  const cause = error instanceof Error && error.cause && typeof error.cause === "object"
    ? error.cause as { code?: unknown }
    : null
  const code = cause?.code
  return {
    status: null,
    code: typeof code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : null,
  }
}

function logSuppressionDiagnostic(input: {
  outcome: "retrying" | "transient_error_recovered" | "retries_exhausted" | "permanent_nonretryable_error"
  attempt: number
  maxAttempts: number
  error: unknown
  retryable: boolean
  retryDelayMs: number
  startedAt: number
  now: () => number
}): void {
  const { status, code } = safeSuppressionErrorDetails(input.error)
  process.stderr.write(`${JSON.stringify({
    event: "application_suppression_rpc",
    operation_name: "application_suppression_check",
    outcome: input.outcome,
    attempt_number: input.attempt,
    max_attempts: input.maxAttempts,
    safe_http_status: status,
    safe_error_code: code,
    retryable: input.retryable,
    retry_delay_ms: input.retryDelayMs,
    operation_duration_ms: Math.max(0, Math.round(input.now() - input.startedAt)),
    retries_exhausted: input.outcome === "retries_exhausted",
  })}\n`)
}

export class SupabaseDiscoveryStore implements DiscoveryStore {
  physicalIdentityMode: "canonical" | "legacy_compatibility" | "unknown" = "unknown"

  private static readonly candidateTraceWriteBudgetMs = 15_000
  private static readonly candidateTraceRequestTimeoutMs = 8_000
  private static readonly candidateTraceCleanupBudgetMs = 3_000
  private static readonly suppressionMaxAttempts = 3
  private static readonly suppressionOperationDeadlineMs = 8_000
  private static readonly suppressionAttemptTimeoutMs = 3_000
  private static readonly suppressionBackoffBaseMs = 100
  private static readonly suppressionBackoffJitterMs = 50
  private readonly suppressionRetryDependencies: SuppressionRetryDependencies

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly now: () => number = () => performance.now(),
    retryDependencies?: Partial<SuppressionRetryDependencies>,
  ) {
    this.suppressionRetryDependencies = {
      now: retryDependencies?.now ?? (() => performance.now()),
      sleep: retryDependencies?.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))),
      random: retryDependencies?.random ?? Math.random,
      timeoutSignal: retryDependencies?.timeoutSignal ?? ((durationMs) => AbortSignal.timeout(durationMs)),
    }
  }

  private async requestSuppressionRpc(path: string, body: Record<string, unknown>, allowMissingSchemaFallback = false): Promise<boolean> {
    const retry = this.suppressionRetryDependencies
    const startedAt = retry.now()
    const deadline = startedAt + SupabaseDiscoveryStore.suppressionOperationDeadlineMs
    let lastError: unknown

    for (let attempt = 1; attempt <= SupabaseDiscoveryStore.suppressionMaxAttempts; attempt += 1) {
      const remainingMs = deadline - retry.now()
      if (remainingMs <= 0) {
        const error = lastError ?? new Error("Suppression RPC operation deadline exceeded")
        logSuppressionDiagnostic({
          outcome: "retries_exhausted", attempt: attempt - 1, maxAttempts: SupabaseDiscoveryStore.suppressionMaxAttempts,
          error, retryable: true, retryDelayMs: 0, startedAt, now: retry.now,
        })
        throw error
      }

      try {
        const result = await this.request(path, {
          method: "POST",
          body: jsonBody(body),
          signal: retry.timeoutSignal(Math.min(SupabaseDiscoveryStore.suppressionAttemptTimeoutMs, remainingMs)),
        })
        if (typeof result !== "boolean") throw new Error("Suppression RPC returned a non-boolean result")
        if (attempt > 1 && lastError) {
          logSuppressionDiagnostic({
            outcome: "transient_error_recovered", attempt, maxAttempts: SupabaseDiscoveryStore.suppressionMaxAttempts,
            error: lastError, retryable: true, retryDelayMs: 0, startedAt, now: retry.now,
          })
        }
        return result
      } catch (error) {
        lastError = error
        const retryable = isRetryableSuppressionError(error)
        if (!retryable) {
          if (!(allowMissingSchemaFallback && isMissingPhase1ESchema(error))) {
            logSuppressionDiagnostic({
              outcome: "permanent_nonretryable_error", attempt, maxAttempts: SupabaseDiscoveryStore.suppressionMaxAttempts,
              error, retryable: false, retryDelayMs: 0, startedAt, now: retry.now,
            })
          }
          throw error
        }
        if (attempt === SupabaseDiscoveryStore.suppressionMaxAttempts) {
          logSuppressionDiagnostic({
            outcome: "retries_exhausted", attempt, maxAttempts: SupabaseDiscoveryStore.suppressionMaxAttempts,
            error, retryable: true, retryDelayMs: 0, startedAt, now: retry.now,
          })
          throw error
        }

        const exponentialDelay = SupabaseDiscoveryStore.suppressionBackoffBaseMs * (2 ** (attempt - 1))
        const retryDelayMs = Math.round(exponentialDelay + retry.random() * SupabaseDiscoveryStore.suppressionBackoffJitterMs)
        if (retry.now() + retryDelayMs >= deadline) {
          logSuppressionDiagnostic({
            outcome: "retries_exhausted", attempt, maxAttempts: SupabaseDiscoveryStore.suppressionMaxAttempts,
            error, retryable: true, retryDelayMs: 0, startedAt, now: retry.now,
          })
          throw error
        }
        logSuppressionDiagnostic({
          outcome: "retrying", attempt, maxAttempts: SupabaseDiscoveryStore.suppressionMaxAttempts,
          error, retryable: true, retryDelayMs, startedAt, now: retry.now,
        })
        await retry.sleep(retryDelayMs)
      }
    }
    throw lastError
  }

  async detectPhysicalIdentityMode(userId: string): Promise<"canonical" | "legacy_compatibility"> {
    try {
      const result = await this.request("/rest/v1/rpc/is_suppressed_job", {
        method: "POST",
        body: jsonBody({ p_user_id: userId, p_job_id: 0 }),
      })
      if (typeof result !== "boolean") throw new Error("Physical identity capability probe returned an unexpected value")
      this.physicalIdentityMode = "canonical"
    } catch (error) {
      if (!isMissingPhase1ESchema(error)) throw error
      this.physicalIdentityMode = "legacy_compatibility"
    }
    return this.physicalIdentityMode
  }

  private async request(path: string, init: RequestInit = {}, expectedStatuses?: number[]): Promise<any> {
    const response = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        apikey: this.secret,
        Authorization: `Bearer ${this.secret}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    })
    const body = await response.text()
    recordPostgrestResponse(init.method ?? "GET", path, response.status, body)
    if (!response.ok || (expectedStatuses && !expectedStatuses.includes(response.status))) {
      let code: string | undefined
      let databaseMessage: string | undefined
      try {
        const parsed = JSON.parse(body)
        code = parsed?.code
        databaseMessage = typeof parsed?.message === "string" ? parsed.message : undefined
      } catch { /* Keep response details private. */ }
      const method = (init.method ?? "GET").toUpperCase()
      const pathname = path.split("?", 1)[0]
      const table = pathname.includes("/rpc/")
        ? `jobs via rpc/${pathname.split("/rpc/")[1] ?? "unknown"}`
        : pathname.split("/").filter(Boolean).at(-1) ?? "unknown"
      throw new SupabaseRequestError(response.status, code, databaseMessage, method, table, safeDatabaseConstraint(databaseMessage))
    }
    return body ? JSON.parse(body) : null
  }

  async getActiveSearchProfile(userId: string): Promise<SearchProfileRecord> {
    if (!userId.trim()) throw new Error("userId is required to load a SearchProfile")
    const params = new URLSearchParams({ select: "*", is_active: "eq.true", order: "id" })
    params.set("user_id", `eq.${userId}`)
    const rows = await this.request(`/rest/v1/search_profiles?${params}`) as SearchProfileRecord[]
    if (rows.length !== 1) throw new Error(`Expected exactly one active SearchProfile; found ${rows.length}`)
    return rows[0]
  }

  async createSearchRun(input: { profile: SearchProfileRecord; mode: DiscoveryMode; startedAt: string }): Promise<number> {
    const rows = await this.request("/rest/v1/search_runs", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: jsonBody({ user_id: input.profile.user_id, search_profile_id: input.profile.id, search_profile_snapshot: input.profile, discovery_mode: input.mode, started_at: input.startedAt, status: "running", stats: {} }),
    }) as Array<{ id: number }>
    return rows[0].id
  }

  async loadJobs(): Promise<Array<Record<string, unknown>>> {
    const jobs: Array<Record<string, unknown>> = []
    const pageSize = 500
    let lastId = 0
    while (true) {
      const params = new URLSearchParams({
        select: "id,source,source_job_id,source_url,application_url,company,title,location,remote_scope,employment_type,description,description_kind,posted_at,availability_status",
        order: "id.asc",
        limit: String(pageSize),
        id: `gt.${lastId}`,
      })
      const page = await this.request(`/rest/v1/jobs?${params}`) as Array<Record<string, unknown>>
      if (!Array.isArray(page)) throw new Error("Jobs query returned an invalid page")
      for (const row of page) {
        const id = Number(row.id)
        if (!Number.isSafeInteger(id) || id <= lastId) throw new Error("Jobs query returned unordered or invalid IDs")
        jobs.push(row)
        lastId = id
      }
      if (page.length < pageSize) return jobs
    }
  }

  async loadJobsByIds(ids: number[]): Promise<Array<Record<string, unknown>>> {
    if (!ids.length || ids.length > 30 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error("Select between 1 and 30 valid job IDs")
    }
    const params = new URLSearchParams({ select: "*", id: `in.(${ids.join(",")})`, limit: String(ids.length) })
    const rows = await this.request(`/rest/v1/jobs?${params}`) as Array<Record<string, unknown>>
    if (!Array.isArray(rows)) throw new Error("Selected jobs query returned an invalid result")
    return rows
  }

  async closeAtsJobs(closedJobs: HistoricalJob[]): Promise<{ closed: number; errors: string[] }> {
    let closed = 0
    const errors: string[] = []
    for (const historical of closedJobs) {
      const provider = historical.ats?.provider
      const requisitionId = historical.ats?.requisitionId
      if (!provider || !requisitionId) continue
      const params = new URLSearchParams({
        select: "id,source_url,application_url",
        source: `eq.${provider}`,
        source_job_id: `eq.${requisitionId}`,
      })
      try {
        if (this.physicalIdentityMode === "canonical" && historical.ats?.companyIdentifier) {
          const observationParams = new URLSearchParams({
            select: "id,job_id,discovery_context",
            ats_provider: `eq.${provider}`,
            ats_board_id: `eq.${historical.ats.companyIdentifier}`,
            ats_requisition_id: `eq.${requisitionId}`,
          })
          const observations = await this.request(`/rest/v1/job_source_observations?${observationParams}`) as Array<{ id: number; job_id: number | null; discovery_context?: Record<string, unknown> }>
          for (const observation of observations) {
            await this.request(`/rest/v1/job_source_observations?id=eq.${observation.id}`, {
              method: "PATCH",
              headers: { Prefer: "return=minimal" },
              body: jsonBody({
                observed_lifecycle_status: "expired",
                discovery_context: {
                  ...(observation.discovery_context ?? {}),
                  board_absence_verified_at: historical.closedAt ?? historical.updatedAt,
                  complete_board_snapshot: true,
                },
              }),
            })
            const canonicalJobs = await this.request(`/rest/v1/jobs?select=id&canonical_lifecycle_observation_id=eq.${observation.id}`) as Array<{ id: number }>
            for (const job of canonicalJobs) {
              await this.request(`/rest/v1/jobs?id=eq.${job.id}`, {
                method: "PATCH",
                headers: { Prefer: "return=minimal" },
                body: jsonBody({ availability_status: "expired" }),
              })
              closed += 1
            }
          }
          continue
        }
        const rows = await this.request(`/rest/v1/jobs?${params}`) as Array<{ id: number; source_url?: string | null; application_url?: string | null }>
        const expectedUrls = new Set([historical.canonicalUrl, historical.applicationUrl].filter((value): value is string => Boolean(value)).map((value) => normalizeCacheUrl(value)))
        const exactRows = rows.filter((row) => [row.source_url, row.application_url]
          .some((value) => typeof value === "string" && expectedUrls.has(normalizeCacheUrl(value))))
        for (const row of exactRows) {
          await this.request(`/rest/v1/jobs?id=eq.${row.id}`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: jsonBody({ availability_status: "expired" }),
          })
          closed += 1
        }
      } catch (error) {
        errors.push(`${provider}/${requisitionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { closed, errors }
  }

  async isSuppressed(input: { userId: string; job: DiscoveredJob; jobId?: number | string }): Promise<boolean> {
    if (input.jobId !== undefined) {
      try {
        return await this.requestSuppressionRpc("/rest/v1/rpc/is_suppressed_job", {
          p_user_id: input.userId,
          p_job_id: input.jobId,
        }, true)
      } catch (error) {
        if (!isMissingPhase1ESchema(error)) throw error
        this.physicalIdentityMode = "legacy_compatibility"
      }
    }
    return this.requestSuppressionRpc("/rest/v1/rpc/is_suppressed_role", {
      p_user_id: input.userId,
      p_company: input.job.company,
      p_title: input.job.title,
      p_source: input.job.source,
      p_source_job_id: input.job.sourceJobId,
      p_source_url: input.job.sourceUrl ?? input.job.applicationUrl,
    })
  }

  async upsertJob(input: { job: DiscoveredJob; existing: Record<string, unknown> | undefined; now: string; context?: Record<string, unknown> }): Promise<{ id: number | null; created: boolean; availabilityStatus?: string; identityConflict?: boolean; physicalIdentityMode?: "canonical" | "legacy_compatibility" }> {
    const job = input.job
    const payload = mergePersistedJobPayload(job, input.existing ?? {}, input.now)
    const identityRaw: NormalizedJob = {
      ...job.raw, source: job.source, portal: job.source, sourceJobId: job.sourceJobId ?? undefined,
      sourceUrl: job.sourceUrl ?? undefined, applicationUrl: job.applicationUrl ?? undefined,
      title: job.title, company: job.company, location: job.location ?? undefined,
      remoteScope: job.remoteScope ?? undefined, employmentType: job.employmentType ?? undefined,
      description: job.description ?? undefined, validation: job.validation,
    }
    const observation = storageObservation(sourceObservationFor(identityRaw, job.source), input.context)
    try {
      const result = await this.request("/rest/v1/rpc/resolve_job_source_observation", {
        method: "POST",
        body: jsonBody({ p_observation: observation, p_job_payload: payload, p_observed_at: input.now }),
      }) as { job_id: number; created: boolean; state: string; availability_status?: string }
      this.physicalIdentityMode = "canonical"
      if (result.state === "conflict" || !result.job_id) return { id: null, created: false, identityConflict: true }
      return { id: result.job_id, created: result.created, availabilityStatus: result.availability_status, physicalIdentityMode: "canonical" }
    } catch (error) {
      if (isJobSourceUrlCollision(error)) {
        this.physicalIdentityMode = "canonical"
        return { id: null, created: false, identityConflict: true, physicalIdentityMode: "canonical" }
      }
      if (!isMissingPhase1ESchema(error)) throw error
      this.physicalIdentityMode = "legacy_compatibility"
      try {
        return { ...await this.upsertLegacyJob(payload, input.existing), physicalIdentityMode: "legacy_compatibility" }
      } catch (legacyError) {
        if (!isJobSourceUrlCollision(legacyError)) throw legacyError
        return { id: null, created: false, identityConflict: true, physicalIdentityMode: "legacy_compatibility" }
      }
    }
  }

  private async upsertLegacyJob(payload: Record<string, unknown>, existing?: Record<string, unknown>): Promise<{ id: number | null; created: boolean }> {
    if (existing?.id !== undefined && existing.id !== null) {
      const params = new URLSearchParams({ id: `eq.${existing.id}` })
      await this.request(`/rest/v1/jobs?${params}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: jsonBody(payload),
      })
      return { id: Number(existing.id), created: false }
    }
    const rows = await this.request("/rest/v1/jobs", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: jsonBody(payload),
    }) as Array<{ id: number }>
    return { id: rows[0]?.id ?? null, created: true }
  }

  async associateRunJob(input: { runId: number | string; jobId: number | string; outcome: AssociationOutcome; context: Record<string, unknown> }): Promise<void> {
    await this.request("/rest/v1/search_run_jobs", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: jsonBody({ search_run_id: input.runId, job_id: input.jobId, discovered_at: new Date().toISOString(), discovery_context: { outcome: input.outcome, ...input.context } }) })
  }

  async associateRunJobs(inputs: Array<{ runId: number | string; jobId: number | string; outcome: AssociationOutcome; context: Record<string, unknown> }>): Promise<void> {
    const chunkSize = 50
    for (let offset = 0; offset < inputs.length; offset += chunkSize) {
      const rows = inputs.slice(offset, offset + chunkSize).map((input) => ({
        search_run_id: input.runId,
        job_id: input.jobId,
        discovered_at: new Date().toISOString(),
        discovery_context: { outcome: input.outcome, ...input.context },
      }))
      await this.request("/rest/v1/search_run_jobs", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: jsonBody(rows),
      })
    }
  }

  async persistCandidateTraces(records: CandidateTraceRecord[]): Promise<CandidateTracePersistenceResult> {
    const chunkSize = 200
    const diagnostics = emptyCandidateTraceWriteStats(records.length)
    const startedAt = performance.now()
    const batches = Array.from({ length: Math.ceil(records.length / chunkSize) }, (_, index) =>
      records.slice(index * chunkSize, (index + 1) * chunkSize))
    diagnostics.batches_prepared = batches.length
    const deadline = this.now() + SupabaseDiscoveryStore.candidateTraceWriteBudgetMs
    for (const [index, batch] of batches.entries()) {
      const remainingMs = deadline - this.now()
      if (remainingMs <= 0) {
        diagnostics.write_budget_exhausted = true
        diagnostics.write_failure_kind = "budget_exhausted"
        diagnostics.records_not_attempted = records.length - diagnostics.records_persisted
        diagnostics.records_skipped_due_budget = diagnostics.records_not_attempted
        diagnostics.batches_not_attempted = batches.length - index
        break
      }
      const requestTimeoutMs = Math.min(
        SupabaseDiscoveryStore.candidateTraceRequestTimeoutMs,
        remainingMs,
      )
      diagnostics.batches_attempted += 1
      try {
        await this.request("/rest/v1/discovery_candidate_traces?on_conflict=search_run_id,candidate_identity", {
          method: "POST",
          signal: AbortSignal.timeout(requestTimeoutMs),
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: jsonBody(batch),
        }, [200, 201, 204])
        diagnostics.batches_succeeded += 1
        diagnostics.records_persisted += batch.length
      } catch (error) {
        diagnostics.batches_failed += 1
        const unattemptedRecords = records.length - diagnostics.records_persisted - batch.length
        diagnostics.records_not_attempted = unattemptedRecords
        diagnostics.records_skipped_after_failure = unattemptedRecords
        diagnostics.batches_not_attempted = batches.length - index - 1

        if (error instanceof SupabaseRequestError) {
          diagnostics.write_http_status = error.status
          if (error.code && /^[A-Za-z0-9_-]{1,16}$/.test(error.code)) diagnostics.write_error_code = error.code
          if (error.status >= 500 || (error.status >= 200 && error.status < 300)) {
            diagnostics.records_outcome_unknown = batch.length
            diagnostics.write_failure_kind = error.status >= 500 ? "http_5xx" : "http_unexpected"
          } else {
            diagnostics.records_failed_write = batch.length
            diagnostics.write_failure_kind = "http_4xx"
          }
        } else if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
          diagnostics.records_outcome_unknown = batch.length
          diagnostics.write_budget_exhausted = remainingMs <= SupabaseDiscoveryStore.candidateTraceRequestTimeoutMs
          diagnostics.write_failure_kind = diagnostics.write_budget_exhausted
            ? "budget_exhausted"
            : "request_timeout"
        } else {
          diagnostics.records_outcome_unknown = batch.length
          diagnostics.write_failure_kind = error instanceof TypeError ? "network_error" : "store_error"
        }
        break
      }
    }
    diagnostics.write_duration_ms = Math.max(0, Math.round(performance.now() - startedAt))
    return {
      persisted: diagnostics.records_persisted,
      failures: records.length - diagnostics.records_persisted,
      diagnostics,
    }
  }

  async pruneCandidateTraces(retentionDays: number, limit: number): Promise<number> {
    const deadline = Date.now() + SupabaseDiscoveryStore.candidateTraceCleanupBudgetMs
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
    const params = new URLSearchParams({ select: "id", observed_at: `lt.${cutoff}`, order: "observed_at.asc", limit: String(Math.min(5000, Math.max(1, Math.floor(limit)))) })
    const selectTimeoutMs = deadline - Date.now()
    if (selectTimeoutMs <= 0) throw new Error("Trace cleanup time budget exhausted")
    const staleRows = await this.request(`/rest/v1/discovery_candidate_traces?${params}`, {
      signal: AbortSignal.timeout(selectTimeoutMs),
    }) as Array<{ id: number }>
    const ids = staleRows.map((row) => row.id).filter((id) => Number.isSafeInteger(id) && id > 0)
    if (!ids.length) return 0
    const deleteParams = new URLSearchParams({ id: `in.(${ids.join(",")})`, observed_at: `lt.${cutoff}`, select: "id" })
    const deleteTimeoutMs = deadline - Date.now()
    if (deleteTimeoutMs <= 0) throw new Error("Trace cleanup time budget exhausted")
    const deleted = await this.request(`/rest/v1/discovery_candidate_traces?${deleteParams}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(deleteTimeoutMs),
      headers: { Prefer: "return=representation" },
    }) as Array<{ id: number }>
    return Array.isArray(deleted) ? deleted.length : 0
  }

  async finishSearchRun(input: { runId: number | string; status: "completed" | "partial" | "failed"; finishedAt: string; stats: DiscoveryStats; errorMessage?: string }): Promise<void> {
    await this.request(`/rest/v1/search_runs?id=eq.${input.runId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: jsonBody({ status: input.status, finished_at: input.finishedAt, stats: input.stats, error_message: input.errorMessage ?? null }) })
  }
}

export async function createSupabaseDiscoveryStoreFromEnv(): Promise<SupabaseDiscoveryStore> {
  const url = process.env.SUPABASE_URL?.trim()
  const secret = process.env.SUPABASE_SECRET_KEY?.trim()
  if (!url || !secret) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required")
  return new SupabaseDiscoveryStore(url, secret)
}

async function main(): Promise<void> {
  const [, , modeArg, ...flags] = process.argv
  if (modeArg !== "targeted" && modeArg !== "broad") throw new Error("usage: bun run tools/generic_discovery.ts <targeted|broad> [--dry-run] [--limit N]")
  const dryRun = flags.includes("--dry-run")
  const limitIndex = flags.indexOf("--limit")
  const limit = limitIndex >= 0 ? Number(flags[limitIndex + 1]) : undefined
  const userIdIndex = flags.indexOf("--user-id")
  const userId = userIdIndex >= 0 ? flags[userIdIndex + 1]?.trim() : process.env.AI_JOB_SEARCH_USER_ID?.trim()
  if (!userId) throw new Error("--user-id or AI_JOB_SEARCH_USER_ID is required")
  const store = await createSupabaseDiscoveryStoreFromEnv()
  const result = await runGenericDiscovery({ mode: modeArg, store, dryRun, limit, userId })
  process.stdout.write(`${JSON.stringify({ runId: result.runId, profile: result.profile.name, mode: result.mode, stage: "discovery_and_eligibility", processedAt: result.processedAt, queries: result.queries, stats: result.stats, processedJobIds: result.processedJobIds, sources: result.sourceDetails }, null, 2)}\n`)
}

if (import.meta.main) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1) })
