import {
  DEFAULT_REGISTRY_PATH,
  JsonCompanyRegistry,
  nowIso,
  type AtsProvider,
  type CompanyRecord,
  type NormalizedJob,
} from "./company_registry"
import { providerApiUrl, providerBoardUrl } from "./ats_detector"
import { loadAtsCompanyRegistry, providerRegion, type AtsBoardRegistrySource } from "./ats_board_registry"
import { normalizeCacheUrl, type AvailabilityValidation } from "./job_availability_validator"
import { readBoundedText, safeFetch, safeRedirectUrl, type SafeHttpResponse } from "./safe_http"
import { DEFAULT_JOB_HISTORY_PATH, JsonJobHistoryStore, normalizeJobDescription, type HistoricalJob, type UpsertHistoryStats } from "./job_history"

interface FetchResponse {
  status: number
  headers: Headers
  body?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
  cancel?: () => void
}

export interface AtsFetchOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<FetchResponse>
  resolveHost?: (hostname: string) => Promise<string[]>
  now?: Date
  maxBodyBytes?: number
}

export interface AtsFetchResult {
  companyId: string
  provider: AtsProvider
  identifier: string
  fetchedAt: string
  jobs: NormalizedJob[]
  allJobs: NormalizedJob[]
  success: boolean
  boardStatus: "success" | "empty" | "partial" | "rate_limited" | "failed" | "invalid_mapping"
  snapshotComplete: boolean
  error?: string
  httpStatus?: number
  retryable?: boolean
  closedJobs?: HistoricalJob[]
}

export interface AtsIngestionStats {
  verifiedCompanies: number
  boardsConsidered: number
  boardsCrawled: number
  boardsSkippedFresh: number
  boardsDeferredBudget: number
  companiesAttempted: number
  successfulBoards: number
  failedBoards: number
  rateLimitedBoards: number
  partialBoards: number
  emptyBoards: number
  invalidMappings: number
  totalJobsFetched: number
  jobsNormalized: number
  historicalJobsCreated: number
  historicalJobsUpdated: number
  historicalJobsClosed: number
  historicalJobsReappeared: number
  duplicatesDetected: number
  potentialReposts: number
  providerDistribution: Record<string, number>
  errors: Array<{ companyId: string; company: string; provider?: string | null; error: string }>
  rotationSlot?: number | null
  selectedBoardIds?: string[]
}

export interface AtsIngestionOptions extends AtsFetchOptions {
  registryPath?: string
  registrySource?: AtsBoardRegistrySource
  registryMinVerifiedBoards?: number
  rotationSlot?: number
  historyPath?: string
  company?: string
  provider?: AtsProvider
  limit?: number
  concurrency?: number
  boardBudget?: number
  successTtlMs?: number
  failureRetryMs?: number
  deferSuccessfulFreshness?: boolean
  dryRun?: boolean
  noHistory?: boolean
}

const USER_AGENT = "ai-job-search-ats-job-ingestor/1.0 (+https://github.com/MadsLorentzen/ai-job-search)"
const DEFAULT_MAX_BODY_BYTES = 2_000_000

function activeValidation(now: string, provider: AtsProvider, apiUrl: string): AvailabilityValidation {
  return {
    status: "active",
    method: "ats_api",
    confidence: 100,
    checkedAt: now,
    reason: `${provider} board API confirms posting is currently published`,
    finalUrl: apiUrl,
  }
}

async function fetchText(urlRaw: string, options: Required<Pick<AtsFetchOptions, "maxBodyBytes">> & Pick<AtsFetchOptions, "fetchImpl" | "resolveHost">): Promise<{ status: number; body: string; finalUrl: string; headers: Headers }> {
  let current = urlRaw
  for (let i = 0; i < 5; i++) {
    const response = await safeFetch(current, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json,application/xml,text/xml,text/html;q=0.8,*/*;q=0.5" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    }, options.resolveHost, options.fetchImpl as ((url: string, init: RequestInit) => Promise<SafeHttpResponse>) | undefined) as FetchResponse
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      if (!location) {
        response.cancel?.()
        return { status: response.status, body: "", finalUrl: current, headers: response.headers }
      }
      const next = safeRedirectUrl(current, location).toString()
      response.cancel?.()
      current = next
      continue
    }
    return { status: response.status, body: await readBoundedText(response, options.maxBodyBytes), finalUrl: current, headers: response.headers }
  }
  throw new Error("too many redirects")
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

async function fetchJson(url: string, options: AtsFetchOptions): Promise<{ status: number; parsed: unknown; body: string }> {
  let last: { status: number; parsed: unknown; body: string } | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchText(url, { fetchImpl: options.fetchImpl, resolveHost: options.resolveHost, maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES })
    try {
      last = { status: response.status, parsed: JSON.parse(response.body), body: response.body }
    } catch {
      last = { status: response.status, parsed: null, body: response.body }
    }
    if (retryableStatus(response.status) && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      continue
    }
    return last
  }
  return last ?? { status: 0, parsed: null, body: "" }
}

async function fetchXml(url: string, options: AtsFetchOptions): Promise<{ status: number; body: string }> {
  const response = await fetchText(url, { fetchImpl: options.fetchImpl, resolveHost: options.resolveHost, maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES })
  return { status: response.status, body: response.body }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function locationName(value: unknown): string | null {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    return stringValue(obj.name) ?? stringValue(obj.city) ?? stringValue(obj.location)
  }
  return null
}

function makeJob(input: {
  company: CompanyRecord
  provider: AtsProvider
  identifier: string
  requisitionId: string
  title: string
  location?: string | null
  date?: string | null
  updatedAt?: string | null
  url?: string | null
  applicationUrl?: string | null
  description?: string | null
  department?: string | null
  team?: string | null
  employmentType?: string | null
  workplaceType?: string | null
  salary?: Record<string, unknown> | null
  locationRestrictions?: string[]
  timezoneRestrictions?: string[]
  metadata?: Record<string, unknown>
  now: string
  apiUrl: string
}): NormalizedJob {
  const canonicalUrl = input.url ?? providerBoardUrl(input.provider, input.identifier)
  const descriptionText = normalizeJobDescription(input.description)
  return {
    id: input.requisitionId,
    title: input.title,
    company: input.company.canonicalName,
    location: input.location ?? null,
    date: input.date ?? null,
    deadline: null,
    url: canonicalUrl,
    source: input.provider,
    sourceType: "ats",
    companyId: input.company.id,
    ats: {
      provider: input.provider,
      companyIdentifier: input.identifier,
      requisitionId: input.requisitionId,
    },
    applicationUrl: input.applicationUrl ?? canonicalUrl,
    canonicalUrl,
    description: input.description ?? null,
    department: input.department ?? null,
    team: input.team ?? null,
    employmentType: input.employmentType ?? null,
    workplaceType: input.workplaceType ?? null,
    salary: input.salary ?? undefined,
    locationRestrictions: input.locationRestrictions ?? undefined,
    timezoneRestrictions: input.timezoneRestrictions ?? undefined,
    postedAt: input.date ?? null,
    updatedAt: input.updatedAt ?? null,
    validation: activeValidation(input.now, input.provider, input.apiUrl),
    metadata: {
      ...(input.metadata ?? {}),
      descriptionText,
      registrySource: input.company.ats.discoveredFrom,
      atsBoardIdentifier: input.identifier,
    },
  }
}

function atsKeyFromUrl(urlRaw: unknown): string | null {
  if (typeof urlRaw !== "string" || !urlRaw.trim()) return null
  try {
    const url = new URL(urlRaw)
    const host = url.hostname.toLowerCase()
    const parts = url.pathname.split("/").filter(Boolean)
    if ((host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") && parts[0] && parts[2]) return `greenhouse:${parts[0]}:${parts[2]}`
    if (host === "jobs.lever.co" && parts[0] && parts[1]) return `lever:${parts[0]}:${parts[1]}`
    if (host === "jobs.ashbyhq.com" && parts[0] && parts[1]) return `ashby:${parts[0]}:${parts[1]}`
    if (host === "careers.smartrecruiters.com" && parts[0] && parts[1]) return `smartrecruiters:${parts[0]}:${parts[1]}`
  } catch {
    return null
  }
  return null
}

export function atsKeyFromJob(job: NormalizedJob): string | null {
  const ats = job.ats && typeof job.ats === "object" ? job.ats as Record<string, unknown> : {}
  if (typeof ats.provider === "string" && typeof ats.companyIdentifier === "string" && typeof ats.requisitionId === "string") {
    return `${ats.provider}:${ats.companyIdentifier}:${ats.requisitionId}`
  }
  return atsKeyFromUrl(job.applicationUrl) ?? atsKeyFromUrl(job.canonicalUrl) ?? atsKeyFromUrl(job.url)
}

export function dedupePreferDirectAts(jobs: NormalizedJob[]): NormalizedJob[] {
  const byKey = new Map<string, NormalizedJob>()
  const passthrough: NormalizedJob[] = []
  for (const job of jobs) {
    const key = atsKeyFromJob(job) ?? (typeof (job.applicationUrl ?? job.canonicalUrl ?? job.url) === "string" ? `url:${normalizeCacheUrl(String(job.applicationUrl ?? job.canonicalUrl ?? job.url))}` : null)
    if (!key) {
      passthrough.push(job)
      continue
    }
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...job, metadata: { ...(typeof job.metadata === "object" && job.metadata ? job.metadata as Record<string, unknown> : {}), seenVia: [job.source ?? "unknown"] } })
      continue
    }
    const existingDirect = existing.sourceType === "ats"
    const incomingDirect = job.sourceType === "ats"
    const winner = incomingDirect && !existingDirect ? job : existing
    const loser = winner === job ? existing : job
    const seenVia = new Set<string>([
      ...((typeof existing.metadata === "object" && existing.metadata && Array.isArray((existing.metadata as Record<string, unknown>).seenVia)) ? (existing.metadata as Record<string, unknown>).seenVia as string[] : []),
      String(existing.source ?? "unknown"),
      String(job.source ?? "unknown"),
    ])
    byKey.set(key, {
      ...winner,
      metadata: {
        ...(typeof winner.metadata === "object" && winner.metadata ? winner.metadata as Record<string, unknown> : {}),
        duplicateOf: loser.sourceType === "ats" ? loser.url ?? loser.id ?? null : undefined,
        seenVia: [...seenVia],
      },
    })
  }
  return [...byKey.values(), ...passthrough]
}

function companyIdentifier(company: CompanyRecord): string {
  if (!company.ats.provider || !company.ats.identifier) throw new Error(`Company ${company.canonicalName} has no verified ATS identifier`)
  return company.ats.identifier
}

function greenhouseJobs(company: CompanyRecord, parsed: unknown, now: string, apiUrl: string): NormalizedJob[] {
  const identifier = companyIdentifier(company)
  const obj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  const rows = Array.isArray(obj.jobs) ? obj.jobs : []
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return []
    const job = row as Record<string, unknown>
    const id = stringValue(job.id) ?? (typeof job.id === "number" ? String(job.id) : null)
    const title = stringValue(job.title)
    if (!id || !title) return []
    const offices = Array.isArray(job.offices) ? job.offices.map(locationName).filter(Boolean) : []
    const location = locationName(job.location) ?? (offices.join(", ") || null)
    const departments = Array.isArray(job.departments) ? job.departments.map(locationName).filter(Boolean) : []
    return [makeJob({
      company,
      provider: "greenhouse",
      identifier,
      requisitionId: id,
      title,
      location,
      date: stringValue(job.updated_at) ?? stringValue(job.created_at),
      updatedAt: stringValue(job.updated_at),
      url: stringValue(job.absolute_url),
      applicationUrl: stringValue(job.absolute_url),
      description: stringValue(job.content),
      department: departments[0] ?? null,
      metadata: { rawProvider: "greenhouse" },
      now,
      apiUrl,
    })]
  })
}

function leverJobs(company: CompanyRecord, parsed: unknown, now: string, apiUrl: string): NormalizedJob[] {
  const identifier = companyIdentifier(company)
  const rows = Array.isArray(parsed) ? parsed : []
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return []
    const job = row as Record<string, unknown>
    const id = stringValue(job.id)
    const title = stringValue(job.text)
    if (!id || !title) return []
    const categories = job.categories && typeof job.categories === "object" ? job.categories as Record<string, unknown> : {}
    const salary = job.salaryRange && typeof job.salaryRange === "object" ? job.salaryRange as Record<string, unknown> : null
    const description = stringValue(job.descriptionPlain) ?? stringValue(job.description)
      ?? [stringValue(job.openingPlain) ?? stringValue(job.opening), stringValue(job.descriptionBodyPlain) ?? stringValue(job.descriptionBody)]
        .filter(Boolean).join("\n")
    const lists = Array.isArray(job.lists) ? job.lists.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const section = item as Record<string, unknown>
      const content = stringValue(section.content)
      return content ? [[stringValue(section.text), content].filter(Boolean).join("\n")] : []
    }) : []
    const fullDescription = [description, ...lists, stringValue(job.additionalPlain) ?? stringValue(job.additional)]
      .filter(Boolean).join("\n")
    return [makeJob({
      company,
      provider: "lever",
      identifier,
      requisitionId: id,
      title,
      location: stringValue(categories.location) ?? stringValue(job.workplaceType),
      date: stringValue(job.createdAt),
      url: stringValue(job.hostedUrl),
      applicationUrl: stringValue(job.applyUrl),
      description: fullDescription || null,
      department: stringValue(categories.department),
      team: stringValue(categories.team),
      employmentType: stringValue(categories.commitment),
      workplaceType: stringValue(job.workplaceType),
      salary: salary ? { min: numberValue(salary.min), max: numberValue(salary.max), currency: stringValue(salary.currency), period: stringValue(salary.interval) } : null,
      metadata: { rawProvider: "lever" },
      now,
      apiUrl,
    })]
  })
}

function ashbyJobs(company: CompanyRecord, parsed: unknown, now: string, apiUrl: string): NormalizedJob[] {
  const identifier = companyIdentifier(company)
  const obj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  const rows = Array.isArray(obj.jobs) ? obj.jobs : []
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return []
    const job = row as Record<string, unknown>
    const id = stringValue(job.id)
    const title = stringValue(job.title)
    if (!id || !title) return []
    const location = locationName(job.location) ?? (Array.isArray(job.locations) ? job.locations.map(locationName).filter(Boolean).join(", ") : null)
    const comp = job.compensation && typeof job.compensation === "object" ? job.compensation as Record<string, unknown> : null
    return [makeJob({
      company,
      provider: "ashby",
      identifier,
      requisitionId: id,
      title,
      location,
      date: stringValue(job.publishedDate) ?? stringValue(job.createdAt),
      updatedAt: stringValue(job.updatedAt),
      url: stringValue(job.jobUrl) ?? `https://jobs.ashbyhq.com/${identifier}/${id}`,
      applicationUrl: stringValue(job.applyUrl) ?? stringValue(job.applicationUrl),
      description: stringValue(job.descriptionHtml) ?? stringValue(job.descriptionPlain) ?? stringValue(job.description),
      department: locationName(job.department),
      team: locationName(job.team),
      employmentType: stringValue(job.employmentType),
      salary: comp,
      locationRestrictions: Array.isArray(job.locationRestrictions) ? job.locationRestrictions.map(String) : undefined,
      timezoneRestrictions: Array.isArray(job.timezoneRestrictions) ? job.timezoneRestrictions.map(String) : undefined,
      metadata: { rawProvider: "ashby" },
      now,
      apiUrl,
    })]
  })
}

function smartRecruitersJobs(company: CompanyRecord, rows: unknown[], now: string, apiUrl: string): NormalizedJob[] {
  const identifier = companyIdentifier(company)
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return []
    const job = row as Record<string, unknown>
    const id = stringValue(job.id)
    const title = stringValue(job.name)
    if (!id || !title) return []
    const ref = job.ref && typeof job.ref === "object" ? job.ref as Record<string, unknown> : {}
    return [makeJob({
      company,
      provider: "smartrecruiters",
      identifier,
      requisitionId: id,
      title,
      location: locationName(job.location),
      date: stringValue(job.releasedDate) ?? stringValue(job.createdOn),
      url: stringValue(ref.careerSiteUrl) ?? stringValue(ref.postingUrl),
      applicationUrl: stringValue(ref.applyUrl),
      department: locationName(job.department) ?? locationName(job.function),
      employmentType: locationName(job.typeOfEmployment),
      metadata: { rawProvider: "smartrecruiters" },
      now,
      apiUrl,
    })]
  })
}

function decodeXml(text: string): string {
  return text
    .replace(/&(nbsp|amp|lt|gt);/gi, (_entity, name: string) => ({ nbsp: " ", amp: "&", lt: "<", gt: ">" })[name.toLowerCase() as "nbsp" | "amp" | "lt" | "gt"])
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
}

function xmlTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : null
}

function personioJobs(company: CompanyRecord, body: string, now: string, apiUrl: string): NormalizedJob[] {
  const identifier = companyIdentifier(company)
  const blocks = [...body.matchAll(/<position\b[^>]*>([\s\S]*?)<\/position>/gi)].map((m) => m[1])
  return blocks.flatMap((block, index) => {
    const id = xmlTag(block, "id") ?? xmlTag(block, "recruitingCategory") ?? `${identifier}-${index}`
    const title = xmlTag(block, "name")
    if (!title) return []
    return [makeJob({
      company,
      provider: "personio",
      identifier,
      requisitionId: id,
      title,
      location: xmlTag(block, "office") ?? xmlTag(block, "location"),
      date: xmlTag(block, "createdAt"),
      url: xmlTag(block, "jobUrl") ?? providerBoardUrl("personio", identifier),
      applicationUrl: xmlTag(block, "applyUrl"),
      description: xmlTag(block, "jobDescriptions"),
      department: xmlTag(block, "department"),
      employmentType: xmlTag(block, "employmentType"),
      metadata: { rawProvider: "personio" },
      now,
      apiUrl,
    })]
  })
}

export async function fetchAtsJobs(company: CompanyRecord, options: AtsFetchOptions = {}): Promise<AtsFetchResult> {
  const now = nowIso(options.now ?? new Date())
  if (!company.ats.verified || company.ats.status !== "verified" || !company.ats.provider || !company.ats.identifier) {
    return {
      companyId: company.id,
      provider: company.ats.provider ?? "greenhouse",
      identifier: company.ats.identifier ?? "",
      fetchedAt: now,
      jobs: [],
      allJobs: [],
      success: false,
      boardStatus: "invalid_mapping",
      snapshotComplete: false,
      error: "company ATS mapping is not verified",
      retryable: false,
    }
  }
  const provider = company.ats.provider
  const identifier = company.ats.identifier
  const apiUrl = (company.ats.apiUrl ?? providerApiUrl(provider, identifier)).replace("content=false", "content=true")
  try {
    let allJobs: NormalizedJob[] = []
    let httpStatus: number | undefined
    if (provider === "personio") {
      const response = await fetchXml(apiUrl, options)
      httpStatus = response.status
      const validFeed = /<(?:workzag-jobs|positions|position)\b/i.test(response.body)
      if (response.status < 200 || response.status >= 300 || !validFeed) {
        return { companyId: company.id, provider, identifier, fetchedAt: now, jobs: [], allJobs: [], success: false, boardStatus: response.status === 429 ? "rate_limited" : "failed", snapshotComplete: false, error: `Personio feed returned ${response.status}`, httpStatus: response.status, retryable: retryableStatus(response.status) }
      }
      allJobs = personioJobs(company, response.body, now, apiUrl)
    } else if (provider === "smartrecruiters") {
      const rows: unknown[] = []
      let offset = 0
      let limit = 100
      let totalFound = 0
      let snapshotComplete = false
      for (let page = 0; page < 20; page++) {
        const sep = apiUrl.includes("?") ? "&" : "?"
        const pageUrl = `${apiUrl}${sep}limit=${limit}&offset=${offset}`
        const response = await fetchJson(pageUrl, options)
        httpStatus = response.status
        if (response.status < 200 || response.status >= 300 || !response.parsed || typeof response.parsed !== "object") {
            return { companyId: company.id, provider, identifier, fetchedAt: now, jobs: [], allJobs: [], success: false, boardStatus: response.status === 429 ? "rate_limited" : "failed", snapshotComplete: false, error: `SmartRecruiters page fetch failed with ${response.status}`, httpStatus: response.status, retryable: retryableStatus(response.status) }
        }
        const obj = response.parsed as Record<string, unknown>
        const content = Array.isArray(obj.content) ? obj.content : null
        if (!content) return { companyId: company.id, provider, identifier, fetchedAt: now, jobs: [], allJobs: [], success: false, boardStatus: "failed", snapshotComplete: false, error: "SmartRecruiters response missing content array", httpStatus: response.status, retryable: false }
        rows.push(...content)
        const total = typeof obj.totalFound === "number" ? obj.totalFound : rows.length
        totalFound = Math.max(totalFound, total)
        limit = typeof obj.limit === "number" ? obj.limit : limit
        offset += content.length
        if (rows.length >= total || content.length === 0) {
          snapshotComplete = rows.length >= total
          break
        }
      }
      allJobs = smartRecruitersJobs(company, rows, now, apiUrl)
      if (rows.length >= totalFound) snapshotComplete = true
      return {
        companyId: company.id, provider, identifier, fetchedAt: now,
        jobs: allJobs, allJobs, success: true,
        boardStatus: !snapshotComplete ? "partial" : allJobs.length ? "success" : "empty",
        snapshotComplete, httpStatus,
      }
    } else {
      let response = await fetchJson(apiUrl, options)
      // Oversized full boards can exceed the body cap; retain the complete lightweight snapshot.
      if (provider === "greenhouse" && response.status === 200 && !response.parsed) {
        response = await fetchJson(apiUrl.replace("content=true", "content=false"), options)
      }
      httpStatus = response.status
      if (response.status < 200 || response.status >= 300 || !response.parsed || typeof response.parsed !== "object") {
        return { companyId: company.id, provider, identifier, fetchedAt: now, jobs: [], allJobs: [], success: false, boardStatus: response.status === 429 ? "rate_limited" : "failed", snapshotComplete: false, error: `${provider} fetch failed with ${response.status}`, httpStatus: response.status, retryable: retryableStatus(response.status) }
      }
      if (provider === "greenhouse") allJobs = greenhouseJobs(company, response.parsed, now, apiUrl)
      else if (provider === "lever") allJobs = leverJobs(company, response.parsed, now, apiUrl)
      else allJobs = ashbyJobs(company, response.parsed, now, apiUrl)
    }
    return { companyId: company.id, provider, identifier, fetchedAt: now, jobs: allJobs, allJobs, success: true, boardStatus: allJobs.length ? "success" : "empty", snapshotComplete: true, httpStatus }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { companyId: company.id, provider, identifier, fetchedAt: now, jobs: [], allJobs: [], success: false, boardStatus: /429|rate.?limit/i.test(message) ? "rate_limited" : "failed", snapshotComplete: false, error: message, retryable: true }
  }
}

function emptyStats(verifiedCompanies: number): AtsIngestionStats {
  return {
    verifiedCompanies,
    boardsConsidered: verifiedCompanies,
    boardsCrawled: 0,
    boardsSkippedFresh: 0,
    boardsDeferredBudget: 0,
    companiesAttempted: 0,
    successfulBoards: 0,
    failedBoards: 0,
    rateLimitedBoards: 0,
    partialBoards: 0,
    emptyBoards: 0,
    invalidMappings: 0,
    totalJobsFetched: 0,
    jobsNormalized: 0,
    historicalJobsCreated: 0,
    historicalJobsUpdated: 0,
    historicalJobsClosed: 0,
    historicalJobsReappeared: 0,
    duplicatesDetected: 0,
    potentialReposts: 0,
    providerDistribution: {},
    errors: [],
    rotationSlot: null,
    selectedBoardIds: [],
  }
}

function boardSelectionKey(company: CompanyRecord): string {
  const provider = company.ats.provider
  const identifier = company.ats.identifier?.trim().toLowerCase() ?? ""
  if (!provider || !identifier) return `${company.id.toLowerCase()}`
  const boardUrl = company.ats.boardUrl ?? providerBoardUrl(provider, identifier)
  const apiUrl = company.ats.apiUrl ?? providerApiUrl(provider, identifier)
  return `${provider}/${providerRegion(provider, boardUrl, apiUrl)}/${identifier}`
}

function compareStableKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function rotateAtsBoardCohort<T>(items: T[], budget: number, slot: number, stableKey: (item: T) => string): T[] {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("ATS board budget must be a nonnegative integer")
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("ATS rotation slot must be a nonnegative integer")
  const ordered = [...items].sort((a, b) => compareStableKeys(stableKey(a), stableKey(b)))
  const count = Math.min(ordered.length, budget)
  if (count === 0) return []
  const start = ((slot % ordered.length) * (budget % ordered.length)) % ordered.length
  return Array.from({ length: count }, (_, index) => ordered[(start + index) % ordered.length])
}

function configuredRotationSlot(explicit?: number): number | undefined {
  if (explicit !== undefined) {
    if (!Number.isSafeInteger(explicit) || explicit < 0) throw new Error("ATS rotation slot must be a nonnegative integer")
    return explicit
  }
  const value = process.env.AI_JOB_SEARCH_ATS_ROTATION_SLOT
  if (value === undefined || value.trim() === "") return undefined
  const slot = Number(value)
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("AI_JOB_SEARCH_ATS_ROTATION_SLOT must be a nonnegative integer")
  return slot
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let index = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const current = index++
      results[current] = await fn(items[current])
    }
  })
  await Promise.all(workers)
  return results
}

const DEFAULT_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_FAILURE_RETRY_MS = 60 * 60 * 1000

function selectCompanies(registry: JsonCompanyRegistry, options: AtsIngestionOptions, history?: JsonJobHistoryStore, now = new Date()): { selected: CompanyRecord[]; skippedFresh: number; deferredBudget: number; rotationSlot?: number } {
  let companies = registry.listCompanies().filter((company) => company.ats.verified && company.ats.status === "verified")
  if (options.company) companies = companies.filter((company) => company.id === options.company || company.canonicalName.toLowerCase().includes(options.company!.toLowerCase()))
  if (options.provider) companies = companies.filter((company) => company.ats.provider === options.provider)
  const schedulingEnabled = options.boardBudget !== undefined || options.successTtlMs !== undefined || options.failureRetryMs !== undefined
  const due = companies.map((company) => {
    const state = history?.getFetchState(company.id, company.ats.provider ?? undefined, company.ats.identifier ?? undefined)
    const lastSuccess = state?.lastSuccessfulAt ? Date.parse(state.lastSuccessfulAt) : Number.NaN
    const lastAttempt = state?.lastAttemptedAt ? Date.parse(state.lastAttemptedAt) : Number.NaN
    const persistencePending = state?.persistencePending === true
    const failedAttempt = !persistencePending && Number.isFinite(lastAttempt)
      && (!Number.isFinite(lastSuccess) || lastAttempt > lastSuccess)
    const failedRecently = failedAttempt
      && now.getTime() - lastAttempt < (options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS)
    const healthyFresh = !persistencePending && Number.isFinite(lastSuccess)
      && now.getTime() - lastSuccess < (options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS)
    const skip = schedulingEnabled && (failedRecently || healthyFresh)
    const priority = !Number.isFinite(lastAttempt) ? 0 : failedAttempt ? 2 : 1
    return { company, skip, priority, lastSuccess }
  })
  const requestedLimit = options.limit && Number.isFinite(options.limit) ? Math.max(0, options.limit) : Number.POSITIVE_INFINITY
  const budget = Math.max(0, options.boardBudget ?? Number.POSITIVE_INFINITY)
  const dueItems = due.filter((item) => !item.skip)
    .sort((a, b) => a.priority - b.priority || (a.lastSuccess || 0) - (b.lastSuccess || 0) || compareStableKeys(boardSelectionKey(a.company), boardSelectionKey(b.company)))
  const rotationSlot = configuredRotationSlot(options.rotationSlot)
  const finiteBudget = Number.isFinite(budget) ? budget : dueItems.length
  const selectionBudget = Math.min(requestedLimit, finiteBudget)
  const selectedItems = rotationSlot === undefined
    ? dueItems.slice(0, selectionBudget)
    : rotateAtsBoardCohort(dueItems, selectionBudget, rotationSlot, (item) => boardSelectionKey(item.company))
  const selected = selectedItems.map((item) => item.company)
  return { selected, skippedFresh: due.filter((item) => item.skip).length, deferredBudget: dueItems.length - selected.length, rotationSlot }
}

function addHistoryStats(stats: AtsIngestionStats, history: UpsertHistoryStats): void {
  stats.historicalJobsCreated += history.created
  stats.historicalJobsUpdated += history.updated
  stats.historicalJobsClosed += history.closed
  stats.historicalJobsReappeared += history.reappeared
  stats.potentialReposts += history.repostCandidates
}

export async function runAtsJobIngestion(options: AtsIngestionOptions = {}): Promise<{ stats: AtsIngestionStats; results: AtsFetchResult[]; jobs: NormalizedJob[]; history?: JsonJobHistoryStore; registrySource: "local" | "supabase"; registryWarning?: string }> {
  const loadedRegistry = await loadAtsCompanyRegistry({ source: options.registrySource, registryPath: options.registryPath })
  const registry = loadedRegistry.registry
  const history = options.noHistory ? undefined : await JsonJobHistoryStore.load(options.historyPath ?? DEFAULT_JOB_HISTORY_PATH)
  const registryCompanies = registry.listCompanies()
  const verified = registryCompanies.filter((company) => company.ats.verified && company.ats.status === "verified")
  const configuredMinimum = options.registryMinVerifiedBoards ?? (process.env.AI_JOB_SEARCH_ATS_REGISTRY_MIN_VERIFIED === undefined
    ? undefined
    : Number(process.env.AI_JOB_SEARCH_ATS_REGISTRY_MIN_VERIFIED))
  if (configuredMinimum !== undefined && (!Number.isInteger(configuredMinimum) || configuredMinimum < 0)) {
    throw new Error("AI_JOB_SEARCH_ATS_REGISTRY_MIN_VERIFIED must be a nonnegative integer")
  }
  if (configuredMinimum !== undefined && verified.length < configuredMinimum) {
    throw new Error(`ATS board registry loaded ${verified.length} verified board(s) from ${loadedRegistry.source}; expected at least ${configuredMinimum}. This is a registry/configuration failure, not an empty employer-board snapshot.`)
  }
  process.stderr.write(`[ats-registry] source=${loadedRegistry.source} verified_boards=${verified.length}${loadedRegistry.warning ? ` warning=${loadedRegistry.warning}` : ""}\n`)
  const now = options.now ?? new Date()
  const selection = selectCompanies(registry, options, history, now)
  const companies = selection.selected
  const stats = emptyStats(registry.listCompanies().filter((company) => company.ats.verified && company.ats.status === "verified").length)
  stats.boardsCrawled = companies.length
  stats.boardsSkippedFresh = selection.skippedFresh
  stats.boardsDeferredBudget = selection.deferredBudget
  stats.rotationSlot = selection.rotationSlot ?? null
  stats.selectedBoardIds = companies.map(boardSelectionKey)
  stats.invalidMappings = registryCompanies.filter((company) => Boolean(company.ats.provider || company.ats.identifier) && (!company.ats.verified || company.ats.status !== "verified" || !company.ats.provider || !company.ats.identifier)).length
  const results = await mapLimit(companies, options.concurrency ?? 5, async (company) => fetchAtsJobs(company, options))
  for (const result of results) {
    const company = registry.getById(result.companyId)
    stats.companiesAttempted += 1
    if (result.provider) stats.providerDistribution[result.provider] = (stats.providerDistribution[result.provider] ?? 0) + 1
    if (!result.success) {
      stats.failedBoards += 1
      if (result.boardStatus === "rate_limited") stats.rateLimitedBoards += 1
      stats.errors.push({ companyId: result.companyId, company: company?.canonicalName ?? result.companyId, provider: result.provider, error: result.error ?? "unknown fetch failure" })
      if (history && !options.dryRun) {
        const previous = history.getFetchState(result.companyId, result.provider, result.identifier)
        history.recordFetchState({
          companyId: result.companyId,
          provider: result.provider,
          identifier: result.identifier,
          lastAttemptedAt: result.fetchedAt,
          lastSuccessfulAt: previous?.lastSuccessfulAt ?? null,
          lastJobCount: previous?.lastJobCount ?? null,
          snapshotComplete: false,
          persistencePending: false,
          lastError: result.error ?? "unknown fetch failure",
          updatedAt: result.fetchedAt,
        })
      }
      continue
    }
    if (result.boardStatus === "success") stats.successfulBoards += 1
    if (result.boardStatus === "empty") stats.emptyBoards += 1
    if (result.boardStatus === "partial") stats.partialBoards += 1
    stats.totalJobsFetched += result.allJobs.length
    stats.jobsNormalized += result.jobs.length
    stats.duplicatesDetected += Math.max(0, result.jobs.length - new Set(result.jobs.map((job) => String(job.id))).size)
    if (history && company && !options.dryRun) {
      const previous = history.getFetchState(result.companyId, result.provider, result.identifier)
      const historyStats = history.upsertSnapshot({
        companyId: company.id,
        companyName: company.canonicalName,
        source: result.provider,
        provider: result.provider,
        identifier: result.identifier,
        jobs: result.jobs,
        fetchedAt: result.fetchedAt,
        snapshotComplete: result.snapshotComplete,
      })
      addHistoryStats(stats, historyStats)
      result.closedJobs = historyStats.closedJobIds.flatMap((id) => history!.list().filter((job) => job.id === id))
      history.recordFetchState({
        companyId: result.companyId,
        provider: result.provider,
        identifier: result.identifier,
        lastAttemptedAt: result.fetchedAt,
        lastSuccessfulAt: result.snapshotComplete && !options.deferSuccessfulFreshness ? result.fetchedAt : previous?.lastSuccessfulAt ?? null,
        lastJobCount: result.allJobs.length,
        snapshotComplete: result.snapshotComplete,
        persistencePending: result.snapshotComplete && options.deferSuccessfulFreshness === true,
        lastError: result.snapshotComplete ? null : "Board snapshot was partial; retry after the failure backoff.",
        updatedAt: result.fetchedAt,
      })
    }
  }
  if (history && !options.dryRun) {
    try {
      await history.save()
    } catch (error) {
      stats.errors.push({ companyId: "history", company: "ATS job history", error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { stats, results, jobs: dedupePreferDirectAts(results.flatMap((result) => result.jobs)), history, registrySource: loadedRegistry.source, registryWarning: loadedRegistry.warning }
}

function parseArgs(argv: string[]): Record<string, string | boolean> & { _: string[] } {
  const parsed: Record<string, string | boolean> & { _: string[] } = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      parsed._.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (["registry", "history", "format", "company", "provider", "limit", "concurrency"].includes(key)) parsed[key] = argv[++i]
    else parsed[key] = true
  }
  return parsed
}

function formatStats(stats: AtsIngestionStats): string {
  const providers = Object.entries(stats.providerDistribution).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  -"
  return [
    `Verified companies: ${stats.verifiedCompanies}`,
    `Boards selected: ${stats.boardsCrawled}${stats.rotationSlot === null ? "" : ` (rotation slot ${stats.rotationSlot})`}`,
    `Boards deferred by budget: ${stats.boardsDeferredBudget}`,
    `Selected board identities: ${stats.selectedBoardIds?.join(", ") || "-"}`,
    `Companies attempted: ${stats.companiesAttempted}`,
    `Boards fetched successfully: ${stats.successfulBoards}`,
    `Boards failed: ${stats.failedBoards}`,
    `Total current ATS jobs: ${stats.totalJobsFetched}`,
    `Normalized jobs: ${stats.jobsNormalized}`,
    `Historical jobs created: ${stats.historicalJobsCreated}`,
    `Historical jobs updated: ${stats.historicalJobsUpdated}`,
    `Historical jobs closed: ${stats.historicalJobsClosed}`,
    `Historical jobs reappeared: ${stats.historicalJobsReappeared}`,
    `Potential reposts: ${stats.potentialReposts}`,
    "Provider distribution:",
    providers,
  ].join("\n")
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (command !== "run") {
    process.stderr.write("usage: ats_job_ingestor.ts run [--company id-or-name] [--provider provider] [--limit n] [--format json] [--dry-run] [--no-history]\n")
    return 2
  }
  const format = args.format === "json" ? "json" : "plain"
  const result = await runAtsJobIngestion({
    registryPath: typeof args.registry === "string" ? args.registry : DEFAULT_REGISTRY_PATH,
    historyPath: typeof args.history === "string" ? args.history : DEFAULT_JOB_HISTORY_PATH,
    company: typeof args.company === "string" ? args.company : undefined,
    provider: typeof args.provider === "string" ? args.provider as AtsProvider : undefined,
    limit: typeof args.limit === "string" ? Number(args.limit) : undefined,
    concurrency: typeof args.concurrency === "string" ? Number(args.concurrency) : undefined,
    dryRun: Boolean(args["dry-run"]),
    noHistory: Boolean(args["no-history"]),
  })
  process.stdout.write(format === "json" ? `${JSON.stringify({ stats: result.stats, jobs: result.jobs, results: result.results }, null, 2)}\n` : `${formatStats(result.stats)}\n`)
  return 0
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
