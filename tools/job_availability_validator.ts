import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"
import { isIP } from "node:net"
import { readBoundedText, resolveSafeDestination, safeFetch, safeRedirectUrl, type HostResolver, type SafeHttpResponse } from "./safe_http"

export type ValidationStatus = "active" | "expired" | "uncertain" | "validation_failed"
export type ValidationMethod =
  | "explicit_expiry"
  | "ats_api"
  | "http_status"
  | "redirect"
  | "page_content"
  | "structured_data"
  | "source_detail"
  | "combined"

export interface AvailabilityValidation {
  status: ValidationStatus
  checkedAt: string
  method: ValidationMethod
  confidence: number
  reason?: string
  requestedUrl?: string
  finalUrl?: string
  httpStatus?: number
}

export interface NormalizedJob {
  id?: string | number
  title?: string | null
  company?: string | null
  url?: string | null
  applicationUrl?: string | null
  applyUrl?: string | null
  sourceUrl?: string | null
  canonicalUrl?: string | null
  deadline?: string | null
  validThrough?: string | null
  isActive?: boolean | null
  validation?: AvailabilityValidation
  [key: string]: unknown
}

interface FetchResponse {
  status: number
  statusText?: string
  headers: Headers
  body?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
  cancel?: () => void
}

export interface ValidatorOptions {
  now?: Date
  fetchImpl?: (url: string, init: RequestInit) => Promise<FetchResponse>
  resolveHost?: (hostname: string) => Promise<string[]>
  cachePath?: string
  useCache?: boolean
  verbose?: boolean
  maxRedirects?: number
  maxBodyBytes?: number
  /** Internal batch cache shared by validateJobs workers. */
  cacheStore?: Record<string, CacheRecord>
  /** Defer the shared cache write until the batch has completed. */
  deferCacheWrites?: boolean
}

export interface ValidationStats {
  total: number
  active: number
  expired: number
  uncertain: number
  validation_failed: number
  cacheHits: number
  networkValidations: number
}

type CacheRecord = AvailabilityValidation & { cacheKey: string }

const DEFAULT_CACHE_PATH = "job_scraper/availability_cache.json"
const USER_AGENT = "ai-job-search-availability-validator/1.0 (+https://github.com/MadsLorentzen/ai-job-search)"
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_BODY_BYTES = 512_000
const ACTIVE_TTL_MS = 18 * 60 * 60 * 1000
const UNCERTAIN_TTL_MS = 2 * 60 * 60 * 1000
const FAILED_TTL_MS = 60 * 60 * 1000
const EXPIRED_TTL_MS = 14 * 24 * 60 * 60 * 1000

const GENERIC_CAREERS_PATHS = new Set([
  "/careers",
  "/jobs",
  "/job-search",
  "/search-jobs",
  "/open-positions",
  "/vacancies",
])

const STRONG_EXPIRED_PATTERNS = [
  /this job is no longer available/i,
  /this position is no longer available/i,
  /this position has been filled/i,
  /job has expired/i,
  /this job has expired/i,
  /job posting has expired/i,
  /position has been filled/i,
  /applications are closed/i,
  /this vacancy is closed/i,
  /this vacancy has expired/i,
  /the role is no longer available/i,
  /job is no longer accepting applications/i,
  /no longer accepting applications/i,
  /the position is closed/i,
  /requisition is closed/i,
]

const APPLY_PATTERNS = [
  /\bapply now\b/i,
  /\bapply for this job\b/i,
  /\bsubmit application\b/i,
  /\bapplication form\b/i,
  /\bstart your application\b/i,
]

export function utcNow(date = new Date()): string {
  return date.toISOString()
}

function result(
  status: ValidationStatus,
  method: ValidationMethod,
  confidence: number,
  now: Date,
  extra: Omit<Partial<AvailabilityValidation>, "status" | "method" | "confidence" | "checkedAt"> = {},
): AvailabilityValidation {
  return {
    status,
    method,
    confidence: Math.max(0, Math.min(100, Math.round(confidence))),
    checkedAt: utcNow(now),
    ...extra,
  }
}

export function normalizeCacheUrl(raw: string): string {
  const url = new URL(raw)
  url.hash = ""
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|msclkid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key)
  }
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = ""
  }
  url.hostname = url.hostname.toLowerCase()
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1)
  url.searchParams.sort()
  return url.toString()
}

export function preferredValidationUrl(job: NormalizedJob): string | null {
  for (const key of ["applicationUrl", "applyUrl", "canonicalUrl", "url", "sourceUrl"] as const) {
    const value = job[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function parseDateEndOfDayUtc(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null
  const raw = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ms = Date.parse(`${raw}T23:59:59.999Z`)
    return Number.isFinite(ms) ? ms : null
  }
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

export function validateExplicitSignals(job: NormalizedJob, now = new Date()): AvailabilityValidation | null {
  if (job.isActive === false) {
    return result("expired", "source_detail", 100, now, { reason: "source detail marks the job inactive" })
  }
  for (const field of ["deadline", "validThrough"] as const) {
    const expiry = parseDateEndOfDayUtc(job[field])
    if (expiry !== null && expiry < now.getTime()) {
      return result("expired", "explicit_expiry", 100, now, { reason: `${field} is in the past` })
    }
  }
  return null
}

export async function assertSafeUrl(raw: string, resolveHost?: (hostname: string) => Promise<string[]>): Promise<URL> {
  return (await resolveSafeDestination(raw, resolveHost as HostResolver | undefined)).url
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname]
  return (await import("node:dns/promises")).lookup(hostname, { all: true, verbatim: true }).then((records) => records.map((record) => record.address))
}

function canonicalPath(pathname: string): string {
  const path = pathname.replace(/\/+$/g, "") || "/"
  const localeStripped = path.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, "")
  return localeStripped.replace(/\/+$/g, "") || "/"
}

export function isNormalizationRedirect(fromRaw: string, toRaw: string): boolean {
  const from = new URL(fromRaw)
  const to = new URL(toRaw)
  if (from.hostname.replace(/^www\./, "") !== to.hostname.replace(/^www\./, "")) return false
  const fromPath = canonicalPath(from.pathname)
  const toPath = canonicalPath(to.pathname)
  return fromPath === toPath || fromPath === toPath.replace(/\/apply$/i, "")
}

export function isGenericCareersRedirect(fromRaw: string, toRaw: string): boolean {
  if (isNormalizationRedirect(fromRaw, toRaw)) return false
  const from = new URL(fromRaw)
  const to = new URL(toRaw)
  const fromPath = canonicalPath(from.pathname)
  const toPath = canonicalPath(to.pathname)
  if (fromPath === toPath) return false
  const fromLooksSpecific = /\/(job|jobs|careers|positions|openings|vacancies|requisition|apply)\//i.test(fromPath) && /[0-9a-f]{4,}|[a-z0-9]+-[a-z0-9-]+/i.test(fromPath)
  if (!fromLooksSpecific) return false
  return GENERIC_CAREERS_PATHS.has(toPath) || /^\/(?:[a-z]{2}\/)?(?:careers|jobs)\/?$/i.test(to.pathname)
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, (_entity, name: string) => ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name.toLowerCase() as "nbsp" | "amp" | "lt" | "gt" | "quot" | "#39"])
}

export function visibleText(html: string): string {
  return decodeEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim()
}

export function containsExpiredPhrase(text: string): string | null {
  for (const pattern of STRONG_EXPIRED_PATTERNS) {
    const match = text.match(pattern)
    if (match) return match[0]
  }
  return null
}

function titleWords(title: string | null | undefined): string[] {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !["and", "the", "for", "with", "remote"].includes(word))
}

function titleMatches(title: string | null | undefined, text: string): boolean {
  const words = titleWords(title)
  if (words.length === 0) return false
  const lower = text.toLowerCase()
  const hits = words.filter((word) => lower.includes(word)).length
  return hits / words.length >= 0.6
}

function companyMatches(company: string | null | undefined, text: string): boolean {
  if (!company) return false
  return text.toLowerCase().includes(company.toLowerCase())
}

function hasApplySignal(htmlOrText: string): boolean {
  return APPLY_PATTERNS.some((pattern) => pattern.test(htmlOrText)) || /<button[^>]*>[^<]*apply/i.test(htmlOrText) || /<a[^>]+href=["'][^"']*(?:apply|application)[^"']*["']/i.test(htmlOrText)
}

function findJobPostings(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap(findJobPostings)
  const obj = value as Record<string, unknown>
  const type = obj["@type"]
  const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")]
  const here = types.some((item) => item.toLowerCase() === "jobposting") ? [obj] : []
  const graph = Array.isArray(obj["@graph"]) ? obj["@graph"].flatMap(findJobPostings) : []
  return [...here, ...graph]
}

export function extractJobPostingJsonLd(html: string): Record<string, unknown>[] {
  const blocks = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
  const postings: Record<string, unknown>[] = []
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(decodeEntities(block[1].trim()))
      postings.push(...findJobPostings(parsed).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))))
    } catch {
      continue
    }
  }
  return postings
}

export function classifyHtml(job: NormalizedJob, html: string, now = new Date()): AvailabilityValidation {
  const postings = extractJobPostingJsonLd(html)
  const text = visibleText(html)
  const requestedUrl = preferredValidationUrl(job) ?? undefined
  for (const posting of postings) {
    const titleOk = titleMatches(job.title, String(posting.title ?? ""))
    const company = posting.hiringOrganization
    const orgName = company && typeof company === "object" ? String((company as Record<string, unknown>).name ?? "") : ""
    const companyOk = companyMatches(job.company, orgName) || !job.company
    const validThrough = parseDateEndOfDayUtc(posting.validThrough)
    if (validThrough !== null && validThrough < now.getTime() && (titleOk || companyOk)) {
      return result("expired", "structured_data", 100, now, { reason: "JobPosting validThrough is in the past", requestedUrl })
    }
    if (validThrough !== null && validThrough >= now.getTime() && titleOk && companyOk) {
      return result("active", "structured_data", 90, now, { reason: "matching JobPosting JSON-LD with future validThrough", requestedUrl })
    }
    if (titleOk && companyOk && validThrough === null) {
      return result("active", "structured_data", 85, now, { reason: "matching JobPosting JSON-LD", requestedUrl })
    }
  }
  const expiredPhrase = containsExpiredPhrase(text)
  if (expiredPhrase) {
    return result("expired", "page_content", 95, now, { reason: `page says: ${expiredPhrase}`, requestedUrl })
  }
  const titleOk = titleMatches(job.title, text)
  const companyOk = companyMatches(job.company, text)
  const applyOk = hasApplySignal(html) || hasApplySignal(text)
  if (titleOk && (companyOk || applyOk) && applyOk) {
    return result("active", "page_content", 78, now, { reason: "page matches title/company and has apply signal", requestedUrl })
  }
  if (titleOk || companyOk || applyOk) {
    return result("uncertain", "page_content", 55, now, { reason: "weak job-page evidence", requestedUrl })
  }
  return result("uncertain", "page_content", 45, now, { reason: "generic 200 page without clear job evidence", requestedUrl })
}

export interface AtsInfo {
  provider: "greenhouse" | "lever" | "ashby" | "smartrecruiters"
  apiUrl: string
}

export function detectAts(urlRaw: string): AtsInfo | null {
  let url: URL
  try {
    url = new URL(urlRaw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const match = url.pathname.match(/^\/([^/]+)\/jobs\/([^/?#]+)/)
    if (match) return { provider: "greenhouse", apiUrl: `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs/${match[2]}` }
  }
  if (host === "jobs.lever.co") {
    const match = url.pathname.match(/^\/([^/]+)\/([^/?#]+)/)
    if (match) return { provider: "lever", apiUrl: `https://api.lever.co/v0/postings/${match[1]}/${match[2]}` }
  }
  if (host === "jobs.ashbyhq.com") {
    const match = url.pathname.match(/^\/([^/]+)\/([^/?#]+)/)
    if (match) return { provider: "ashby", apiUrl: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting&variables=${encodeURIComponent(JSON.stringify({ organizationHostedJobsPageName: match[1], jobPostingId: match[2] }))}` }
  }
  if (host === "careers.smartrecruiters.com") {
    const match = url.pathname.match(/^\/([^/]+)\/([^/?#]+)/)
    if (match) return { provider: "smartrecruiters", apiUrl: `https://api.smartrecruiters.com/v1/companies/${match[1]}/postings/${match[2]}` }
  }
  return null
}

function deepFindKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindKey(item, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  const obj = value as Record<string, unknown>
  if (Object.hasOwn(obj, key)) return obj[key]
  for (const child of Object.values(obj)) {
    const found = deepFindKey(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

function atsPositiveEvidence(provider: AtsInfo["provider"], body: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body.trim().length > 0 && !containsExpiredPhrase(visibleText(body))
  }
  if (!parsed || typeof parsed !== "object") return false
  const obj = parsed as Record<string, unknown>
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return false
  if (provider === "ashby") {
    const posting = deepFindKey(parsed, "jobPosting")
    return Boolean(posting && typeof posting === "object")
  }
  if (provider === "greenhouse") return typeof obj.id !== "undefined" && typeof obj.title === "string"
  if (provider === "lever") return typeof obj.id === "string" && typeof obj.text === "string"
  if (provider === "smartrecruiters") return typeof obj.id === "string" && typeof obj.name === "string"
  return false
}

function atsMissingEvidence(provider: AtsInfo["provider"], body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    const phrase = containsExpiredPhrase(visibleText(body))
    return phrase ? `ATS page says: ${phrase}` : null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  const messages = Array.isArray(obj.errors)
    ? obj.errors.map((error) => error && typeof error === "object" ? String((error as Record<string, unknown>).message ?? "") : String(error)).filter(Boolean)
    : []
  const joined = messages.join("; ")
  if (/not found|no longer available|does not exist|job posting.*closed|posting.*closed/i.test(joined)) {
    return `${provider} API says posting is missing or closed: ${joined}`
  }
  if (provider === "ashby" && messages.length > 0 && deepFindKey(parsed, "jobPosting") === undefined) {
    return "ashby API returned errors instead of a jobPosting payload"
  }
  if (provider === "ashby" && deepFindKey(parsed, "jobPosting") === null) {
    return "ashby API returned no jobPosting payload"
  }
  return null
}

async function fetchWithRedirects(urlRaw: string, options: Required<Pick<ValidatorOptions, "resolveHost" | "maxRedirects" | "maxBodyBytes">> & Pick<ValidatorOptions, "fetchImpl">): Promise<{ response: FetchResponse; finalUrl: string; redirected: boolean; body: string }> {
  let current = urlRaw
  for (let i = 0; i <= options.maxRedirects; i++) {
    const response = await safeFetch(current, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    }, options.resolveHost, options.fetchImpl as ((url: string, init: RequestInit) => Promise<SafeHttpResponse>) | undefined) as FetchResponse
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      if (!location) {
        response.cancel?.()
        return { response, finalUrl: current, redirected: current !== urlRaw, body: "" }
      }
      const next = safeRedirectUrl(current, location).toString()
      response.cancel?.()
      current = next
      continue
    }
    const body = await readBoundedText(response, options.maxBodyBytes)
    return { response, finalUrl: current, redirected: current !== urlRaw, body }
  }
  throw new Error("too many redirects")
}

function ttlFor(status: ValidationStatus): number {
  if (status === "active") return ACTIVE_TTL_MS
  if (status === "expired") return EXPIRED_TTL_MS
  if (status === "uncertain") return UNCERTAIN_TTL_MS
  return FAILED_TTL_MS
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
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, "utf8")
  await rename(temporary, path)
}

export async function validateJobAvailability(job: NormalizedJob, options: ValidatorOptions = {}): Promise<{ validation: AvailabilityValidation; cacheHit: boolean; networkValidation: boolean }> {
  const now = options.now ?? new Date()
  const explicit = validateExplicitSignals(job, now)
  if (explicit) return { validation: explicit, cacheHit: false, networkValidation: false }
  const rawUrl = preferredValidationUrl(job)
  if (!rawUrl) return { validation: result("validation_failed", "http_status", 20, now, { reason: "no URL to validate" }), cacheHit: false, networkValidation: false }
  let cacheKey: string
  try {
    cacheKey = normalizeCacheUrl(rawUrl)
  } catch (error) {
    return { validation: result("validation_failed", "http_status", 20, now, { reason: error instanceof Error ? error.message : "invalid URL", requestedUrl: rawUrl }), cacheHit: false, networkValidation: false }
  }
  const cachePath = resolve(options.cachePath ?? DEFAULT_CACHE_PATH)
  const useCache = options.useCache !== false
  const cache = useCache ? options.cacheStore ?? await readCache(cachePath) : {}
  const persistCache = async () => {
    if (useCache && !options.deferCacheWrites) await writeCache(cachePath, cache)
  }
  const cached = cache[cacheKey]
  if (cached && Date.parse(cached.checkedAt) + ttlFor(cached.status) > now.getTime()) {
    return { validation: cached, cacheHit: true, networkValidation: false }
  }

  const resolveHost = options.resolveHost ?? defaultResolveHost
  const requiredOptions = {
    resolveHost,
    fetchImpl: options.fetchImpl,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  }

  const ats = detectAts(rawUrl)
  if (ats) {
    try {
      const atsFetch = await fetchWithRedirects(ats.apiUrl, requiredOptions)
      const { response, body } = atsFetch
      if (response.status === 404 || response.status === 410) {
        const validation = result("expired", "ats_api", 100, now, { reason: `${ats.provider} API returned ${response.status}`, requestedUrl: rawUrl, finalUrl: ats.apiUrl, httpStatus: response.status })
        cache[cacheKey] = { ...validation, cacheKey }
        await persistCache()
        return { validation, cacheHit: false, networkValidation: true }
      }
      const missingReason = atsMissingEvidence(ats.provider, body)
      if (missingReason) {
        const validation = result("expired", "ats_api", ats.provider === "ashby" ? 90 : 100, now, { reason: missingReason, requestedUrl: rawUrl, finalUrl: ats.apiUrl, httpStatus: response.status })
        cache[cacheKey] = { ...validation, cacheKey }
        await persistCache()
        return { validation, cacheHit: false, networkValidation: true }
      }
      if (response.status >= 200 && response.status < 300 && atsPositiveEvidence(ats.provider, body)) {
        const validation = result("active", "ats_api", 100, now, { reason: `${ats.provider} API confirms posting exists`, requestedUrl: rawUrl, finalUrl: ats.apiUrl, httpStatus: response.status })
        cache[cacheKey] = { ...validation, cacheKey }
        await persistCache()
        return { validation, cacheHit: false, networkValidation: true }
      }
      if (response.status >= 200 && response.status < 300) {
        return { validation: result("validation_failed", "ats_api", 30, now, { reason: `${ats.provider} API returned no recognizable job payload`, requestedUrl: rawUrl, finalUrl: ats.apiUrl, httpStatus: response.status }), cacheHit: false, networkValidation: true }
      }
      if (response.status === 429 || response.status === 403 || response.status >= 500) {
        return { validation: result("validation_failed", "ats_api", 25, now, { reason: `${ats.provider} API returned ${response.status}`, requestedUrl: rawUrl, finalUrl: ats.apiUrl, httpStatus: response.status }), cacheHit: false, networkValidation: true }
      }
    } catch {
      // Fall back to the public page; do not classify ATS transient failures as expired.
    }
  }

  try {
    const page = await fetchWithRedirects(rawUrl, requiredOptions)
    const { response, finalUrl, redirected, body } = page
    if (response.status === 404 || response.status === 410) {
      const validation = result("expired", "http_status", 95, now, { reason: `HTTP ${response.status}`, requestedUrl: rawUrl, finalUrl, httpStatus: response.status })
      cache[cacheKey] = { ...validation, cacheKey }
      await persistCache()
      return { validation, cacheHit: false, networkValidation: true }
    }
    if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
      const validation = result("validation_failed", "http_status", 25, now, { reason: `HTTP ${response.status}`, requestedUrl: rawUrl, finalUrl, httpStatus: response.status })
      if (useCache) {
        cache[cacheKey] = { ...validation, cacheKey }
        await persistCache()
      }
      return { validation, cacheHit: false, networkValidation: true }
    }
    if (redirected && isGenericCareersRedirect(rawUrl, finalUrl)) {
      const validation = result("expired", "redirect", 92, now, { reason: "job-specific URL redirected to generic careers page", requestedUrl: rawUrl, finalUrl, httpStatus: response.status })
      cache[cacheKey] = { ...validation, cacheKey }
      await persistCache()
      return { validation, cacheHit: false, networkValidation: true }
    }
    const validation = { ...classifyHtml(job, body, now), requestedUrl: rawUrl, finalUrl, httpStatus: response.status }
    cache[cacheKey] = { ...validation, cacheKey }
    await persistCache()
    return { validation, cacheHit: false, networkValidation: true }
  } catch (error) {
    const validation = result("validation_failed", "http_status", 20, now, { reason: error instanceof Error ? error.message : "validation failed", requestedUrl: rawUrl })
    if (useCache) {
      cache[cacheKey] = { ...validation, cacheKey }
      await persistCache()
    }
    return { validation, cacheHit: false, networkValidation: true }
  }
}

export async function validateJobs(jobs: NormalizedJob[], options: ValidatorOptions & { concurrency?: number; includeUnvalidated?: boolean } = {}): Promise<{ results: NormalizedJob[]; all: NormalizedJob[]; stats: ValidationStats }> {
  const stats: ValidationStats = { total: jobs.length, active: 0, expired: 0, uncertain: 0, validation_failed: 0, cacheHits: 0, networkValidations: 0 }
  const concurrency = Math.max(1, Math.min(10, options.concurrency ?? 6))
  const cachePath = resolve(options.cachePath ?? DEFAULT_CACHE_PATH)
  const useCache = options.useCache !== false
  const cacheStore = useCache ? await readCache(cachePath) : undefined
  const batchOptions = cacheStore
    ? { ...options, cacheStore, deferCacheWrites: true }
    : options
  const all = jobs.map((job) => ({ ...job }))
  let next = 0
  async function worker(): Promise<void> {
    while (next < all.length) {
      const index = next++
      const checked = await validateJobAvailability(all[index], batchOptions)
      all[index].validation = checked.validation
      stats[checked.validation.status] += 1
      if (checked.cacheHit) stats.cacheHits += 1
      if (checked.networkValidation) stats.networkValidations += 1
      if (options.verbose) {
        process.stderr.write(`[validation] ${checked.validation.status} via ${checked.validation.method}: ${checked.validation.reason ?? all[index].url ?? ""}\n`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, all.length) }, () => worker()))
  if (cacheStore) await writeCache(cachePath, cacheStore)
  const results = all.filter((job) => job.validation?.status !== "expired")
  return { results, all, stats }
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
    if (["format", "cache", "input", "concurrency", "title", "company"].includes(key)) {
      parsed[key] = argv[++i]
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  const format = args.format === "plain" ? "plain" : "json"
  const common = { cachePath: typeof args.cache === "string" ? args.cache : DEFAULT_CACHE_PATH, useCache: args["no-cache"] !== true, verbose: args.verbose === true }
  if (command === "validate") {
    const url = args._[1]
    if (!url) throw new Error("usage: bun run tools/job_availability_validator.ts validate <url> [--format json|plain]")
    const checked = await validateJobAvailability({ url, title: args.title as string | undefined, company: args.company as string | undefined }, common)
    process.stdout.write(format === "plain" ? `${checked.validation.status} (${checked.validation.confidence}) ${checked.validation.reason ?? ""}\n` : `${JSON.stringify(checked.validation, null, 2)}\n`)
    return 0
  }
  if (command === "validate-file") {
    const input = typeof args.input === "string" ? args.input : args._[1]
    if (!input) throw new Error("usage: bun run tools/job_availability_validator.ts validate-file <jobs.json> [--include-unvalidated] [--format json]")
    const data = JSON.parse(await readFile(input, "utf8"))
    const jobs = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : []
    const output = await validateJobs(jobs, { ...common, includeUnvalidated: args["include-unvalidated"] === true, concurrency: args.concurrency ? Number(args.concurrency) : undefined })
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return 0
  }
  process.stderr.write("usage: validate <url> | validate-file <jobs.json>\n")
  return 2
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
