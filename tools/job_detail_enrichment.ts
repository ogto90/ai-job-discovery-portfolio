import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import type { NormalizedJob } from "./company_registry"
import { detectAts, extractJobPostingJsonLd, normalizeCacheUrl, preferredValidationUrl, visibleText } from "./job_availability_validator"
import { extractJobRequirements, type Evidence, type JobRequirements } from "./eligibility_engine"
import { isUsableFullJobDescription } from "./job_description_quality"
import { readBoundedText, safeFetch, safeRedirectUrl, type SafeHttpResponse } from "./safe_http"

export type EnrichmentStatus = "deferred" | "success" | "not_supported" | "not_needed" | "not_found" | "failed" | "rate_limited" | "timeout"

export interface DetailCompleteness {
  description: boolean
  location: boolean
  workAuthorization: boolean
  languages: boolean
  skills: boolean
  salary: boolean
  employmentType: boolean
}

export interface JobDetailEnrichment {
  status: EnrichmentStatus
  fetchedAt: string
  source: string
  cacheKey?: string
  cacheHit?: boolean
  reason?: string
  httpStatus?: number
  failureKind?: "parse"
  finalUrl?: string
  description?: string
  location?: string
  employmentType?: string
  salary?: string | { min?: number; max?: number; currency?: string; raw?: unknown } | null
  applicationUrl?: string
  structured?: {
    allowedCountries?: string[]
    allowedRegions?: string[]
    languages?: string[]
    workAuthorization?: string[]
    skills?: string[]
  }
  sourceEvidence: Evidence[]
  detailCompleteness: DetailCompleteness
  confidence: number
}

export interface EnrichmentSourceStats {
  /** Source observations passed to this enrichment call; repeated physical jobs remain separate. */
  considered: number
  /** Actual detail-adapter invocations, not necessarily one HTTP request each. */
  attempted: number
  /** Successful enrichment outcome, including cache hits; not necessarily a full description. */
  success: number
  /** Stage counter; can overlap with a terminal status below. */
  cacheHits: number
  /** Terminal outcomes are mutually exclusive per considered observation. */
  notNeeded: number
  deferred?: number
  notSupported: number
  notFound: number
  failed: number
  rateLimited: number
  timeout: number
  /** Candidate-state counters; these may overlap each other and terminal outcomes. */
  candidatesAlreadyFull?: number
  candidatesNeedingEnrichment?: number
  selectedByBudget?: number
  fullAfterEnrichment?: number
  stillInsufficient?: number
  httpFailed?: number
  parseFailed?: number
  otherFailed?: number
}

export interface EnrichmentStats extends EnrichmentSourceStats {
  /** Maximum adapter calls allowed for this run; deferred candidates do not consume it. */
  budget?: number
  bySource: Record<string, EnrichmentSourceStats>
}

export interface DetailAdapterContext {
  now: Date
  fetchImpl?: (url: string, init: RequestInit) => Promise<FetchResponse>
  resolveHost?: (hostname: string) => Promise<string[]>
  maxBodyBytes: number
  runCommand: (command: string, args: string[], timeoutMs?: number) => Promise<CommandResult>
}

export type SourceDetailAdapter = (job: NormalizedJob, context: DetailAdapterContext) => Promise<JobDetailEnrichment>

export interface EnrichmentOptions {
  now?: Date
  cachePath?: string
  useCache?: boolean
  ttlMs?: Partial<Record<EnrichmentStatus, number>>
  concurrency?: number
  maxJobs?: number
  maxBodyBytes?: number
  fetchImpl?: (url: string, init: RequestInit) => Promise<FetchResponse>
  resolveHost?: (hostname: string) => Promise<string[]>
  adapters?: Record<string, SourceDetailAdapter>
}

interface FetchResponse {
  status: number
  statusText?: string
  headers: Headers
  body?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
  cancel?: () => void
}

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

type CacheRecord = JobDetailEnrichment & {
  cacheKey: string
  source: string
  jobIdentity: string
}

const DEFAULT_CACHE_PATH = "job_scraper/detail_enrichment_cache.json"
const DEFAULT_MAX_BODY_BYTES = 768_000
const DEFAULT_MAX_JOBS = 30
const DETAIL_TIMEOUT_MS = 20_000
const USER_AGENT = "ai-job-search-detail-enrichment/1.0 (+https://github.com/MadsLorentzen/ai-job-search)"
let nextSmartRecruitersRequestAt = 0

async function paceSmartRecruitersRequest(): Promise<void> {
  const scheduledAt = Math.max(Date.now(), nextSmartRecruitersRequestAt)
  nextSmartRecruitersRequestAt = scheduledAt + 110
  if (scheduledAt > Date.now()) await new Promise((resolve) => setTimeout(resolve, scheduledAt - Date.now()))
}

const DEFAULT_TTL_MS: Record<EnrichmentStatus, number> = {
  deferred: 0,
  success: 24 * 60 * 60 * 1000,
  not_needed: 24 * 60 * 60 * 1000,
  not_supported: 7 * 24 * 60 * 60 * 1000,
  not_found: 7 * 24 * 60 * 60 * 1000,
  failed: 60 * 60 * 1000,
  rate_limited: 30 * 60 * 1000,
  timeout: 30 * 60 * 1000,
}

const CLI_DETAIL_SOURCES: Record<string, string> = {
  "arbeitnow-search": ".agents/skills/arbeitnow-search/cli/src/cli.ts",
  "freehire-search": ".agents/skills/freehire-search/cli/src/cli.ts",
  "himalayas-search": ".agents/skills/himalayas-search/cli/src/cli.ts",
  "infosecjobs-search": ".agents/skills/infosecjobs-search/cli/src/cli.ts",
  "jobgether-search": ".agents/skills/jobgether-search/cli/src/cli.ts",
  "jobnet-search": ".agents/skills/jobnet-search/cli/src/cli.ts",
  "linkedin-search": ".agents/skills/linkedin-search/cli/src/cli.ts",
  "remoteok-search": ".agents/skills/remoteok-search/cli/src/cli.ts",
  "remotive-search": ".agents/skills/remotive-search/cli/src/cli.ts",
  "weworkremotely-search": ".agents/skills/weworkremotely-search/cli/src/cli.ts",
}

const SOURCE_ALIASES: Record<string, string> = {
  jobgether: "jobgether-search",
  "jobgether-search": "jobgether-search",
  "we work remotely": "weworkremotely-search",
  weworkremotely: "weworkremotely-search",
  "weworkremotely-search": "weworkremotely-search",
  himalayas: "himalayas-search",
  "himalayas-search": "himalayas-search",
  infosecjobs: "infosecjobs-search",
  "infosec jobs": "infosecjobs-search",
  "infosecjobs-search": "infosecjobs-search",
  remotive: "remotive-search",
  "remotive-search": "remotive-search",
  remoteok: "remoteok-search",
  "remote ok": "remoteok-search",
  "remoteok-search": "remoteok-search",
  arbeitnow: "arbeitnow-search",
  "arbeitnow-search": "arbeitnow-search",
  linkedin: "linkedin-search",
  "linkedin-search": "linkedin-search",
  freehire: "freehire-search",
  "freehire-search": "freehire-search",
  greenhouse: "greenhouse",
}

function emptyCompleteness(): DetailCompleteness {
  return { description: false, location: false, workAuthorization: false, languages: false, skills: false, salary: false, employmentType: false }
}

function sourceName(job: NormalizedJob): string {
  const raw = String(job.portal ?? job.source ?? "").trim().toLowerCase()
  return SOURCE_ALIASES[raw] ?? raw
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function textLength(value: unknown): number {
  return text(value).replace(/\s+/g, " ").length
}

function isVagueRemoteLocation(value: unknown): boolean {
  const raw = text(value).toLowerCase()
  return raw === "remote" || raw === "anywhere" || raw === "worldwide remote"
}

function hasExplicitLocationScope(value: unknown): boolean {
  const raw = text(value)
  return Boolean(raw && !isVagueRemoteLocation(raw) && /\b(remote|united states|usa|u\.s\.|north america|europe|emea|eu|australia|canada|united kingdom|uk|austria|germany|[A-Z]{2}(?:,\s*[A-Z]{2}){2,})\b/i.test(raw))
}

function hasScopedLocation(job: NormalizedJob, req?: JobRequirements): boolean {
  const requirements = req ?? extractJobRequirements(job)
  return Boolean(requirements.geography.allowedCountries.length || requirements.geography.allowedRegions.length || requirements.geography.worldwide)
}

function completenessFrom(job: NormalizedJob, detailText = ""): DetailCompleteness {
  const combined = [job.title, job.location, job.description, detailText, ...(Array.isArray(job.tags) ? job.tags : [])].filter(Boolean).join("\n")
  return {
    description: isUsableFullJobDescription(job.description) || isUsableFullJobDescription(detailText),
    location: !isVagueRemoteLocation(job.location) && Boolean(text(job.location)) || /\b(europe|emea|eu|worldwide|united states|usa|austria|remote within)\b/i.test(combined),
    workAuthorization: /\b(work authorization|authorized to work|visa|sponsorship|citizenship|security clearance|clearance)\b/i.test(combined),
    languages: /\b(german|english|language)\b/i.test(combined),
    skills: /\b(sast|sca|dast|secure sdlc|application security|product security|vulnerability|threat model|siem|iso 27001)\b/i.test(combined),
    salary: Boolean(job.salary) || /\b(?:EUR|USD|GBP|€|\$|£)\s?\d{2,3}/i.test(combined),
    employmentType: Boolean(job.employmentType || job.jobType) || /\b(full[-\s]?time|part[-\s]?time|contract|b2b|freelance)\b/i.test(combined),
  }
}

export function needsEnrichment(job: NormalizedJob): boolean {
  const req = extractJobRequirements(job)
  if (job.sourceType === "ats" && isUsableFullJobDescription(job.description) && hasScopedLocation(job, req)) return false
  if (job.sourceType === "ats" && !isUsableFullJobDescription(job.description)) return true
  if (req.workplace === "onsite" && req.geography.allowedCountries.length > 0 && !isVagueRemoteLocation(job.location)) return false
  if (!isUsableFullJobDescription(job.description)) return true
  if (req.workplace === "remote" && !hasScopedLocation(job, req)) return true
  if (req.workAuthorization.evidence.length === 0 && /\b(clearance|citizenship|visa|sponsorship|authorized)\b/i.test([job.title, job.description].filter(Boolean).join("\n"))) return true
  if (req.languages.length === 0 && /\bgerman|english\b/i.test(text(job.description))) return true
  if (req.roleFamilies.length === 0) return true
  return false
}

function cacheIdentity(job: NormalizedJob): string {
  const id = text(job.id)
  const source = sourceName(job)
  const rawUrl = preferredValidationUrl(job) ?? ""
  let url = rawUrl
  try {
    if (rawUrl) url = normalizeCacheUrl(rawUrl)
  } catch {
    url = rawUrl
  }
  return `${source}|${id}|${url}`
}

export function enrichmentCacheKey(job: NormalizedJob): string {
  return createHash("sha256").update(cacheIdentity(job)).digest("hex")
}

async function readCache(path: string): Promise<Record<string, CacheRecord>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, CacheRecord>
  } catch {
    return {}
  }
}

async function writeCache(path: string, cache: Record<string, CacheRecord>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8")
}

function isFresh(record: CacheRecord, now: Date, ttlMs: Record<EnrichmentStatus, number>): boolean {
  return Date.parse(record.fetchedAt) + ttlMs[record.status] > now.getTime()
}

function evidence(field: string, value: unknown, source = "detail", confidence = 0.9): Evidence[] {
  const valueText = text(value)
  return valueText ? [{ field, text: valueText.slice(0, 500), source, confidence }] : []
}

function stripHtml(html: string): string {
  return visibleText(html)
}

function fieldString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return stripHtml(value)
  if (Array.isArray(value)) return value.map(fieldString).filter(Boolean).join(", ") || undefined
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    return fieldString(obj.name ?? obj.addressLocality ?? obj.addressRegion ?? obj.addressCountry ?? obj.value)
  }
  return undefined
}

function jsonLdLocation(posting: Record<string, unknown>): string | undefined {
  return fieldString(posting.applicantLocationRequirements) ?? fieldString(posting.jobLocation) ?? fieldString(posting.jobLocationType)
}

function jsonLdSalary(posting: Record<string, unknown>): JobDetailEnrichment["salary"] {
  const base = posting.baseSalary
  if (!base || typeof base !== "object") return undefined
  const obj = base as Record<string, unknown>
  const currency = fieldString(obj.currency)
  const value = obj.value
  if (typeof value === "number") return { min: value, max: value, currency, raw: base }
  if (value && typeof value === "object") {
    const val = value as Record<string, unknown>
    return {
      min: typeof val.minValue === "number" ? val.minValue : undefined,
      max: typeof val.maxValue === "number" ? val.maxValue : undefined,
      currency,
      raw: base,
    }
  }
  return { raw: base }
}

function structuredFromText(detailText: string): JobDetailEnrichment["structured"] {
  return {
    allowedCountries: [...detailText.matchAll(/\b(United States|USA|U\.S\.|Austria|Germany|Canada|United Kingdom|UK)\b/gi)].map((match) => match[1]),
    allowedRegions: [...detailText.matchAll(/\b(Europe|European Union|EU|EMEA|Worldwide|Global|North America|APAC|LATAM)\b/gi)].map((match) => match[1]),
    languages: [...detailText.matchAll(/\b(German|English)\b/gi)].map((match) => match[1]),
    workAuthorization: [...detailText.matchAll(/.{0,80}\b(work authorization|authorized to work|visa|sponsorship|citizenship|security clearance|clearance)\b.{0,120}/gi)].map((match) => match[0].trim()),
    skills: [...detailText.matchAll(/\b(application security|product security|secure sdlc|sast|sca|dast|threat model(?:ing)?|vulnerability management|iso 27001)\b/gi)].map((match) => match[1]),
  }
}

function success(source: string, now: Date, payload: Partial<JobDetailEnrichment>, detailText = ""): JobDetailEnrichment {
  const mergedJob = { description: payload.description, location: payload.location, salary: payload.salary, employmentType: payload.employmentType }
  return {
    status: "success",
    fetchedAt: now.toISOString(),
    source,
    sourceEvidence: payload.sourceEvidence ?? [],
    detailCompleteness: payload.detailCompleteness ?? completenessFrom(mergedJob as NormalizedJob, detailText),
    confidence: payload.confidence ?? 0.86,
    ...payload,
  }
}

function terminal(status: EnrichmentStatus, source: string, now: Date, reason: string, httpStatus?: number): JobDetailEnrichment {
  return {
    status,
    fetchedAt: now.toISOString(),
    source,
    reason,
    httpStatus,
    sourceEvidence: [],
    detailCompleteness: emptyCompleteness(),
    confidence: status === "not_needed" ? 1 : 0,
  }
}

function emptySourceStats(): EnrichmentSourceStats {
  return {
    considered: 0, attempted: 0, success: 0, cacheHits: 0, notNeeded: 0,
    deferred: 0, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0,
    timeout: 0, candidatesAlreadyFull: 0, candidatesNeedingEnrichment: 0,
    selectedByBudget: 0, fullAfterEnrichment: 0, stillInsufficient: 0,
    httpFailed: 0, parseFailed: 0, otherFailed: 0,
  }
}

async function fetchText(urlRaw: string, context: DetailAdapterContext, expectedHosts: string[], redirect: RequestRedirect = "follow", beforeRequest?: () => Promise<void>): Promise<{ status: number; finalUrl: string; body: string }> {
  let current = new URL(urlRaw).toString()
  for (let redirects = 0; redirects <= 5; redirects++) {
    const url = new URL(current)
    const host = url.hostname.toLowerCase().replace(/^www\./, "")
    if (!expectedHosts.includes(host)) throw new Error(`detail URL host ${host} is not supported by this adapter`)
    if (beforeRequest) await beforeRequest()
    const response = await safeFetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    }, context.resolveHost, context.fetchImpl as ((url: string, init: RequestInit) => Promise<SafeHttpResponse>) | undefined) as FetchResponse
    const location = response.headers.get("location")
    if (redirect === "follow" && [301, 302, 303, 307, 308].includes(response.status) && location) {
      if (redirects === 5) throw new Error("too many redirects")
      current = safeRedirectUrl(url, location).toString()
      response.cancel?.()
      continue
    }
    return { status: response.status, finalUrl: url.toString(), body: await readBoundedText(response, context.maxBodyBytes) }
  }
  throw new Error("too many redirects")
}

function classifyFetchError(error: unknown, source: string, now: Date): JobDetailEnrichment {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|abort/i.test(message)) return terminal("timeout", source, now, message)
  if (/429|rate/i.test(message)) return terminal("rate_limited", source, now, message)
  if (/404|not found|no job/i.test(message)) return terminal("not_found", source, now, message)
  return terminal("failed", source, now, message)
}

function normalizedIdentity(value: unknown): string {
  return text(value).normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

function jsonLdUrls(posting: Record<string, unknown>): string[] {
  const mainEntity = posting.mainEntityOfPage
  const mainEntityUrl = typeof mainEntity === "string"
    ? mainEntity
    : mainEntity && typeof mainEntity === "object"
      ? text((mainEntity as Record<string, unknown>).url ?? (mainEntity as Record<string, unknown>)["@id"])
      : ""
  return [text(posting.url), mainEntityUrl, text(posting["@id"])]
    .filter((value) => /^https?:\/\//i.test(value))
}

function sameNormalizedUrl(left: string, right: string): boolean {
  try {
    return normalizeCacheUrl(left) === normalizeCacheUrl(right)
  } catch {
    return left === right
  }
}

function jsonLdIdentifier(posting: Record<string, unknown>): string {
  const value = posting.identifier
  if (typeof value === "string" || typeof value === "number") return String(value).trim()
  if (value && typeof value === "object") {
    const identifier = value as Record<string, unknown>
    return text(identifier.value ?? identifier.name)
  }
  return ""
}

function matchingJsonLdPosting(job: NormalizedJob, postings: Record<string, unknown>[]): Record<string, unknown> | undefined {
  if (!postings.length) return undefined
  const requestedUrls = [job.sourceUrl, job.applicationUrl, job.applyUrl, job.canonicalUrl, job.url]
    .map(text).filter((value) => /^https?:\/\//i.test(value))
  const explicitUrlMatches = postings.filter((posting) =>
    jsonLdUrls(posting).some((postingUrl) => requestedUrls.some((requestedUrl) => sameNormalizedUrl(postingUrl, requestedUrl)))
  )
  if (explicitUrlMatches.length === 1) return explicitUrlMatches[0]

  const sourceJobId = text(job.sourceJobId)
  if (sourceJobId) {
    const idMatches = postings.filter((posting) => {
      const identifiers = [jsonLdIdentifier(posting), ...jsonLdUrls(posting).map((url) => {
        try { return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "" } catch { return "" }
      })]
      return identifiers.includes(sourceJobId)
    })
    if (idMatches.length === 1) return idMatches[0]
  }

  const title = normalizedIdentity(job.title)
  const company = normalizedIdentity(job.company)
  if (!title || !company) return undefined
  const exactMetadataMatches = postings.filter((posting) =>
    normalizedIdentity(posting.title) === title
      && normalizedIdentity(fieldString((posting.hiringOrganization as Record<string, unknown> | undefined)?.name)) === company
  )
  return exactMetadataMatches.length === 1 ? exactMetadataMatches[0] : undefined
}

export function enrichmentFromHtml(job: NormalizedJob, html: string, source: string, now: Date, httpStatus?: number, finalUrl?: string): JobDetailEnrichment {
  const postings = extractJobPostingJsonLd(html)
  const posting = matchingJsonLdPosting(job, postings)
  if (postings.length > 0 && !posting) {
    return { ...terminal("failed", source, now, "JobPosting JSON-LD could not be uniquely matched to this requisition", httpStatus), failureKind: "parse" }
  }
  const pageText = stripHtml(html)
  const description = posting ? fieldString(posting.description) ?? pageText : pageText
  const location = posting ? jsonLdLocation(posting) : undefined
  const employmentType = posting ? fieldString(posting.employmentType) : undefined
  const salary = posting ? jsonLdSalary(posting) : undefined
  const structured = structuredFromText([description, location, employmentType].filter(Boolean).join("\n"))
  return success(source, now, {
    httpStatus,
    finalUrl,
    description,
    location,
    employmentType,
    salary,
    applicationUrl: posting ? fieldString(posting.url ?? posting.directApply) : undefined,
    structured,
    sourceEvidence: [
      ...evidence("description", description, "detail_page", 0.9),
      ...evidence("location", location, "detail_page", 0.9),
      ...evidence("employmentType", employmentType, "detail_page", 0.85),
      ...evidence("workAuthorization", structured.workAuthorization?.join("\n"), "detail_page", 0.95),
    ],
    detailCompleteness: completenessFrom({ ...job, description, location, employmentType, salary } as NormalizedJob, description ?? ""),
    confidence: posting ? 0.92 : 0.76,
  }, description ?? pageText)
}

async function jobgetherAdapter(job: NormalizedJob, context: DetailAdapterContext): Promise<JobDetailEnrichment> {
  const source = sourceName(job)
  const rawUrl = preferredValidationUrl(job)
  if (!rawUrl) return terminal("failed", source, context.now, "no URL for Jobgether detail")
  try {
    const page = await fetchText(rawUrl, context, ["jobgether.com"])
    if (page.status === 404 || page.status === 410) return terminal("not_found", source, context.now, `HTTP ${page.status}`, page.status)
    if (page.status === 429) return terminal("rate_limited", source, context.now, `HTTP ${page.status}`, page.status)
    if (page.status === 403 || page.status >= 500) return terminal("failed", source, context.now, `HTTP ${page.status}`, page.status)
    return enrichmentFromHtml(job, page.body, source, context.now, page.status, page.finalUrl)
  } catch (error) {
    return classifyFetchError(error, source, context.now)
  }
}

async function cliDetailAdapter(job: NormalizedJob, context: DetailAdapterContext): Promise<JobDetailEnrichment> {
  const source = sourceName(job)
  const cli = CLI_DETAIL_SOURCES[source]
  if (!cli) return terminal("not_supported", source || "unknown", context.now, "source has no supported detail adapter")
  const id = text(job.id) || preferredValidationUrl(job) || text(job.url)
  if (!id) return terminal("failed", source, context.now, "no id or URL for detail command")
  const result = await context.runCommand(process.execPath || "bun", ["run", cli, "detail", id, "--format", "json"], DETAIL_TIMEOUT_MS)
  if (result.timedOut) return terminal("timeout", source, context.now, "detail command timed out")
  if (result.code !== 0) {
    const message = result.stderr || result.stdout || `detail command exited ${result.code}`
    if (/429|rate/i.test(message)) return terminal("rate_limited", source, context.now, message)
    if (/404|not found|no_id|NO_ID/i.test(message)) return terminal("not_found", source, context.now, message)
    return terminal("failed", source, context.now, message)
  }
  try {
    const parsed = JSON.parse(result.stdout) as NormalizedJob
    const description = text(parsed.description) || undefined
    const location = text(parsed.location) || undefined
    const employmentType = text(parsed.employmentType ?? parsed.jobType) || undefined
    const salary = parsed.salary as JobDetailEnrichment["salary"]
    const combined = [description, location, employmentType, text(parsed.remote), ...(Array.isArray(parsed.tags) ? parsed.tags : [])].filter(Boolean).join("\n")
    return success(source, context.now, {
      description,
      location,
      employmentType,
      salary,
      applicationUrl: text(parsed.applicationUrl ?? parsed.applyUrl ?? parsed.url) || undefined,
      structured: structuredFromText(combined),
      sourceEvidence: [
        ...evidence("description", description, "source_detail_cli", 0.88),
        ...evidence("location", location, "source_detail_cli", 0.88),
        ...evidence("employmentType", employmentType, "source_detail_cli", 0.84),
      ],
      detailCompleteness: completenessFrom({ ...job, ...parsed } as NormalizedJob, description ?? ""),
      confidence: 0.84,
    }, combined)
  } catch (error) {
    return { ...terminal("failed", source, context.now, error instanceof Error ? error.message : "malformed JSON"), failureKind: "parse" }
  }
}

function greenhouseLocation(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(greenhouseLocation).filter(Boolean).join(", ") || undefined
  if (typeof value === "object") return fieldString((value as Record<string, unknown>).name)
  return undefined
}

async function greenhouseAdapter(job: NormalizedJob, context: DetailAdapterContext): Promise<JobDetailEnrichment> {
  const source = sourceName(job)
  const rawUrl = preferredValidationUrl(job)
  if (!rawUrl) return terminal("failed", source, context.now, "no URL for Greenhouse detail")
  const ats = detectAts(rawUrl)
  if (!ats || ats.provider !== "greenhouse") return terminal("not_supported", source, context.now, "not a Greenhouse job URL")
  try {
    const page = await fetchText(ats.apiUrl, context, ["boards-api.greenhouse.io"])
    if (page.status === 404 || page.status === 410) return terminal("not_found", source, context.now, `HTTP ${page.status}`, page.status)
    if (page.status === 429) return terminal("rate_limited", source, context.now, `HTTP ${page.status}`, page.status)
    if (page.status === 403 || page.status >= 500) return terminal("failed", source, context.now, `HTTP ${page.status}`, page.status)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(page.body) as Record<string, unknown>
    } catch (error) {
      return { ...terminal("failed", source, context.now, error instanceof Error ? error.message : "malformed JSON", page.status), failureKind: "parse" }
    }
    const description = fieldString(parsed.content)
    const location = greenhouseLocation(parsed.location) ?? greenhouseLocation(parsed.offices)
    const structured = structuredFromText([description, location].filter(Boolean).join("\n"))
    return success(source, context.now, {
      httpStatus: page.status,
      finalUrl: page.finalUrl,
      description,
      location,
      applicationUrl: fieldString(parsed.absolute_url),
      structured,
      sourceEvidence: [
        ...evidence("description", description, "greenhouse_detail_api", 0.95),
        ...evidence("location", location, "greenhouse_detail_api", 0.95),
        ...evidence("workAuthorization", structured.workAuthorization?.join("\n"), "greenhouse_detail_api", 0.95),
      ],
      detailCompleteness: completenessFrom({ ...job, description, location } as NormalizedJob, description ?? ""),
      confidence: 0.95,
    }, description ?? "")
  } catch (error) {
    return classifyFetchError(error, source, context.now)
  }
}

async function smartRecruitersAdapter(job: NormalizedJob, context: DetailAdapterContext): Promise<JobDetailEnrichment> {
  const source = sourceName(job)
  const ats = job.ats && typeof job.ats === "object" ? job.ats as Record<string, unknown> : {}
  const companyId = text(ats.companyIdentifier)
  const postingId = text(ats.requisitionId)
  if (ats.provider !== "smartrecruiters" || !companyId || !postingId) {
    return terminal("not_supported", source, context.now, "SmartRecruiters board and posting ID are required")
  }
  const apiUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyId)}/postings/${encodeURIComponent(postingId)}`
  try {
    const page = await fetchText(apiUrl, context, ["api.smartrecruiters.com"], "manual", paceSmartRecruitersRequest)
    if (page.status === 404 || page.status === 410) return terminal("not_found", source, context.now, `HTTP ${page.status}`, page.status)
    if (page.status === 429) return terminal("rate_limited", source, context.now, `HTTP ${page.status}`, page.status)
    if (page.status < 200 || page.status >= 300) return terminal("failed", source, context.now, `HTTP ${page.status}`, page.status)
    let parsed: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(page.body)
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("posting detail is not an object")
      parsed = value as Record<string, unknown>
    } catch {
      return { ...terminal("failed", source, context.now, "invalid posting detail JSON", page.status), failureKind: "parse" }
    }
    const company = parsed.company && typeof parsed.company === "object" && !Array.isArray(parsed.company)
      ? parsed.company as Record<string, unknown> : {}
    const returnedCompanyId = text(company.identifier)
    if (text(parsed.id) !== postingId || !returnedCompanyId || returnedCompanyId.toLowerCase() !== companyId.toLowerCase()) {
      return { ...terminal("failed", source, context.now, "posting detail identity mismatch", page.status), failureKind: "parse" }
    }
    const jobAd = parsed.jobAd && typeof parsed.jobAd === "object" ? parsed.jobAd as Record<string, unknown> : {}
    const sections = jobAd.sections && typeof jobAd.sections === "object" ? jobAd.sections as Record<string, unknown> : {}
    const sectionText = (key: string): string => {
      const section = sections[key]
      return section && typeof section === "object" ? fieldString((section as Record<string, unknown>).text) ?? "" : ""
    }
    const description = [sectionText("jobDescription"), sectionText("qualifications"), sectionText("additionalInformation")]
      .filter(Boolean).join("\n") || undefined
    return success(source, context.now, {
      httpStatus: page.status,
      finalUrl: page.finalUrl,
      description,
      sourceEvidence: evidence("description", description, "smartrecruiters_posting_api", 0.95),
      detailCompleteness: completenessFrom({ ...job, description: description ?? job.description } as NormalizedJob, description ?? ""),
      confidence: 0.95,
    }, description ?? "")
  } catch (error) {
    return classifyFetchError(error, source, context.now)
  }
}

export function defaultDetailAdapters(): Record<string, SourceDetailAdapter> {
  return {
    ...Object.fromEntries(Object.keys(CLI_DETAIL_SOURCES).map((source) => [source, cliDetailAdapter])),
    "jobgether-search": jobgetherAdapter,
    greenhouse: greenhouseAdapter,
    smartrecruiters: smartRecruitersAdapter,
  }
}

function shouldOverwriteDescription(job: NormalizedJob, enrichment: JobDetailEnrichment): boolean {
  if (!enrichment.description) return false
  if (textLength(job.description) === 0) return true
  const currentFull = isUsableFullJobDescription(job.description)
  const incomingFull = isUsableFullJobDescription(enrichment.description)
  if (currentFull && !incomingFull) return false
  if (incomingFull && !currentFull) return true
  return textLength(enrichment.description) > Math.max(400, textLength(job.description))
}

function shouldOverwriteLocation(job: NormalizedJob, enrichment: JobDetailEnrichment): boolean {
  if (!enrichment.location) return false
  return !text(job.location) || isVagueRemoteLocation(job.location) || text(enrichment.location).length > text(job.location).length + 10
}

function mergeArray(original: unknown, added: string[] | undefined): string[] | undefined {
  const values = [
    ...(Array.isArray(original) ? original.map(String) : []),
    ...(added ?? []),
  ].map((item) => item.trim()).filter(Boolean)
  return values.length ? [...new Set(values)] : undefined
}

export function applyEnrichment(job: NormalizedJob, enrichment: JobDetailEnrichment): NormalizedJob {
  if (enrichment.status !== "success") {
    return {
      ...job,
      metadata: {
        ...(job.metadata as Record<string, unknown> | undefined),
        detailEnrichment: enrichment,
      },
    }
  }
  const originalFields = {
    description: job.description,
    location: job.location,
    employmentType: job.employmentType,
    jobType: job.jobType,
    salary: job.salary,
    applicationUrl: job.applicationUrl,
  }
  const description = shouldOverwriteDescription(job, enrichment) ? enrichment.description : job.description
  const location = shouldOverwriteLocation(job, enrichment) ? enrichment.location : job.location
  const employmentType = job.employmentType ?? enrichment.employmentType
  const salary = job.salary ?? enrichment.salary ?? null
  const detailLocationIsScoped = hasExplicitLocationScope(enrichment.location)
  const allowedRegions = detailLocationIsScoped ? [] : enrichment.structured?.allowedRegions
  const allowedCountries = detailLocationIsScoped ? [] : enrichment.structured?.allowedCountries
  const locationRestrictions = mergeArray(job.locationRestrictions, [
    ...(allowedRegions ?? []),
    ...(allowedCountries ?? []),
    ...(enrichment.location ? [enrichment.location] : []),
  ])
  return {
    ...job,
    description,
    location,
    employmentType,
    salary,
    applicationUrl: job.applicationUrl ?? enrichment.applicationUrl,
    locationRestrictions,
    metadata: {
      ...(job.metadata as Record<string, unknown> | undefined),
      originalFields,
      detailEnrichment: enrichment,
      detailCompleteness: enrichment.detailCompleteness,
    },
  }
}

export function emptyEnrichmentStats(budget = 0): EnrichmentStats {
  return { ...emptySourceStats(), budget, bySource: {} }
}

function initStats(): EnrichmentStats {
  return emptyEnrichmentStats()
}

function bump(stats: EnrichmentStats, source: string, field: keyof Omit<EnrichmentStats, "bySource">): void {
  stats[field] = (stats[field] ?? 0) + 1
  stats.bySource[source] ??= emptySourceStats()
  stats.bySource[source][field] = (stats.bySource[source][field] ?? 0) + 1
}

function statField(status: EnrichmentStatus): "deferred" | "success" | "notNeeded" | "notSupported" | "notFound" | "failed" | "rateLimited" | "timeout" {
  if (status === "not_needed") return "notNeeded"
  if (status === "not_supported") return "notSupported"
  if (status === "not_found") return "notFound"
  if (status === "rate_limited") return "rateLimited"
  return status
}

async function defaultRunCommand(command: string, args: string[], timeoutMs = DETAIL_TIMEOUT_MS): Promise<CommandResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      resolvePromise({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut: false })
    })
  })
}

export async function enrichJobs(jobs: NormalizedJob[], options: EnrichmentOptions = {}): Promise<{ jobs: NormalizedJob[]; stats: EnrichmentStats }> {
  const now = options.now ?? new Date()
  const ttlMs = { ...DEFAULT_TTL_MS, ...(options.ttlMs ?? {}) }
  const cachePath = resolve(options.cachePath ?? DEFAULT_CACHE_PATH)
  const useCache = options.useCache !== false
  const cache = useCache ? await readCache(cachePath) : {}
  const adapters = options.adapters ?? defaultDetailAdapters()
  const stats = initStats()
  const output = jobs.map((job) => ({ ...job }))
  const maxJobs = Math.max(0, options.maxJobs ?? DEFAULT_MAX_JOBS)
  stats.budget = maxJobs
  const eligibleBySource = new Map<string, Array<{ job: NormalizedJob; index: number }>>()
  output.forEach((job, index) => {
    const source = sourceName(job) || "unknown"
    const group = eligibleBySource.get(source) ?? []
    group.push({ job, index })
    eligibleBySource.set(source, group)
    const counters = stats.bySource[source] ??= emptySourceStats()
    stats.considered += 1
    counters.considered += 1
    if (isUsableFullJobDescription(job.description)) {
      stats.candidatesAlreadyFull += 1
      counters.candidatesAlreadyFull += 1
    }
    if (needsEnrichment(job)) {
      stats.candidatesNeedingEnrichment += 1
      counters.candidatesNeedingEnrichment += 1
    }
  })
  // Round-robin sources while preserving each source's order.
  const sourceGroups = [...eligibleBySource.entries()]
  const eligibleIndexes: Array<{ job: NormalizedJob; index: number }> = []
  for (let round = 0; eligibleIndexes.length < output.length; round++) {
    for (const [, group] of sourceGroups) if (group[round]) eligibleIndexes.push(group[round])
  }
  let attemptedEligible = 0
  let cursor = 0
  const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 3))
  const context: DetailAdapterContext = {
    now,
    fetchImpl: options.fetchImpl,
    resolveHost: options.resolveHost,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    runCommand: defaultRunCommand,
  }

  async function processOne(job: NormalizedJob, index: number): Promise<void> {
    const source = sourceName(job) || "unknown"
    if (!needsEnrichment(job)) {
      const enrichment = terminal("not_needed", source, now, "job already has sufficient detail")
      output[index] = applyEnrichment(job, enrichment)
      bump(stats, source, "notNeeded")
      return
    }
    const cacheKey = enrichmentCacheKey(job)
    const cached = cache[cacheKey]
    if (cached && isFresh(cached, now, ttlMs)) {
      const enrichment = { ...cached, cacheHit: true }
      output[index] = applyEnrichment(job, enrichment)
      bump(stats, source, "cacheHits")
      bump(stats, source, statField(enrichment.status))
      return
    }
    const adapter = adapters[source]
    if (!adapter) {
      output[index] = applyEnrichment(job, terminal("not_supported", source, now, "source has no supported detail adapter"))
      bump(stats, source, "notSupported")
      return
    }
    if (attemptedEligible >= maxJobs) {
      output[index] = applyEnrichment(job, terminal("deferred", source, now, "live enrichment budget exhausted; retry on next run"))
      bump(stats, source, "deferred")
      return
    }
    attemptedEligible += 1
    bump(stats, source, "attempted")
    bump(stats, source, "selectedByBudget")
    const enrichment = { ...(await adapter(job, context)), cacheKey, cacheHit: false }
    output[index] = applyEnrichment(job, enrichment)
    bump(stats, source, statField(enrichment.status))
    if (useCache && enrichment.status !== "failed" && enrichment.status !== "timeout" && enrichment.status !== "rate_limited") {
      cache[cacheKey] = { ...enrichment, cacheKey, source, jobIdentity: cacheIdentity(job) }
    }
  }

  async function worker(): Promise<void> {
    while (cursor < eligibleIndexes.length) {
      const next = eligibleIndexes[cursor++]
      await processOne(next.job, next.index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, eligibleIndexes.length) }, () => worker()))
  output.forEach((job, index) => {
    const source = sourceName(job) || "unknown"
    if (isUsableFullJobDescription(job.description)) bump(stats, source, "fullAfterEnrichment")
    if (needsEnrichment(jobs[index]) && !isUsableFullJobDescription(job.description)) bump(stats, source, "stillInsufficient")
    const enrichment = (job.metadata as Record<string, unknown> | undefined)?.detailEnrichment as JobDetailEnrichment | undefined
    if (enrichment?.status === "failed") {
      const category = enrichment.failureKind === "parse" ? "parseFailed" : enrichment.httpStatus ? "httpFailed" : "otherFailed"
      bump(stats, source, category)
    }
  })
  if (useCache) await writeCache(cachePath, cache)
  return { jobs: output, stats }
}

export function formatEnrichmentSummary(stats: EnrichmentStats): string {
  const bySource = Object.entries(stats.bySource)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, value]) => `${source}: need=${value.candidatesNeedingEnrichment ?? Math.max(0, value.considered - value.notNeeded)}, selected=${value.selectedByBudget ?? value.attempted}, attempts=${value.attempted}, success=${value.success}, full=${value.fullAfterEnrichment ?? "?"}, deferred=${value.deferred ?? 0}, unsupported=${value.notSupported}, not_found=${value.notFound}, http=${value.httpFailed ?? 0}, parse=${value.parseFailed ?? 0}, other=${value.otherFailed ?? value.failed}, limited=${value.rateLimited}, timeout=${value.timeout}, unresolved=${value.stillInsufficient ?? "?"}`)
    .join("; ") || "none"
  return [
    `JD enrichment: entered=${stats.considered}; already_full=${stats.candidatesAlreadyFull ?? "unknown"}; need_detail=${stats.candidatesNeedingEnrichment ?? Math.max(0, stats.considered - stats.notNeeded)}; budget=${stats.budget ?? "unknown"}; selected=${stats.selectedByBudget ?? stats.attempted}; attempts=${stats.attempted}; deferred=${stats.deferred ?? 0}; adapter_success=${stats.success}; full_after=${stats.fullAfterEnrichment ?? "unknown"}; unresolved=${stats.stillInsufficient ?? "unknown"}.`,
    `Outcomes: not_found=${stats.notFound}, unsupported=${stats.notSupported}, rate_limited=${stats.rateLimited}, timeout=${stats.timeout}, http_failed=${stats.httpFailed ?? 0}, parse_failed=${stats.parseFailed ?? 0}, other_failed=${stats.otherFailed ?? stats.failed}.`,
    `By source: ${bySource}`,
  ].join("\n")
}
