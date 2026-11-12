import { createHash } from "node:crypto"
import { normalizeCacheUrl, type NormalizedJob } from "./job_availability_validator"
import { classifyJobDescription } from "./job_description_quality"

export type IdentityLevel = 1 | 2 | 3
export type SourceAuthority = "unknown" | "search_inference" | "generic_portal" | "trusted_aggregator" | "employer_careers" | "verified_ats"

export interface JobIdentityKey {
  key: string
  level: IdentityLevel
  basis: "ats_requisition" | "employer_url" | "employer_reference"
}

export interface JobSourceObservation {
  source: string
  observationKey: string
  sourceJobId: string | null
  sourceUrl: string | null
  normalizedSourceUrl: string | null
  applicationUrl: string | null
  normalizedApplicationUrl: string | null
  atsProvider: string | null
  atsBoardId: string | null
  atsRequisitionId: string | null
  company: string
  title: string
  location: string | null
  workModel: string | null
  employmentType: string | null
  salaryMetadata: Record<string, unknown>
  descriptionKind: "full" | "snippet" | "missing"
  authority: SourceAuthority
  authorityRank: number
  availabilityStatus: string
  identityKeys: JobIdentityKey[]
}

export interface ExistingJobIdentityObservation {
  jobId: number | string
  source: string
  sourceJobId?: string | null
  normalizedSourceUrl?: string | null
  normalizedApplicationUrl?: string | null
  atsProvider?: string | null
  atsBoardId?: string | null
  atsRequisitionId?: string | null
  identityKeys?: JobIdentityKey[]
}

export interface IdentityResolution {
  state: "matched" | "new" | "conflict"
  jobId?: number | string
  matchedBy?: string
  conflictingJobIds: Array<number | string>
  possibleDuplicateJobIds: Array<number | string>
}

const AUTHORITY_RANK: Record<SourceAuthority, number> = {
  unknown: 0,
  search_inference: 1,
  generic_portal: 2,
  trusted_aggregator: 3,
  employer_careers: 4,
  verified_ats: 5,
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function normalized(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

function normalizedUrl(value: string | null): string | null {
  if (!value) return null
  try {
    return normalizeCacheUrl(value)
  } catch {
    return null
  }
}

function providerLabel(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "")
}

function atsIdentityFromUrl(value: string | null): { provider: string; boardId: string; requisitionId: string } | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const host = url.hostname.toLocaleLowerCase()
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  let provider: string | null = null
  let boardId: string | null = null
  let requisitionId: string | null = null

  if (["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(host) && parts.length >= 3 && parts[1] === "jobs") {
    provider = "greenhouse"; boardId = parts[0]; requisitionId = parts[2]
  } else if (host === "jobs.lever.co" && parts.length >= 2) {
    provider = "lever"; boardId = parts[0]; requisitionId = parts[1]
  } else if (host === "jobs.ashbyhq.com" && parts.length >= 2) {
    provider = "ashby"; boardId = parts[0]; requisitionId = parts[1]
  } else if (host === "careers.smartrecruiters.com" && parts.length >= 3 && parts[1] === "job") {
    provider = "smartrecruiters"; boardId = parts[0]; requisitionId = parts[2]
  } else if (host.endsWith(".teamtailor.com") && parts.length >= 2 && parts[0] === "jobs") {
    provider = "teamtailor"; boardId = host.slice(0, -".teamtailor.com".length); requisitionId = parts[1].replace(/-[a-f0-9]{8,}$/i, "")
  }
  if (!provider || !boardId || !requisitionId) return null
  return { provider, boardId: normalized(boardId).replace(/ /g, "-"), requisitionId: requisitionId.toLocaleLowerCase() }
}

function structuredAtsIdentity(job: NormalizedJob): { provider: string; boardId: string; requisitionId: string } | null {
  const ats = job.ats && typeof job.ats === "object" ? job.ats as Record<string, unknown> : {}
  const provider = text(ats.provider)
  const boardId = text(ats.companyIdentifier ?? ats.boardId ?? ats.board_id)
  const requisitionId = text(ats.requisitionId ?? ats.requisition_id ?? ats.jobId)
  return provider && boardId && requisitionId
    ? { provider: providerLabel(provider), boardId: normalized(boardId).replace(/ /g, "-"), requisitionId: requisitionId.toLocaleLowerCase() }
    : null
}

export function authorityForJob(job: NormalizedJob): SourceAuthority {
  if (job.sourceType === "ats") return "verified_ats"
  if (job.sourceType === "employer_careers") return "employer_careers"
  if (job.sourceType === "aggregator") return "trusted_aggregator"
  if (job.sourceType) return "generic_portal"
  return "unknown"
}

export function sourceObservationFor(job: NormalizedJob, sourceFallback = "unknown"): JobSourceObservation {
  const source = text(job.portal ?? job.source) ?? sourceFallback
  const sourceJobId = text(job.sourceJobId) ?? (job.id === undefined || job.id === null ? null : String(job.id))
  const sourceUrl = text(job.sourceUrl ?? job.url ?? job.canonicalUrl)
  const applicationUrl = text(job.applicationUrl ?? job.applyUrl)
  const structuredAts = job.sourceType === "ats" ? structuredAtsIdentity(job) : null
  const parsedAts = atsIdentityFromUrl(applicationUrl) ?? atsIdentityFromUrl(text(job.canonicalUrl)) ?? atsIdentityFromUrl(sourceUrl)
  const ats = structuredAts ?? parsedAts
  const keys: JobIdentityKey[] = []
  if (ats) {
    keys.push({ key: "ats:" + ats.provider + ":" + ats.boardId + ":" + ats.requisitionId, level: 1, basis: "ats_requisition" })
  }
  const metadata = job.metadata && typeof job.metadata === "object" ? job.metadata as Record<string, unknown> : {}
  const directEmployerUrl = job.sourceType === "employer_careers"
  const exactJobUrl = directEmployerUrl
    ? text(job.canonicalUrl ?? job.sourceUrl ?? job.url)
    : job.sourceType === "ats" ? text(job.canonicalUrl ?? job.sourceUrl ?? applicationUrl) : null
  if (directEmployerUrl && exactJobUrl) {
    keys.push({ key: "url:" + (normalizedUrl(exactJobUrl) ?? exactJobUrl), level: 2, basis: "employer_url" })
  }
  const employer = job.employer && typeof job.employer === "object" ? job.employer as Record<string, unknown> : {}
  const trustedEmployerSource = job.sourceType === "employer_careers" || job.sourceType === "ats"
  const employerId = trustedEmployerSource ? text(job.employerId ?? employer.id ?? metadata.employerId) : null
  const employerReference = trustedEmployerSource ? text(job.employerRequisitionId ?? job.requisitionReference ?? metadata.employerRequisitionId) : null
  if (employerId && employerReference) {
    keys.push({ key: "employer-ref:" + normalized(employerId) + ":" + normalized(employerReference), level: 3, basis: "employer_reference" })
  }
  const authority = authorityForJob(job)
  const lifecycle = job.validation?.status === "expired" ? "expired"
    : job.validation?.status === "active" ? "active"
    : job.validation?.status === "validation_failed" ? "validation_failed"
    : "unknown"
  const salaryMetadata: Record<string, unknown> = {}
  for (const key of ["salary", "salaryRange", "salaryMin", "salaryMax", "salaryCurrency", "salaryPeriod"]) {
    const value = job[key]
    if (value !== undefined && value !== null && value !== "") salaryMetadata[key] = value
  }
  const sourceIdentity = sourceJobId
    ? "id:" + sourceJobId + (ats ? ":" + ats.provider + ":" + ats.boardId + ":" + ats.requisitionId : "")
    : normalizedUrl(sourceUrl) ? "url:" + normalizedUrl(sourceUrl)
    : "weak:" + createHash("sha256").update(normalized(job.company) + "|" + normalized(job.title) + "|" + normalized(job.location)).digest("hex")

  return {
    source, observationKey: sourceIdentity, sourceJobId, sourceUrl,
    normalizedSourceUrl: normalizedUrl(sourceUrl), applicationUrl,
    normalizedApplicationUrl: normalizedUrl(applicationUrl),
    atsProvider: ats?.provider ?? null, atsBoardId: ats?.boardId ?? null, atsRequisitionId: ats?.requisitionId ?? null,
    company: text(job.company) ?? "Unknown company", title: text(job.title) ?? "Untitled role",
    location: text(job.location), workModel: text(job.workplaceType ?? job.remoteScope ?? job.remote),
    employmentType: text(job.employmentType ?? job.jobType ?? job.commitment),
    descriptionKind: classifyJobDescription(text(job.description)),
    salaryMetadata,
    authority, authorityRank: AUTHORITY_RANK[authority], availabilityStatus: lifecycle,
    identityKeys: keys.sort((a, b) => a.level - b.level),
  }
}

function uniqueIds(ids: Array<number | string>): Array<number | string> {
  return [...new Map(ids.map((id) => [String(id), id])).values()]
}

export function resolvePhysicalJobIdentity(
  incoming: JobSourceObservation,
  observations: ExistingJobIdentityObservation[],
  weakCandidates: ExistingJobIdentityObservation[] = [],
): IdentityResolution {
  const matches: Array<{ jobId: number | string; basis: string }> = []
  const identityKeySet = new Set(incoming.identityKeys.map((item) => item.key))
  for (const stored of observations) {
    const sharedStrongKey = (stored.identityKeys ?? []).find((item) => identityKeySet.has(item.key))
    if (sharedStrongKey) matches.push({ jobId: stored.jobId, basis: sharedStrongKey.key })
    const sameExactRequisitionUrl = incoming.normalizedApplicationUrl
      && incoming.normalizedApplicationUrl === stored.normalizedApplicationUrl
    const conflictingAts = incoming.atsProvider && stored.atsProvider
      && (incoming.atsProvider !== stored.atsProvider || incoming.atsBoardId !== stored.atsBoardId || incoming.atsRequisitionId !== stored.atsRequisitionId)
    if (sameExactRequisitionUrl && conflictingAts) {
      return { state: "conflict", conflictingJobIds: uniqueIds([stored.jobId]), possibleDuplicateJobIds: [] }
    }
  }
  const sameSourceId = incoming.sourceJobId
    ? observations.filter((item) => item.source === incoming.source && item.sourceJobId === incoming.sourceJobId)
    : []
  for (const stored of sameSourceId) {
    const conflictingAts = incoming.atsProvider && stored.atsProvider
      && (incoming.atsProvider !== stored.atsProvider || incoming.atsBoardId !== stored.atsBoardId || incoming.atsRequisitionId !== stored.atsRequisitionId)
    if (conflictingAts) return { state: "conflict", conflictingJobIds: uniqueIds([stored.jobId]), possibleDuplicateJobIds: [] }
    matches.push({ jobId: stored.jobId, basis: "source:" + incoming.source + ":" + incoming.sourceJobId })
  }
  if (!incoming.sourceJobId && incoming.normalizedSourceUrl) {
    for (const stored of observations) {
      if (stored.source !== incoming.source || stored.normalizedSourceUrl !== incoming.normalizedSourceUrl) continue
      const conflictingAts = incoming.atsProvider && stored.atsProvider
        && (incoming.atsProvider !== stored.atsProvider || incoming.atsBoardId !== stored.atsBoardId || incoming.atsRequisitionId !== stored.atsRequisitionId)
      if (conflictingAts) return { state: "conflict", conflictingJobIds: uniqueIds([stored.jobId]), possibleDuplicateJobIds: [] }
      matches.push({ jobId: stored.jobId, basis: "source-url:" + incoming.source })
    }
  }

  const jobIds = uniqueIds(matches.map((item) => item.jobId))
  if (jobIds.length > 1) return { state: "conflict", conflictingJobIds: jobIds, possibleDuplicateJobIds: [] }
  const possibleDuplicateJobIds = uniqueIds(weakCandidates
    .filter((item) => normalized(item.source) !== normalized(incoming.source)
      && (item.identityKeys ?? []).every((key) => !identityKeySet.has(key.key))
      && item.sourceJobId !== incoming.sourceJobId)
    .map((item) => item.jobId))
  if (jobIds.length === 1) {
    const matched = matches.sort((a, b) => a.basis.localeCompare(b.basis))[0]
    return { state: "matched", jobId: jobIds[0], matchedBy: matched?.basis, conflictingJobIds: [], possibleDuplicateJobIds }
  }
  return { state: "new", conflictingJobIds: [], possibleDuplicateJobIds }
}

export function preferObservationForCanonicalFacts(currentRank: number, incoming: JobSourceObservation): boolean {
  return incoming.authorityRank > currentRank
}

export function storageObservation(observation: JobSourceObservation, context: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: observation.source,
    observation_key: observation.observationKey,
    source_job_id: observation.sourceJobId,
    source_url: observation.sourceUrl,
    normalized_source_url: observation.normalizedSourceUrl,
    application_url: observation.applicationUrl,
    normalized_application_url: observation.normalizedApplicationUrl,
    ats_provider: observation.atsProvider,
    ats_board_id: observation.atsBoardId,
    ats_requisition_id: observation.atsRequisitionId,
    observed_company: observation.company,
    observed_title: observation.title,
    observed_location: observation.location,
    work_model_metadata: observation.workModel ? { value: observation.workModel } : {},
    employment_type: observation.employmentType,
    salary_metadata: observation.salaryMetadata,
    description_kind: observation.descriptionKind,
    source_authority: observation.authorityRank,
    authority_label: observation.authority,
    observed_lifecycle_status: observation.availabilityStatus,
    identity_keys: observation.identityKeys,
    discovery_context: context,
  }
}
