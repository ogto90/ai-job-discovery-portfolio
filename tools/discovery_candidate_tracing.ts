import { createHash } from "node:crypto"
import type { NormalizedJob } from "./company_registry"

export type TraceStage =
  | "acquisition"
  | "parsing"
  | "role_screen"
  | "preference_screen"
  | "verification"
  | "jd_hydration"
  | "identity"
  | "final_eligibility"
  | "persistence"

export type TraceDecision = "passed" | "rejected" | "unknown" | "failed" | "not_attempted" | "merged" | "persisted" | "suppressed" | "skipped"
export type TraceEvidenceStatus = "present" | "partial" | "missing" | "conflicting" | "not_checked"

export interface CandidateTraceEvent {
  stage: TraceStage
  decision: TraceDecision
  reasonCode: string
  evidenceStatus: TraceEvidenceStatus
}

export interface CandidateTraceRecord {
  search_run_id: number | string
  observed_at: string
  source: string
  source_query_reference: string | null
  source_job_id: string | null
  ats_provider: string | null
  ats_board_id: string | null
  ats_requisition_id: string | null
  source_url: string | null
  canonical_url: string | null
  candidate_identity: string
  original_title: string | null
  original_company: string | null
  stage: TraceStage
  decision: TraceDecision
  reason_code: string
  reason_codes: string[]
  evidence_status: TraceEvidenceStatus
  physical_job_id: number | string | null
  final_outcome: string
  metadata: Record<string, unknown>
}

const MAX_STAGE_EVENTS = 20
const MAX_TEXT = 512

function boundedText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  return normalized ? normalized.slice(0, max) : null
}

export function sanitizeTraceUrl(value: unknown): string | null {
  const raw = boundedText(value, 4096)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString().slice(0, 2048)
  } catch {
    return null
  }
}

export function sanitizeTraceReason(value: unknown): string | null {
  const raw = boundedText(value, 2048)
  if (!raw) return null
  return raw
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\beyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{8,}\b/g, "[redacted-token]")
    .replace(/https?:\/\/[^\s)\]}>,;]+/gi, (url) => sanitizeTraceUrl(url) ?? "[url]")
    .slice(0, 512)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function safeSource(raw: NormalizedJob, sourceFallback: string): string {
  return sanitizeTraceReason(raw.portal ?? raw.source ?? sourceFallback)?.slice(0, 120) ?? "unknown"
}

function realSourceId(raw: NormalizedJob): string | null {
  const ats = raw.ats && typeof raw.ats === "object" ? raw.ats as Record<string, unknown> : {}
  return sanitizeTraceReason(raw.sourceType === "ats" ? ats.requisitionId : raw.sourceJobId ?? raw.id)
}

function acquisitionQueryReference(raw: NormalizedJob): string | null {
  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata as Record<string, unknown> : {}
  const queries = Array.isArray(metadata.acquisitionQueries)
    ? metadata.acquisitionQueries.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : []
  const acquisition = metadata.acquisition && typeof metadata.acquisition === "object" ? metadata.acquisition as Record<string, unknown> : {}
  const query = typeof acquisition.query === "string" ? acquisition.query.trim() : ""
  const references = [...new Set([...queries, ...(query ? [query] : [])])].sort()
  return references.length ? sha256(references.join("\n")) : null
}

function candidateFingerprintParts(raw: NormalizedJob, sourceFallback: string): {
  source: string
  sourceJobId: string | null
  sourceUrl: string | null
  title: string | null
  company: string | null
  identity: string
} {
  const source = safeSource(raw, sourceFallback)
  const ats = raw.ats && typeof raw.ats === "object" ? raw.ats as Record<string, unknown> : {}
  const sourceUrl = sanitizeTraceUrl(raw.sourceUrl ?? raw.canonicalUrl ?? raw.url)
  const sourceJobId = realSourceId(raw)
  const boardIdentifier = raw.sourceType === "ats" ? sanitizeTraceReason(ats.companyIdentifier)?.slice(0, 200) ?? null : null
  const identityCore = sourceJobId
    ? `id:${sourceJobId}`
    : sourceUrl
      ? `url:${sourceUrl}`
      : `weak:${boundedText(raw.company, MAX_TEXT)?.toLocaleLowerCase() ?? ""}|${boundedText(raw.title, MAX_TEXT)?.toLocaleLowerCase() ?? ""}|${boundedText(raw.location, MAX_TEXT)?.toLocaleLowerCase() ?? ""}`
  const identity = `${boardIdentifier ? `board:${boardIdentifier}:` : ""}${identityCore}`
  const queryReference = acquisitionQueryReference(raw) ?? "no-query-reference"
  const provider = raw.sourceType === "ats" ? boundedText(ats.provider, 80) ?? source : source
  return {
    source,
    sourceJobId,
    sourceUrl,
    title: sanitizeTraceReason(raw.title),
    company: sanitizeTraceReason(raw.company),
    identity: `${provider}\n${identity}\n${queryReference}`,
  }
}

function sanitizedMetadata(raw: NormalizedJob): Record<string, unknown> {
  const ats = raw.ats && typeof raw.ats === "object" ? raw.ats as Record<string, unknown> : {}
  const metadata: Record<string, unknown> = {}
  if (raw.sourceType === "ats") {
    const provider = sanitizeTraceReason(ats.provider)?.slice(0, 80) ?? null
    const boardIdentifier = sanitizeTraceReason(ats.companyIdentifier)?.slice(0, 200) ?? null
    const requisitionId = sanitizeTraceReason(ats.requisitionId)
    metadata.ats = {
      ...(provider ? { provider } : {}),
      ...(boardIdentifier ? { board_identifier: boardIdentifier } : {}),
      ...(requisitionId ? { requisition_id: requisitionId } : {}),
      ...(raw.metadata && typeof raw.metadata === "object" && typeof (raw.metadata as Record<string, unknown>).atsSnapshotComplete === "boolean"
        ? { snapshot_complete: (raw.metadata as Record<string, unknown>).atsSnapshotComplete }
        : {}),
      ...(raw.metadata && typeof raw.metadata === "object" && typeof (raw.metadata as Record<string, unknown>).atsBoardStatus === "string"
        ? { board_status: boundedText((raw.metadata as Record<string, unknown>).atsBoardStatus, 40) }
        : {}),
    }
  }
  const queryReference = acquisitionQueryReference(raw)
  if (queryReference) metadata.query_fingerprint = queryReference
  const sourcePage = raw.metadata && typeof raw.metadata === "object" ? (raw.metadata as Record<string, unknown>).acquisition : undefined
  if (sourcePage && typeof sourcePage === "object") {
    const page = (sourcePage as Record<string, unknown>).page
    if (typeof page === "number" && Number.isSafeInteger(page) && page > 0) metadata.page = page
  }
  return metadata
}

export function createCandidateTrace(
  raw: NormalizedJob,
  sourceFallback: string,
  runId: number | string,
  observedAt = new Date().toISOString(),
  extraMetadata: Record<string, unknown> = {},
): CandidateTraceRecord {
  const parts = candidateFingerprintParts(raw, sourceFallback)
  const canonicalUrl = sanitizeTraceUrl(raw.canonicalUrl ?? raw.url ?? raw.applicationUrl)
  const metadata = { ...sanitizedMetadata(raw), ...extraMetadata }
  const atsRaw = raw.ats && typeof raw.ats === "object" ? raw.ats as Record<string, unknown> : {}
  const atsProvider = raw.sourceType === "ats" ? sanitizeTraceReason(atsRaw.provider)?.slice(0, 40) ?? null : null
  const atsBoardId = raw.sourceType === "ats" ? sanitizeTraceReason(atsRaw.companyIdentifier)?.slice(0, 200) ?? null : null
  const atsRequisitionId = raw.sourceType === "ats" ? sanitizeTraceReason(atsRaw.requisitionId) : null
  if (raw.sourceType === "ats") {
    const ats = metadata.ats && typeof metadata.ats === "object" ? metadata.ats as Record<string, unknown> : {}
    metadata.ats = {
      ...ats,
      ...(typeof extraMetadata.ats_snapshot_complete === "boolean" ? { snapshot_complete: extraMetadata.ats_snapshot_complete } : {}),
      ...(typeof extraMetadata.ats_board_status === "string" ? { board_status: boundedText(extraMetadata.ats_board_status, 40) } : {}),
      ...(Number.isSafeInteger(extraMetadata.ats_http_status) ? { http_status: extraMetadata.ats_http_status } : {}),
    }
    delete metadata.ats_snapshot_complete
    delete metadata.ats_board_status
    delete metadata.ats_http_status
  }
  return {
    search_run_id: runId,
    observed_at: observedAt,
    source: parts.source,
    source_query_reference: acquisitionQueryReference(raw),
    source_job_id: parts.sourceJobId,
    ats_provider: atsProvider,
    ats_board_id: atsBoardId,
    ats_requisition_id: atsRequisitionId,
    source_url: parts.sourceUrl,
    canonical_url: canonicalUrl,
    candidate_identity: sha256(parts.identity),
    original_title: parts.title,
    original_company: parts.company,
    stage: "parsing",
    decision: "unknown",
    reason_code: "SOURCE_OBSERVED",
    reason_codes: ["SOURCE_OBSERVED"],
    evidence_status: "partial",
    physical_job_id: null,
    final_outcome: "processing",
    metadata: { ...metadata, stage_history: [] },
  }
}

export function appendTraceEvent(record: CandidateTraceRecord, event: CandidateTraceEvent): CandidateTraceRecord {
  const current = Array.isArray(record.metadata.stage_history) ? record.metadata.stage_history as CandidateTraceEvent[] : []
  const stageHistory = [...current, event].slice(-MAX_STAGE_EVENTS)
  return {
    ...record,
    stage: event.stage,
    decision: event.decision,
    reason_code: event.reasonCode,
    reason_codes: [...new Set([...record.reason_codes, event.reasonCode])],
    evidence_status: event.evidenceStatus,
    metadata: { ...record.metadata, stage_history: stageHistory },
  }
}

export function capCandidateTraces(records: CandidateTraceRecord[], limit: number): { records: CandidateTraceRecord[]; omitted: number } {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 5000
  if (records.length <= safeLimit) return { records, omitted: 0 }
  const priority = (record: CandidateTraceRecord): number => {
    const history = Array.isArray(record.metadata.stage_history) ? record.metadata.stage_history as CandidateTraceEvent[] : []
    if (["rejected", "failed", "skipped"].includes(record.decision)
      || history.some((event) => ["rejected", "failed", "skipped"].includes(event.decision))) return 0
    const initialPriority = record.metadata.trace_selection_priority
    if (initialPriority === 0 || initialPriority === 1 || initialPriority === 2) return initialPriority
    if (["unknown", "not_attempted"].includes(record.decision)) return 1
    return 2
  }
  const selected = records.map((record, index) => ({ record, index }))
    .sort((left, right) => priority(left.record) - priority(right.record) || left.index - right.index)
    .slice(0, safeLimit)
    .sort((left, right) => left.index - right.index)
    .map(({ record }) => record)
  return { records: selected, omitted: records.length - selected.length }
}

export function traceRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AI_JOB_SEARCH_TRACE_RETENTION_DAYS ?? "30")
  return Number.isFinite(raw) && raw >= 1 && raw <= 365 ? Math.floor(raw) : 30
}

export function traceCleanupBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AI_JOB_SEARCH_TRACE_CLEANUP_BATCH ?? "5000")
  return Number.isFinite(raw) && raw >= 1 && raw <= 5000 ? Math.floor(raw) : 5000
}

export function traceCandidateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AI_JOB_SEARCH_TRACE_MAX_CANDIDATES ?? "5000")
  return Number.isFinite(raw) && raw >= 1 && raw <= 50000 ? Math.floor(raw) : 5000
}

export function candidateTracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_JOB_SEARCH_TRACING_ENABLED?.trim().toLowerCase() === "true"
}

export function traceSummary(records: CandidateTraceRecord[]): Record<string, unknown> {
  const count = (predicate: (record: CandidateTraceRecord) => boolean) => records.filter(predicate).length
  const bySource: Record<string, number> = {}
  const byReason: Record<string, number> = {}
  const byAtsProvider: Record<string, number> = {}
  const byAtsBoard: Record<string, number> = {}
  const reasonSet = (record: CandidateTraceRecord) => new Set([
    record.reason_code,
    ...(Array.isArray(record.metadata.stage_history)
      ? (record.metadata.stage_history as CandidateTraceEvent[]).map((event) => event.reasonCode)
      : []),
  ])
  for (const record of records) {
    bySource[record.source] = (bySource[record.source] ?? 0) + 1
    for (const reasonCode of reasonSet(record)) byReason[reasonCode] = (byReason[reasonCode] ?? 0) + 1
    if (record.ats_provider) byAtsProvider[record.ats_provider] = (byAtsProvider[record.ats_provider] ?? 0) + 1
    if (record.ats_board_id) byAtsBoard[record.ats_board_id] = (byAtsBoard[record.ats_board_id] ?? 0) + 1
  }
  const hasReason = (record: CandidateTraceRecord, reason: string) => reasonSet(record).has(reason)
  return {
    source_observations: records.length,
    unique_source_candidates: new Set(records.map((record) => record.candidate_identity)).size,
    unique_physical_jobs: new Set(records.filter((record) => record.physical_job_id !== null).map((record) => String(record.physical_job_id))).size,
    persisted_source_observations: count((record) => record.physical_job_id !== null),
    rejected: count((record) => record.decision === "rejected"),
    unknown: count((record) => record.decision === "unknown"),
    failed: count((record) => record.decision === "failed"),
    rejected_before_verification: count((record) =>
      (Array.isArray(record.metadata.stage_history) ? record.metadata.stage_history as CandidateTraceEvent[] : [])
        .some((event) => ["role_screen", "preference_screen"].includes(event.stage) && event.decision === "rejected")),
    verified_active: count((record) => hasReason(record, "LISTING_ACTIVE")),
    full_job_description: count((record) => hasReason(record, "JD_AVAILABLE")),
    created_physical_jobs: new Set(records.filter((record) => record.final_outcome === "created" && record.physical_job_id !== null).map((record) => String(record.physical_job_id))).size,
    updated_physical_jobs: new Set(records.filter((record) => record.final_outcome === "updated" && record.physical_job_id !== null).map((record) => String(record.physical_job_id))).size,
    suppressed: count((record) => record.final_outcome === "suppressed"),
    identity_conflicts: count((record) => record.final_outcome === "identity_conflict"),
    by_source: bySource,
    by_ats_provider: byAtsProvider,
    by_ats_board: byAtsBoard,
    by_reason: byReason,
  }
}
