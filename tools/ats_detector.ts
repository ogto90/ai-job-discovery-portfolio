import { readFile } from "node:fs/promises"
import {
  DEFAULT_REGISTRY_PATH,
  JsonCompanyRegistry,
  normalizeCompanyName,
  nowIso,
  type AtsEvidence,
  type AtsEvidenceType,
  type AtsMapping,
  type AtsProvider,
  type AtsStatus,
  type CompanyRecord,
  type JobObservation,
} from "./company_registry"
import { readBoundedText, safeFetch, safeRedirectUrl, type SafeHttpResponse } from "./safe_http"

interface FetchResponse {
  status: number
  statusText?: string
  headers: Headers
  body?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
  cancel?: () => void
}

export interface AtsCandidate {
  provider: AtsProvider
  identifier: string
  boardUrl: string
  apiUrl: string
  evidence: AtsEvidence[]
}

interface ProviderValidation {
  status: "valid" | "invalid" | "validation_failed"
  httpStatus?: number
  reason: string
  names: string[]
  jobsCount?: number | null
  apiUrl: string
}

export interface AtsDetectorOptions {
  registryPath?: string
  fetchImpl?: (url: string, init: RequestInit) => Promise<FetchResponse>
  resolveHost?: (hostname: string) => Promise<string[]>
  now?: Date
  force?: boolean
  onlyCandidates?: boolean
  onlyUnknown?: boolean
  includeUnknown?: boolean
  limit?: number
  provider?: AtsProvider
  concurrency?: number
  maxBodyBytes?: number
  verbose?: boolean
  slugProbes?: boolean
  save?: boolean
}

export interface AtsRunStats {
  companiesExamined: number
  existingAtsCandidates: number
  existingAtsMappings: number
  candidatesValidated: number
  verifiedMappings: number
  invalidCandidates: number
  validationFailures: number
  identityMismatches: number
  unknownCompaniesProcessed: number
  newCandidatesDiscovered: number
  newMappingsVerified: number
  skippedFresh: number
  providers: Record<string, number>
  confidence: Record<string, number>
  errors: Array<{ companyId: string; company: string; error: string }>
}

interface ResolveOutcome {
  companyId: string
  company: string
  action: "skipped" | "verified" | "candidate" | "invalid" | "validation_failed" | "unknown"
  provider?: AtsProvider | null
  identifier?: string | null
  confidence?: number | null
  reason?: string
  ats?: AtsMapping
}

const USER_AGENT = "ai-job-search-ats-detector/1.0 (+https://github.com/MadsLorentzen/ai-job-search)"
const DEFAULT_MAX_BODY_BYTES = 512_000
const VERIFIED_REVALIDATE_MS = 60 * 24 * 60 * 60 * 1000
const CANDIDATE_RETRY_MS = 14 * 24 * 60 * 60 * 1000
const FAILURE_RETRY_MS = 2 * 24 * 60 * 60 * 1000
const INVALID_RETRY_MS = 90 * 24 * 60 * 60 * 1000

const ATS_HOSTS = new Set([
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "careers.smartrecruiters.com",
])

const AGGREGATOR_HOSTS = new Set([
  "linkedin.com",
  "himalayas.app",
  "remotive.com",
  "jobgether.com",
  "weworkremotely.com",
  "euremotejobs.com",
  "infosecjobboard.com",
  "arbeitnow.com",
  "remoteok.com",
  "dailyremote.com",
  "freehire.me",
  "adzuna.com",
  "www.adzuna.com",
  "api.adzuna.com",
  "adzuna.at",
  "www.adzuna.at",
  "adzuna.de",
  "www.adzuna.de",
  "adzuna.co.uk",
  "www.adzuna.co.uk",
  "jobnet.dk",
  "jobindex.dk",
  "jobbank.dk",
  "jobdanmark.dk",
  "wellfound.com",
])

function emptyStats(): AtsRunStats {
  return {
    companiesExamined: 0,
    existingAtsCandidates: 0,
    existingAtsMappings: 0,
    candidatesValidated: 0,
    verifiedMappings: 0,
    invalidCandidates: 0,
    validationFailures: 0,
    identityMismatches: 0,
    unknownCompaniesProcessed: 0,
    newCandidatesDiscovered: 0,
    newMappingsVerified: 0,
    skippedFresh: 0,
    providers: {},
    confidence: {},
    errors: [],
  }
}

function evidence(type: AtsEvidenceType, url: string | null, detail: string, now: string): AtsEvidence {
  return { type, url, detail, observedAt: now }
}

function uniqueEvidence(items: AtsEvidence[] = []): AtsEvidence[] {
  const seen = new Set<string>()
  const unique: AtsEvidence[] = []
  for (const item of items) {
    const key = `${item.type}|${item.url ?? ""}|${item.detail ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
    if (unique.length >= 25) break
  }
  return unique
}

export function providerBoardUrl(provider: AtsProvider, identifier: string): string {
  if (provider === "greenhouse") return `https://boards.greenhouse.io/${identifier}`
  if (provider === "lever") return `https://jobs.lever.co/${identifier}`
  if (provider === "ashby") return `https://jobs.ashbyhq.com/${identifier}`
  if (provider === "smartrecruiters") return `https://careers.smartrecruiters.com/${identifier}`
  return `https://${identifier}.jobs.personio.de`
}

export function providerApiUrl(provider: AtsProvider, identifier: string): string {
  if (provider === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${identifier}/jobs?content=false`
  if (provider === "lever") return `https://api.lever.co/v0/postings/${identifier}?mode=json`
  if (provider === "ashby") return `https://api.ashbyhq.com/posting-api/job-board/${identifier}`
  if (provider === "smartrecruiters") return `https://api.smartrecruiters.com/v1/companies/${identifier}/postings`
  return `https://${identifier}.jobs.personio.de/xml?language=en`
}

function cleanIdentifier(value: string): string {
  return decodeURIComponent(value).trim().replace(/\/+$/g, "")
}

function isAggregator(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "")
  return AGGREGATOR_HOSTS.has(host) || host.endsWith(".linkedin.com")
}

export function parseAtsUrl(urlRaw: string, type: AtsEvidenceType = "job_url", now = nowIso()): AtsCandidate | null {
  let url: URL
  try {
    url = new URL(urlRaw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  if (isAggregator(host)) return null
  let provider: AtsProvider | null = null
  let identifier: string | null = null
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    provider = "greenhouse"
    identifier = url.pathname.split("/").filter(Boolean)[0] ?? null
  } else if (host === "jobs.lever.co") {
    provider = "lever"
    identifier = url.pathname.split("/").filter(Boolean)[0] ?? null
  } else if (host === "jobs.ashbyhq.com") {
    provider = "ashby"
    identifier = url.pathname.split("/").filter(Boolean)[0] ?? null
  } else if (host === "careers.smartrecruiters.com") {
    provider = "smartrecruiters"
    identifier = url.pathname.split("/").filter(Boolean)[0] ?? null
  } else {
    const personio = host.match(/^([a-z0-9-]+)\.jobs\.personio\.de$/i)
    if (personio) {
      provider = "personio"
      identifier = personio[1]
    }
  }
  if (!provider || !identifier) return null
  const cleaned = cleanIdentifier(identifier)
  return {
    provider,
    identifier: cleaned,
    boardUrl: providerBoardUrl(provider, cleaned),
    apiUrl: providerApiUrl(provider, cleaned),
    evidence: [evidence(type, urlRaw, `ATS ${provider} URL observed`, now)],
  }
}

function mappingFromCandidate(candidate: AtsCandidate, status: AtsStatus, confidence: number | null, now: string, reason?: string): AtsMapping {
  return {
    provider: candidate.provider,
    identifier: candidate.identifier,
    boardUrl: candidate.boardUrl,
    apiUrl: candidate.apiUrl,
    verified: status === "verified",
    confidence,
    discoveredFrom: candidate.evidence[0]?.type ?? null,
    evidence: uniqueEvidence(candidate.evidence),
    firstDetected: now,
    lastVerified: status === "verified" ? now : null,
    lastAttempted: now,
    failureReason: status === "verified" || status === "candidate" ? null : reason ?? null,
    status,
  }
}

function candidateFromMapping(mapping: AtsMapping, now: string): AtsCandidate | null {
  if (!mapping.provider || !mapping.identifier) return null
  return {
    provider: mapping.provider,
    identifier: mapping.identifier,
    boardUrl: mapping.boardUrl ?? providerBoardUrl(mapping.provider, mapping.identifier),
    apiUrl: providerApiUrl(mapping.provider, mapping.identifier),
    evidence: mapping.evidence?.length
      ? mapping.evidence
      : [evidence((mapping.discoveredFrom as AtsEvidenceType) || "job_url", mapping.boardUrl ?? null, "existing registry ATS candidate", now)],
  }
}

function dueForAttempt(mapping: AtsMapping, nowMs: number, force = false): boolean {
  if (force) return true
  const attempted = mapping.lastAttempted ?? mapping.lastVerified
  if (!attempted) return true
  const age = nowMs - Date.parse(attempted)
  if (mapping.status === "verified") return age >= VERIFIED_REVALIDATE_MS
  if (mapping.status === "candidate") return age >= CANDIDATE_RETRY_MS
  if (mapping.status === "validation_failed") return age >= FAILURE_RETRY_MS
  if (mapping.status === "invalid") return age >= INVALID_RETRY_MS
  return true
}

function scoreNameMatch(company: CompanyRecord, names: string[], identifier: string): number {
  const companyNames = [company.canonicalName, ...company.aliases].map(normalizeCompanyName).filter(Boolean)
  const normalizedIdentifier = normalizeCompanyName(identifier.replace(/[-_]/g, " "))
  let best = 0
  for (const candidate of [normalizedIdentifier, ...names.map(normalizeCompanyName)]) {
    if (!candidate) continue
    if (companyNames.includes(candidate)) best = Math.max(best, 100)
    for (const companyName of companyNames) {
      if (companyName && candidate && (companyName.includes(candidate) || candidate.includes(companyName))) {
        best = Math.max(best, 82)
      }
      const compactCompany = companyName.replace(/\s+/g, "")
      const compactCandidate = candidate.replace(/\s+/g, "")
      if (compactCompany && compactCandidate && compactCompany === compactCandidate) best = Math.max(best, 95)
    }
  }
  return best
}

function hasDirectEvidence(candidate: AtsCandidate): boolean {
  return candidate.evidence.some((item) => item.type === "job_url" || item.type === "application_url")
}

function hasCareersEvidence(candidate: AtsCandidate): boolean {
  return candidate.evidence.some((item) => item.type === "careers_page" || item.type === "embedded_link" || item.type === "iframe" || item.type === "script" || item.type === "jsonld")
}

function identityConfidence(company: CompanyRecord, candidate: AtsCandidate, validation: ProviderValidation): { confidence: number; reason: string; mismatch: boolean } {
  if (validation.status !== "valid") return { confidence: 0, reason: validation.reason, mismatch: false }
  const nameScore = scoreNameMatch(company, validation.names, candidate.identifier)
  if (nameScore < 70 && validation.names.length > 0 && !hasDirectEvidence(candidate) && !hasCareersEvidence(candidate)) {
    return { confidence: 55, reason: "ATS endpoint exists but company identity did not match strongly", mismatch: true }
  }
  if (hasDirectEvidence(candidate) && nameScore >= 70) return { confidence: 100, reason: "direct ATS job URL validates and identity matches", mismatch: false }
  if (hasDirectEvidence(candidate) && validation.names.length === 0) return { confidence: 78, reason: "direct ATS job URL validates, but endpoint has no company metadata", mismatch: false }
  if (hasCareersEvidence(candidate) && nameScore >= 70) return { confidence: 95, reason: "careers page links to ATS board and identity matches", mismatch: false }
  if (hasCareersEvidence(candidate) && validation.names.length === 0) return { confidence: 85, reason: "careers page links to validated ATS board", mismatch: false }
  if (nameScore >= 90) return { confidence: 85, reason: "ATS endpoint validates and metadata strongly matches company", mismatch: false }
  if (nameScore >= 70) return { confidence: 78, reason: "ATS endpoint validates with medium identity evidence", mismatch: false }
  return { confidence: 55, reason: "ATS endpoint exists with weak identity evidence", mismatch: false }
}

async function fetchText(urlRaw: string, options: Pick<AtsDetectorOptions, "fetchImpl" | "resolveHost" | "maxBodyBytes"> & { maxBodyBytes: number }): Promise<{ status: number; body: string; finalUrl: string }> {
  let current = urlRaw
  for (let i = 0; i < 5; i++) {
    const response = await safeFetch(current, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.5" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    }, options.resolveHost, options.fetchImpl as ((url: string, init: RequestInit) => Promise<SafeHttpResponse>) | undefined) as FetchResponse
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      if (!location) {
        response.cancel?.()
        return { status: response.status, body: "", finalUrl: current }
      }
      const next = safeRedirectUrl(current, location).toString()
      response.cancel?.()
      current = next
      continue
    }
    return { status: response.status, body: await readBoundedText(response, options.maxBodyBytes), finalUrl: current }
  }
  throw new Error("too many redirects")
}

function deepStrings(value: unknown, keys: string[] = []): string[] {
  if (!value || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap((item) => deepStrings(item, keys))
  const obj = value as Record<string, unknown>
  const out: string[] = []
  for (const [key, child] of Object.entries(obj)) {
    if (typeof child === "string" && keys.includes(key)) out.push(child)
    else if (child && typeof child === "object") out.push(...deepStrings(child, keys))
  }
  return out
}

function validationStatusFromHttp(provider: AtsProvider, status: number): ProviderValidation["status"] {
  if (status === 404 || status === 410) return provider === "personio" ? "validation_failed" : "invalid"
  if (status === 429 || status >= 500) return "validation_failed"
  if (status === 401 || status === 403 || status >= 400) return "invalid"
  return "valid"
}

export async function validateAtsCandidate(candidate: AtsCandidate, options: AtsDetectorOptions = {}): Promise<ProviderValidation> {
  const resolveHost = options.resolveHost
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  let lastFailure: ProviderValidation | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchText(candidate.apiUrl, { fetchImpl: options.fetchImpl, resolveHost, maxBodyBytes })
      const status = validationStatusFromHttp(candidate.provider, response.status)
      if (status === "validation_failed" && (response.status === 429 || response.status >= 500) && attempt === 0) {
        lastFailure = { status, httpStatus: response.status, reason: `${candidate.provider} API returned ${response.status}`, names: [], jobsCount: null, apiUrl: candidate.apiUrl }
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      if (status !== "valid") {
        return { status, httpStatus: response.status, reason: `${candidate.provider} API returned ${response.status}`, names: [], jobsCount: null, apiUrl: candidate.apiUrl }
      }
      return parseProviderBody(candidate, response.body, response.status)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (attempt === 0) {
        lastFailure = { status: "validation_failed", reason, names: [], jobsCount: null, apiUrl: candidate.apiUrl }
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      return lastFailure ?? { status: "validation_failed", reason, names: [], jobsCount: null, apiUrl: candidate.apiUrl }
    }
  }
  return lastFailure ?? { status: "validation_failed", reason: "unknown validation failure", names: [], jobsCount: null, apiUrl: candidate.apiUrl }
}

function parseProviderBody(candidate: AtsCandidate, body: string, httpStatus: number): ProviderValidation {
  if (candidate.provider === "personio") {
    if (!/<position\b/i.test(body)) {
      return { status: "validation_failed", httpStatus, reason: "Personio feed did not contain positions", names: [], jobsCount: null, apiUrl: candidate.apiUrl }
    }
    const names = [...body.matchAll(/<company>([^<]+)<\/company>/gi)].map((m) => m[1])
    const jobsCount = (body.match(/<position\b/gi) ?? []).length
    return { status: "valid", httpStatus, reason: "Personio XML feed contains positions", names, jobsCount, apiUrl: candidate.apiUrl }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { status: "validation_failed", httpStatus, reason: "ATS API returned non-JSON body", names: [], jobsCount: null, apiUrl: candidate.apiUrl }
  }
  if (!parsed || typeof parsed !== "object") {
    return { status: "validation_failed", httpStatus, reason: "ATS API returned empty body", names: [], jobsCount: null, apiUrl: candidate.apiUrl }
  }
  const companyNames = (values: string[]) => values.filter((name) => {
    const clean = name.trim()
    if (!clean || /^(remote|hybrid|on[ -]?site|workplace type)$/i.test(clean)) return false
    return !/\b(engineer|engineering|developer|analyst|manager|specialist|architect|consultant|officer|director|administrator|scientist|designer|recruiter|accountant|coordinator|executive)\b/i.test(clean)
  })
  if (candidate.provider === "greenhouse") {
    const obj = parsed as Record<string, unknown>
    const jobs = Array.isArray(obj.jobs) ? obj.jobs : []
    const names = companyNames(deepStrings(parsed, ["name", "company_name", "companyName"]))
    return { status: "valid", httpStatus, reason: "Greenhouse board API returned jobs collection", names, jobsCount: jobs.length, apiUrl: candidate.apiUrl }
  }
  if (candidate.provider === "lever") {
    const jobs = Array.isArray(parsed) ? parsed : []
    const names = companyNames(deepStrings(parsed, ["company", "team", "workplaceType"]))
    return { status: "valid", httpStatus, reason: "Lever postings API returned jobs collection", names, jobsCount: jobs.length, apiUrl: candidate.apiUrl }
  }
  if (candidate.provider === "ashby") {
    const obj = parsed as Record<string, unknown>
    const jobs = Array.isArray(obj.jobs) ? obj.jobs : []
    const names = companyNames(deepStrings(parsed, ["organizationName", "organization", "companyName", "name"]))
    if (!Array.isArray(obj.jobs)) return { status: "validation_failed", httpStatus, reason: "Ashby board API returned no jobs array", names, jobsCount: null, apiUrl: candidate.apiUrl }
    return { status: "valid", httpStatus, reason: "Ashby job-board API returned jobs collection", names, jobsCount: jobs.length, apiUrl: candidate.apiUrl }
  }
  const obj = parsed as Record<string, unknown>
  const content = Array.isArray(obj.content) ? obj.content : []
  const names = companyNames(deepStrings(parsed, ["company", "companyName", "name"]))
  if (!Array.isArray(obj.content)) return { status: "validation_failed", httpStatus, reason: "SmartRecruiters API returned no postings collection", names, jobsCount: null, apiUrl: candidate.apiUrl }
  return { status: "valid", httpStatus, reason: "SmartRecruiters company API returned postings collection", names, jobsCount: content.length, apiUrl: candidate.apiUrl }
}

export async function resolveCandidate(company: CompanyRecord, candidate: AtsCandidate, options: AtsDetectorOptions = {}): Promise<{ mapping: AtsMapping; mismatch: boolean }> {
  const now = nowIso(options.now ?? new Date())
  const existing = company.ats
  const validation = await validateAtsCandidate(candidate, options)
  const mergedEvidence = uniqueEvidence([...(existing.evidence ?? []), ...candidate.evidence])
  if (validation.status === "invalid") {
    return {
      mismatch: false,
      mapping: {
        ...mappingFromCandidate(candidate, "invalid", 0, now, validation.reason),
        evidence: mergedEvidence,
        firstDetected: existing.firstDetected ?? now,
      },
    }
  }
  if (validation.status === "validation_failed") {
    if (existing.status === "verified") {
      return {
        mismatch: false,
        mapping: {
          ...existing,
          evidence: mergedEvidence,
          lastAttempted: now,
          failureReason: validation.reason,
        },
      }
    }
    return {
      mismatch: false,
      mapping: {
        ...mappingFromCandidate(candidate, "validation_failed", existing.confidence ?? 30, now, validation.reason),
        evidence: mergedEvidence,
        firstDetected: existing.firstDetected ?? now,
      },
    }
  }
  const identity = identityConfidence(company, candidate, validation)
  const status: AtsStatus = identity.confidence >= 80 && !identity.mismatch ? "verified" : "candidate"
  return {
    mismatch: identity.mismatch,
    mapping: {
      ...mappingFromCandidate(candidate, status, identity.confidence, now, identity.reason),
      evidence: uniqueEvidence([...mergedEvidence, evidence("api_validation", validation.apiUrl, validation.reason, now)]),
      firstDetected: existing.firstDetected ?? now,
      lastVerified: status === "verified" ? now : null,
    },
  }
}

function extractUrls(html: string, baseUrl: string): Array<{ url: string; type: AtsEvidenceType }> {
  const found: Array<{ url: string; type: AtsEvidenceType }> = []
  const add = (raw: string, type: AtsEvidenceType) => {
    try {
      const url = new URL(raw.replace(/\\\//g, "/"), baseUrl).toString()
      if (ATS_HOSTS.has(new URL(url).hostname.toLowerCase())) found.push({ url, type })
    } catch {
      // Ignore malformed embedded values.
    }
  }
  for (const match of html.matchAll(/\b(?:href|src|data-url|data-src)=["']([^"']+)["']/gi)) {
    const attr = match[0].toLowerCase()
    const type: AtsEvidenceType = attr.startsWith("src") ? "iframe" : "embedded_link"
    add(match[1], type)
  }
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+/gi)) add(match[0], "script")
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const url of deepStrings(safeJson(match[1]), ["url", "sameAs", "hiringOrganization"])) {
      add(url, "jsonld")
    }
  }
  return found
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function discoverFromCareersPage(company: CompanyRecord, url: string, options: AtsDetectorOptions, now: string): Promise<AtsCandidate[]> {
  const resolveHost = options.resolveHost
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  try {
    const page = await fetchText(url, { fetchImpl: options.fetchImpl, resolveHost, maxBodyBytes })
    if (page.status < 200 || page.status >= 300) return []
    const candidates: AtsCandidate[] = []
    for (const item of extractUrls(page.body, page.finalUrl)) {
      const candidate = parseAtsUrl(item.url, item.type, now)
      if (!candidate) continue
      candidate.evidence.push(evidence("careers_page", page.finalUrl, `found on careers page for ${company.canonicalName}`, now))
      candidates.push(candidate)
    }
    return mergeCandidates(candidates)
  } catch {
    return []
  }
}

function mergeCandidates(candidates: AtsCandidate[]): AtsCandidate[] {
  const byKey = new Map<string, AtsCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.provider}:${candidate.identifier}`
    const existing = byKey.get(key)
    if (existing) existing.evidence = uniqueEvidence([...existing.evidence, ...candidate.evidence])
    else byKey.set(key, { ...candidate, evidence: uniqueEvidence(candidate.evidence) })
  }
  return [...byKey.values()]
}

function candidatesFromObservations(observations: JobObservation[], now: string): AtsCandidate[] {
  const candidates: AtsCandidate[] = []
  for (const obs of observations) {
    if (!obs.jobUrl) continue
    const candidate = parseAtsUrl(obs.jobUrl, "job_url", now)
    if (candidate) candidates.push(candidate)
  }
  return mergeCandidates(candidates)
}

function careersProbeUrls(company: CompanyRecord): string[] {
  const urls = new Set<string>()
  if (company.careersUrl) urls.add(company.careersUrl)
  if (company.websiteUrl) urls.add(company.websiteUrl)
  if (company.domain) {
    urls.add(`https://${company.domain}/careers`)
    urls.add(`https://${company.domain}/jobs`)
    urls.add(`https://careers.${company.domain}`)
    urls.add(`https://jobs.${company.domain}`)
  }
  return [...urls].slice(0, 5)
}

export function slugCandidates(company: CompanyRecord): string[] {
  const base = [company.canonicalName, ...company.aliases].map(normalizeCompanyName)
  const candidates = new Set<string>()
  for (const name of base) {
    if (!name) continue
    candidates.add(name.replace(/\s+/g, ""))
    candidates.add(name.replace(/\s+/g, "-"))
  }
  return [...candidates].filter((value) => /^[a-z0-9-]{3,80}$/i.test(value)).slice(0, 3)
}

async function discoverCandidates(company: CompanyRecord, observations: JobObservation[], options: AtsDetectorOptions, now: string): Promise<AtsCandidate[]> {
  const direct = candidatesFromObservations(observations, now)
  if (direct.length > 0) return direct
  const discovered: AtsCandidate[] = []
  for (const url of careersProbeUrls(company)) {
    discovered.push(...await discoverFromCareersPage(company, url, options, now))
    if (discovered.length > 0) break
  }
  if (discovered.length > 0 || options.slugProbes === false) return mergeCandidates(discovered)
  const slugs = slugCandidates(company)
  return slugs.map((slug) => ({
    provider: "greenhouse" as const,
    identifier: slug,
    boardUrl: providerBoardUrl("greenhouse", slug),
    apiUrl: providerApiUrl("greenhouse", slug),
    evidence: [evidence("slug_probe", providerBoardUrl("greenhouse", slug), "bounded fallback slug probe", now)],
  }))
}

async function resolveCompany(registry: JsonCompanyRegistry, company: CompanyRecord, options: AtsDetectorOptions): Promise<ResolveOutcome> {
  const now = nowIso(options.now ?? new Date())
  const nowMs = Date.parse(now)
  const observations = registry.observationsForCompany(company.id)
  const existingCandidate = candidateFromMapping(company.ats, now)
  if (existingCandidate && options.provider && existingCandidate.provider !== options.provider) {
    return { companyId: company.id, company: company.canonicalName, action: "skipped", reason: "provider filter skipped company" }
  }
  if (existingCandidate && !dueForAttempt(company.ats, nowMs, options.force)) {
    return { companyId: company.id, company: company.canonicalName, action: "skipped", reason: "mapping is still fresh", ats: company.ats }
  }
  const candidates = existingCandidate ? [existingCandidate] : await discoverCandidates(company, observations, options, now)
  for (const candidate of candidates) {
    if (options.provider && candidate.provider !== options.provider) continue
    const { mapping, mismatch } = await resolveCandidate(company, candidate, options)
    registry.updateAts(company.id, mapping)
    if (mapping.status === "verified") return { companyId: company.id, company: company.canonicalName, action: "verified", provider: mapping.provider, identifier: mapping.identifier, confidence: mapping.confidence, reason: mapping.failureReason ?? undefined, ats: mapping }
    if (mapping.status === "invalid") return { companyId: company.id, company: company.canonicalName, action: "invalid", provider: mapping.provider, identifier: mapping.identifier, confidence: mapping.confidence, reason: mapping.failureReason ?? undefined, ats: mapping }
    if (mapping.status === "validation_failed") return { companyId: company.id, company: company.canonicalName, action: "validation_failed", provider: mapping.provider, identifier: mapping.identifier, confidence: mapping.confidence, reason: mapping.failureReason ?? undefined, ats: mapping }
    if (mapping.status === "candidate") return { companyId: company.id, company: company.canonicalName, action: "candidate", provider: mapping.provider, identifier: mapping.identifier, confidence: mapping.confidence, reason: mapping.failureReason ?? undefined, ats: mapping }
    if (mismatch) return { companyId: company.id, company: company.canonicalName, action: "candidate", provider: mapping.provider, identifier: mapping.identifier, confidence: mapping.confidence, reason: mapping.failureReason ?? undefined, ats: mapping }
  }
  return { companyId: company.id, company: company.canonicalName, action: "unknown", reason: "no ATS candidate found" }
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

function selectCompanies(registry: JsonCompanyRegistry, options: AtsDetectorOptions): CompanyRecord[] {
  let companies = registry.listCompanies()
  if (options.onlyCandidates) companies = companies.filter((company) => company.ats.status === "candidate")
  else if (options.onlyUnknown) companies = companies.filter((company) => company.ats.status === "unknown")
  else if (!options.includeUnknown) companies = companies.filter((company) => company.ats.status !== "unknown")
  if (options.limit && Number.isFinite(options.limit)) companies = companies.slice(0, options.limit)
  return companies
}

function updateStats(stats: AtsRunStats, previousStatus: AtsStatus, outcome: ResolveOutcome): void {
  stats.companiesExamined += 1
  if (previousStatus !== "unknown") stats.existingAtsMappings += 1
  if (previousStatus === "candidate") stats.existingAtsCandidates += 1
  if (previousStatus === "unknown") stats.unknownCompaniesProcessed += 1
  if (outcome.action === "skipped") stats.skippedFresh += 1
  if ((previousStatus === "candidate" || previousStatus === "validation_failed") && outcome.action !== "skipped") stats.candidatesValidated += 1
  if (outcome.action === "verified") {
    stats.verifiedMappings += 1
    if (previousStatus === "unknown") stats.newMappingsVerified += 1
  }
  if (outcome.action === "invalid") stats.invalidCandidates += 1
  if (outcome.action === "validation_failed") stats.validationFailures += 1
  if (/did not match|mismatch|conflict/i.test(outcome.reason ?? "")) stats.identityMismatches += 1
  if (previousStatus === "unknown" && outcome.provider) stats.newCandidatesDiscovered += 1
  if (outcome.provider) stats.providers[outcome.provider] = (stats.providers[outcome.provider] ?? 0) + 1
  if (typeof outcome.confidence === "number") {
    const start = Math.min(90, Math.floor(outcome.confidence / 10) * 10)
    const end = start === 90 ? 100 : start + 9
    const bucket = `${start}-${end}`
    stats.confidence[bucket] = (stats.confidence[bucket] ?? 0) + 1
  }
}

export async function runAtsDetector(options: AtsDetectorOptions = {}): Promise<{ stats: AtsRunStats; outcomes: ResolveOutcome[]; registry: JsonCompanyRegistry }> {
  const registry = await JsonCompanyRegistry.load(options.registryPath ?? DEFAULT_REGISTRY_PATH)
  const companies = selectCompanies(registry, options)
  const stats = emptyStats()
  const outcomes = await mapLimit(companies, options.concurrency ?? 5, async (company) => {
    try {
      const previousStatus = company.ats.status
      const outcome = await resolveCompany(registry, company, options)
      updateStats(stats, previousStatus, outcome)
      return outcome
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stats.companiesExamined += 1
      stats.validationFailures += 1
      stats.errors.push({ companyId: company.id, company: company.canonicalName, error: message })
      return { companyId: company.id, company: company.canonicalName, action: "validation_failed", reason: message } satisfies ResolveOutcome
    }
  })
  if (options.save !== false) await registry.save()
  return { stats, outcomes, registry }
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
    if (["registry", "format", "limit", "provider", "concurrency"].includes(key)) parsed[key] = argv[++i]
    else parsed[key] = true
  }
  return parsed
}

function formatStats(stats: AtsRunStats): string {
  const providers = Object.entries(stats.providers).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  -"
  const confidence = Object.entries(stats.confidence).sort().map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  -"
  return [
    `Companies examined: ${stats.companiesExamined}`,
    `Existing ATS candidates: ${stats.existingAtsCandidates}`,
    `Existing ATS mappings: ${stats.existingAtsMappings}`,
    `Candidates validated: ${stats.candidatesValidated}`,
    `Verified mappings: ${stats.verifiedMappings}`,
    `Invalid candidates: ${stats.invalidCandidates}`,
    `Validation failures: ${stats.validationFailures}`,
    `Identity mismatches: ${stats.identityMismatches}`,
    `Unknown companies processed: ${stats.unknownCompaniesProcessed}`,
    `New candidates discovered: ${stats.newCandidatesDiscovered}`,
    `New mappings verified: ${stats.newMappingsVerified}`,
    `Skipped fresh: ${stats.skippedFresh}`,
    "Providers:",
    providers,
    "Confidence:",
    confidence,
  ].join("\n")
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  const registryPath = typeof args.registry === "string" ? args.registry : DEFAULT_REGISTRY_PATH
  const format = args.format === "json" ? "json" : "plain"
  const provider = typeof args.provider === "string" ? args.provider as AtsProvider : undefined
  const common: AtsDetectorOptions = {
    registryPath,
    provider,
    limit: typeof args.limit === "string" ? Number(args.limit) : undefined,
    concurrency: typeof args.concurrency === "string" ? Number(args.concurrency) : undefined,
    force: Boolean(args.force),
    save: !args["dry-run"],
    slugProbes: !args["no-slug-probes"],
  }
  if (command === "run") {
    const result = await runAtsDetector({ ...common, onlyCandidates: Boolean(args["only-candidates"]), onlyUnknown: Boolean(args["only-unknown"]), includeUnknown: Boolean(args["include-unknown"]) })
    process.stdout.write(format === "json" ? `${JSON.stringify({ stats: result.stats, outcomes: result.outcomes }, null, 2)}\n` : `${formatStats(result.stats)}\n`)
    return 0
  }
  if (command === "validate" || command === "detect") {
    const query = args._[1]
    if (!query) throw new Error(`usage: ${command} <company-id-or-name> [--format json|plain]`)
    const registry = await JsonCompanyRegistry.load(registryPath)
    const company = registry.getById(query) ?? registry.findByName(query)[0] ?? null
    if (!company) {
      process.stdout.write(format === "json" ? "null\n" : "not found\n")
      return 1
    }
    const selected = command === "validate"
      ? { ...common, onlyCandidates: false, includeUnknown: true, limit: 1, force: true }
      : { ...common, onlyUnknown: company.ats.status === "unknown", includeUnknown: true, limit: 1, force: true }
    const outcome = await resolveCompany(registry, company, selected)
    if (common.save !== false) await registry.save()
    process.stdout.write(format === "json" ? `${JSON.stringify(outcome, null, 2)}\n` : `${company.canonicalName}: ${outcome.action} ${outcome.provider ?? ""} ${outcome.identifier ?? ""} ${outcome.confidence ?? ""}\n`)
    return outcome.action === "unknown" ? 1 : 0
  }
  if (command === "stats") {
    const data = JSON.parse(await readFile(registryPath, "utf8")) as { companies?: Record<string, CompanyRecord> }
    const companies = Object.values(data.companies ?? {})
    const stats = {
      companies: companies.length,
      unknown: companies.filter((company) => company.ats?.status === "unknown").length,
      candidate: companies.filter((company) => company.ats?.status === "candidate").length,
      verified: companies.filter((company) => company.ats?.status === "verified").length,
      invalid: companies.filter((company) => company.ats?.status === "invalid").length,
      validation_failed: companies.filter((company) => company.ats?.status === "validation_failed").length,
    }
    process.stdout.write(format === "json" ? `${JSON.stringify(stats, null, 2)}\n` : `${JSON.stringify(stats, null, 2)}\n`)
    return 0
  }
  process.stderr.write("usage: ats_detector.ts run|validate <company>|detect <company>|stats [--only-candidates] [--only-unknown] [--include-unknown] [--limit n] [--provider provider] [--force] [--dry-run] [--format json]\n")
  return 2
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
