import { isSecurityLeadershipTitle } from "./security_roles"
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { detectAts, type AvailabilityValidation, type NormalizedJob } from "./job_availability_validator"

export type { NormalizedJob }

export const REGISTRY_SCHEMA_VERSION = 2
export const DEFAULT_REGISTRY_PATH = "company_registry/registry.json"

export type AtsProvider = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "personio"
export type AtsStatus = "unknown" | "candidate" | "verified" | "invalid" | "validation_failed"
export type AtsEvidenceType =
  | "job_url"
  | "application_url"
  | "careers_page"
  | "embedded_link"
  | "iframe"
  | "script"
  | "jsonld"
  | "api_validation"
  | "slug_probe"

export interface AtsEvidence {
  type: AtsEvidenceType
  url?: string | null
  detail?: string | null
  observedAt: string
}

export interface AtsMapping {
  provider: AtsProvider | null
  identifier: string | null
  boardUrl: string | null
  apiUrl?: string | null
  verified: boolean
  confidence: number | null
  discoveredFrom: AtsEvidenceType | string | null
  evidence?: AtsEvidence[]
  firstDetected?: string | null
  lastVerified: string | null
  lastAttempted?: string | null
  failureReason?: string | null
  status: AtsStatus
}

export interface AtsHistoryEntry {
  provider: AtsProvider | string
  identifier: string
  firstSeen: string
  lastSeen: string
  status: AtsStatus | string
}

export type SecurityCategory =
  | "application_security"
  | "product_security"
  | "cloud_security"
  | "security_engineering"
  | "soc_detection"
  | "incident_response"
  | "penetration_testing"
  | "vulnerability_management"
  | "iam"
  | "grc"
  | "security_architecture"
  | "security_management"
  | "security_research"
  | "other_security"

export interface CompanyRecord {
  id: string
  canonicalName: string
  normalizedName: string
  aliases: string[]
  domain?: string | null
  websiteUrl?: string | null
  careersUrl?: string | null
  firstSeen: string
  lastSeen: string
  jobsObserved?: number
  securityHiring: {
    jobsSeen: number
    firstSeen: string
    lastSeen: string
    titles: Record<string, number>
    categories: Record<string, number>
    locations: Record<string, number>
  }
  sources: Record<string, {
    jobsSeen: number
    firstSeen: string
    lastSeen: string
  }>
  ats: AtsMapping
  atsHistory?: AtsHistoryEntry[]
  observedJobIds: string[]
  createdAt: string
  updatedAt: string
}

export interface JobObservation {
  observationId: string
  companyId: string
  source: string
  sourceJobId?: string | null
  jobTitle: string
  jobUrl?: string | null
  location?: string | null
  securityCategory: SecurityCategory | null
  firstSeen: string
  lastSeen: string
  status: "active" | "expired" | "unknown"
}

export interface CompanyRegistryData {
  schemaVersion: number
  companies: Record<string, CompanyRecord>
  observations: Record<string, JobObservation>
}

export interface CompanyObservation {
  companyName: string
  source: string
  observedAt: string
  jobId?: string | number | null
  jobTitle?: string | null
  jobUrl?: string | null
  atsUrl?: string | null
  companyDomain?: string | null
  companyWebsiteUrl?: string | null
  careersUrl?: string | null
  location?: string | null
  securityCategory?: SecurityCategory | null
  sourceCompanyId?: string | null
  validation?: AvailabilityValidation | null
}

export interface HarvestStats {
  jobsProcessed: number
  jobsRegistered: number
  securityJobs: number
  companiesCreated: number
  companiesUpdated: number
  jobsAlreadyKnown: number
  skippedMissingCompany: number
  skippedNonSecurity: number
  skippedInsufficientEvidence: number
  skippedExpired: number
  atsCandidatesDetected: number
}

export interface CompanyRegistryStats {
  companies: number
  jobsObserved: number
  securityJobsObserved: number
  companiesWithDomains: number
  atsCandidateMappings: number
  verifiedAtsMappings: number
  sources: Record<string, number>
  categories: Record<string, number>
}

export const ATS_HOSTS = new Set([
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.eu.lever.co",
  "jobs.ashbyhq.com",
  "careers.smartrecruiters.com",
  "api.smartrecruiters.com",
  "workable.com",
  "jobs.personio.de",
])

const SOURCE_HOSTS = new Set([
  "linkedin.com",
  "www.linkedin.com",
  "himalayas.app",
  "remotive.com",
  "www.remotive.com",
  "jobgether.com",
  "www.jobgether.com",
  "weworkremotely.com",
  "www.weworkremotely.com",
  "euremotejobs.com",
  "www.euremotejobs.com",
  "infosecjobboard.com",
  "www.infosecjobboard.com",
  "arbeitnow.com",
  "www.arbeitnow.com",
  "remoteok.com",
  "www.remoteok.com",
  "dailyremote.com",
  "www.dailyremote.com",
  "freehire.me",
  "www.freehire.me",
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
  "www.jobnet.dk",
  "jobindex.dk",
  "www.jobindex.dk",
  "jobbank.dk",
  "www.jobbank.dk",
  "jobdanmark.dk",
  "www.jobdanmark.dk",
  "jobicy.com",
  "www.jobicy.com",
  "jooble.org",
  "www.jooble.org",
  "at.jooble.org",
  "de.jooble.org",
  "uk.jooble.org",
  "reed.co.uk",
  "www.reed.co.uk",
  "wellfound.com",
  "www.wellfound.com",
  "djinni.co",
  "www.djinni.co",
  "dou.ua",
  "www.dou.ua",
  "indeed.com",
  "www.indeed.com",
  "glassdoor.com",
  "www.glassdoor.com",
  "monster.com",
  "www.monster.com",
  "totaljobs.com",
  "www.totaljobs.com",
  "builtin.com",
  "www.builtin.com",
  "crunchbase.com",
  "www.crunchbase.com",
  "workablejobs.com",
  "www.workablejobs.com",
])

const SOURCE_HOST_SUFFIXES = [
  ".linkedin.com",
]

const LEGAL_SUFFIXES = [
  "incorporated", "inc", "llc", "ltd", "limited", "gmbh", "ag", "se", "corp",
  "corporation", "sa", "s a", "bv", "b v", "plc", "aps", "as", "oy", "ab",
]

const CATEGORY_RULES: Array<[SecurityCategory, RegExp]> = [
  ["application_security", /\b(appsec|application security|secure sdlc|product application security)\b/i],
  ["product_security", /\b(product security|security product engineer)\b/i],
  ["cloud_security", /\b(cloud security|aws security|azure security|gcp security)\b/i],
  ["soc_detection", /\b(soc|security operations|detection engineer|threat detection|siem)\b/i],
  ["incident_response", /\b(incident response|incident responder|dfir)\b/i],
  ["penetration_testing", /\b(pentest|penetration tester|penetration testing|red team)\b/i],
  ["vulnerability_management", /\b(vulnerability|vulnerability management)\b/i],
  ["iam", /\b(iam|identity and access|identity access|access management)\b/i],
  ["grc", /\b(grc|security governance|security compliance|security risk|information security officer)\b/i],
  ["security_architecture", /\b(security architect|cybersecurity architect|information security architect)\b/i],
  ["security_management", /\b(security lead|security manager|cybersecurity manager|information security manager|ciso|security tech lead)\b/i],
  ["security_research", /\b(security researcher|vulnerability researcher)\b/i],
  ["security_engineering", /\b(security engineer|cybersecurity engineer|cyber security engineer|information security engineer|infosec engineer)\b/i],
  ["other_security", /\b(cybersecurity|cyber security|information security|infosec|security specialist|security consultant|threat)\b/i],
]

export function emptyRegistry(): CompanyRegistryData {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, companies: {}, observations: {} }
}

export function normalizeCompanyName(name: string): string {
  let normalized = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'’`´()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  for (const suffix of LEGAL_SUFFIXES) {
    const pattern = new RegExp(`(?:\\s+|^)${suffix.replace(/\s+/g, "\\s+")}$`, "i")
    normalized = normalized.replace(pattern, "").trim()
  }
  return normalized.replace(/\s+/g, " ")
}

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null
  let raw = input.trim()
  if (!raw) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  let host = url.hostname.toLowerCase().replace(/\.$/, "")
  if (host.startsWith("www.")) host = host.slice(4)
  if (host.startsWith("careers.") || host.startsWith("jobs.")) {
    const rest = host.replace(/^(careers|jobs)\./, "")
    if (!ATS_HOSTS.has(host) && rest.includes(".")) host = rest
  }
  if (host.endsWith(".jobs.personio.de")) return null
  if (ATS_HOSTS.has(host)) return null
  if (SOURCE_HOSTS.has(host) || SOURCE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null
  return host || null
}

export function domainFromJob(job: NormalizedJob): string | null {
  for (const key of ["companyDomain", "companyWebsiteUrl", "websiteUrl", "companyUrl", "careersUrl"] as const) {
    const value = job[key]
    if (typeof value === "string") {
      const domain = normalizeDomain(value)
      if (domain) return domain
    }
  }
  for (const key of ["applicationUrl", "applyUrl", "canonicalUrl", "url", "sourceUrl"] as const) {
    const value = job[key]
    if (typeof value !== "string") continue
    const domain = normalizeDomain(value)
    if (domain) return domain
  }
  return null
}

function employerPostingUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return normalizeDomain(value) && /\/(?:careers?|jobs?|open-positions|vacancies)(?:\/|$)/i.test(url.pathname) ? value : null
  } catch {
    return null
  }
}

export function classifySecurityCategory(job: Pick<NormalizedJob, "title" | "category" | "categories" | "tags">): SecurityCategory | null {
  const title = typeof job.title === "string" ? job.title : ""
  if (/\b(physical security|security guard|loss prevention)\b/i.test(title)) return null
  if (isSecurityLeadershipTitle(title)) return "security_management"
  const structured = [
    typeof job.category === "string" ? job.category : "",
    ...(Array.isArray(job.categories) ? job.categories.map(String) : []),
    ...(Array.isArray(job.tags) ? job.tags.map(String) : []),
  ].join(" ")
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(title) || pattern.test(structured)) return category
  }
  return null
}

export function isSecurityRelevant(job: NormalizedJob): boolean {
  return classifySecurityCategory(job) !== null
}

export function nowIso(date = new Date()): string {
  return date.toISOString()
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function sourceForJob(job: NormalizedJob): string {
  const portal = typeof job.portal === "string" && job.portal ? job.portal : null
  const source = typeof job.source === "string" && job.source ? job.source : null
  return portal ?? source ?? "unknown"
}

function sourceJobId(job: NormalizedJob): string | null {
  if (job.id !== undefined && job.id !== null && String(job.id).trim()) return String(job.id).trim()
  const url = typeof job.url === "string" ? job.url : null
  if (!url) return null
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split("/").filter(Boolean)
    return parts.at(-1) ?? url
  } catch {
    return url
  }
}

export function observationKey(input: CompanyObservation): string {
  if (input.jobUrl) {
    return `obs_${stableHash(`url:${input.jobUrl.trim().toLowerCase()}`)}`
  }
  const source = input.source || "unknown"
  if (input.jobId !== undefined && input.jobId !== null && String(input.jobId).trim()) {
    return `obs_${stableHash(`${source}:id:${String(input.jobId).trim()}`)}`
  }
  const fallback = [input.companyName, input.jobTitle ?? "", input.location ?? "", source].map((v) => normalizeCompanyName(String(v))).join("|")
  return `obs_${stableHash(fallback)}`
}

function increment(map: Record<string, number>, key: string | null | undefined): void {
  const clean = typeof key === "string" ? key.trim() : ""
  if (!clean) return
  map[clean] = (map[clean] ?? 0) + 1
}

function mergeAlias(company: CompanyRecord, alias: string): void {
  const clean = alias.trim()
  if (!clean) return
  if (!company.aliases.includes(clean)) {
    company.aliases.push(clean)
    company.aliases.sort((a, b) => a.localeCompare(b))
  }
}

export function defaultAts(): AtsMapping {
  return {
    provider: null,
    identifier: null,
    boardUrl: null,
    apiUrl: null,
    verified: false,
    confidence: null,
    discoveredFrom: null,
    evidence: [],
    firstDetected: null,
    lastVerified: null,
    lastAttempted: null,
    failureReason: null,
    status: "unknown" as const,
  }
}

function migrateAts(raw: unknown, now = nowIso()): AtsMapping {
  if (!raw || typeof raw !== "object") return defaultAts()
  const ats = raw as Partial<AtsMapping>
  const provider = ats.provider === "greenhouse" || ats.provider === "lever" || ats.provider === "ashby" || ats.provider === "smartrecruiters" || ats.provider === "personio" ? ats.provider : null
  const status = ats.status === "candidate" || ats.status === "verified" || ats.status === "invalid" || ats.status === "validation_failed" ? ats.status : "unknown"
  const discoveredFrom = typeof ats.discoveredFrom === "string" ? ats.discoveredFrom : null
  const firstDetected = typeof ats.firstDetected === "string"
    ? ats.firstDetected
    : provider && status !== "unknown" ? now : null
  const evidence = Array.isArray(ats.evidence)
    ? ats.evidence.filter((item) => item && typeof item === "object") as AtsEvidence[]
    : provider && discoveredFrom
      ? [{ type: discoveredFrom as AtsEvidenceType, url: ats.boardUrl ?? null, detail: "migrated from schema v1 candidate", observedAt: firstDetected ?? now }]
      : []
  return {
    provider,
    identifier: typeof ats.identifier === "string" ? ats.identifier : null,
    boardUrl: typeof ats.boardUrl === "string" ? ats.boardUrl : null,
    apiUrl: typeof ats.apiUrl === "string" ? ats.apiUrl : null,
    verified: Boolean(ats.verified && status === "verified"),
    confidence: typeof ats.confidence === "number" ? ats.confidence : null,
    discoveredFrom,
    evidence,
    firstDetected,
    lastVerified: typeof ats.lastVerified === "string" ? ats.lastVerified : null,
    lastAttempted: typeof ats.lastAttempted === "string" ? ats.lastAttempted : null,
    failureReason: typeof ats.failureReason === "string" ? ats.failureReason : null,
    status,
  }
}

function migrateRegistryData(data: CompanyRegistryData): CompanyRegistryData {
  if (data.schemaVersion === REGISTRY_SCHEMA_VERSION) return data
  if (data.schemaVersion !== 1 || !data.companies || !data.observations) {
    throw new Error("Unsupported or corrupt company registry")
  }
  const migrated = data as CompanyRegistryData
  const now = nowIso()
  migrated.schemaVersion = REGISTRY_SCHEMA_VERSION
  for (const company of Object.values(migrated.companies)) {
    company.ats = migrateAts(company.ats, now)
    if (!Array.isArray(company.atsHistory)) company.atsHistory = []
  }
  return migrated
}

function atsCandidateFromUrl(urlRaw: string | null | undefined): CompanyRecord["ats"] | null {
  if (!urlRaw) return null
  const info = detectAts(urlRaw)
  if (!info) return null
  const url = new URL(urlRaw)
  const parts = url.pathname.split("/").filter(Boolean)
  const identifier = parts[0] ?? null
  return {
    provider: info.provider,
    identifier,
    boardUrl: identifier ? `${url.origin}/${identifier}` : url.origin,
    apiUrl: info.apiUrl,
    verified: false,
    confidence: 70,
    discoveredFrom: "job_url",
    evidence: [{
      type: "job_url",
      url: urlRaw,
      detail: "ATS URL observed from job listing",
      observedAt: nowIso(),
    }],
    firstDetected: nowIso(),
    lastVerified: null,
    lastAttempted: null,
    failureReason: null,
    status: "candidate",
  }
}

export function observationFromJob(job: NormalizedJob, observedAt = nowIso()): CompanyObservation | null {
  const companyName = typeof job.company === "string" ? job.company.trim() : ""
  if (!companyName) return null
  const category = classifySecurityCategory(job)
  const jobUrl = typeof job.url === "string" ? job.url : null
  const atsUrl = [job.applicationUrl, job.applyUrl, job.canonicalUrl, job.url, job.sourceUrl]
    .find((value): value is string => typeof value === "string" && detectAts(value) !== null) ?? null
  const postingUrl = [job.canonicalUrl, job.url, job.sourceUrl].map(employerPostingUrl).find((value): value is string => value !== null) ?? null
  const postingDomain = postingUrl ? normalizeDomain(postingUrl) : null
  const employerDomain = [job.companyDomain, job.companyWebsiteUrl, job.websiteUrl, job.companyUrl, job.careersUrl, job.applicationUrl, job.applyUrl]
    .flatMap((value) => typeof value === "string" ? [normalizeDomain(value)] : [])
    .find((value): value is string => Boolean(value)) ?? postingDomain
  const careersUrl = typeof job.careersUrl === "string" && normalizeDomain(job.careersUrl) ? job.careersUrl : null
  const directEmployerPosting = job.sourceType === "employer_careers" && Boolean(domainFromJob(job))
  if (!employerDomain && !careersUrl && !atsUrl && !directEmployerPosting) return null
  return {
    companyName,
    source: sourceForJob(job),
    observedAt,
    jobId: sourceJobId(job),
    jobTitle: typeof job.title === "string" ? job.title : null,
    jobUrl,
    atsUrl,
    companyDomain: employerDomain,
    companyWebsiteUrl: typeof job.companyWebsiteUrl === "string" ? job.companyWebsiteUrl : null,
    careersUrl: typeof job.careersUrl === "string" ? job.careersUrl : null,
    location: typeof job.location === "string" ? job.location : null,
    securityCategory: category,
    sourceCompanyId: typeof job.companySlug === "string" ? job.companySlug : null,
    validation: job.validation ?? null,
  }
}

export class JsonCompanyRegistry {
  private data: CompanyRegistryData
  private path: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(path = DEFAULT_REGISTRY_PATH, data: CompanyRegistryData = emptyRegistry()) {
    this.path = resolve(path)
    this.data = data
  }

  static async load(path = DEFAULT_REGISTRY_PATH): Promise<JsonCompanyRegistry> {
    const resolved = resolve(path)
    let data: CompanyRegistryData
    try {
      data = JSON.parse(await readFile(resolved, "utf8")) as CompanyRegistryData
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        data = emptyRegistry()
      } else {
        throw new Error(`Unable to read company registry at ${resolved}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!data.companies || !data.observations) {
      throw new Error(`Unsupported or corrupt company registry at ${resolved}`)
    }
    data = migrateRegistryData(data)
    return new JsonCompanyRegistry(resolved, data)
  }

  snapshot(): CompanyRegistryData {
    return JSON.parse(JSON.stringify(this.data)) as CompanyRegistryData
  }

  getById(id: string): CompanyRecord | null {
    return this.data.companies[id] ?? null
  }

  findByDomain(domain: string): CompanyRecord | null {
    const normalized = normalizeDomain(domain)
    if (!normalized) return null
    return Object.values(this.data.companies).find((company) => company.domain === normalized) ?? null
  }

  findByName(name: string): CompanyRecord[] {
    const normalized = normalizeCompanyName(name)
    return Object.values(this.data.companies).filter((company) => (
      company.normalizedName === normalized ||
      company.aliases.some((alias) => normalizeCompanyName(alias) === normalized)
    ))
  }

  listCompanies(): CompanyRecord[] {
    return Object.values(this.data.companies).sort((a, b) => a.canonicalName.localeCompare(b.canonicalName))
  }

  observationsForCompany(companyId: string): JobObservation[] {
    const company = this.getById(companyId)
    if (!company) return []
    return company.observedJobIds
      .map((id) => this.data.observations[id])
      .filter(Boolean)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
  }

  updateAts(companyId: string, ats: AtsMapping): CompanyRecord {
    const company = this.data.companies[companyId]
    if (!company) throw new Error(`Company not found: ${companyId}`)
    const previous = company.ats
    if (
      previous.provider &&
      previous.identifier &&
      (previous.provider !== ats.provider || previous.identifier !== ats.identifier)
    ) {
      const history = company.atsHistory ?? []
      const existing = history.find((item) => item.provider === previous.provider && item.identifier === previous.identifier)
      if (existing) {
        existing.lastSeen = nowIso()
        existing.status = previous.status
      } else {
        history.push({
          provider: previous.provider,
          identifier: previous.identifier,
          firstSeen: previous.firstDetected ?? previous.lastVerified ?? company.firstSeen,
          lastSeen: nowIso(),
          status: previous.status,
        })
      }
      company.atsHistory = history
    }
    company.ats = ats
    company.updatedAt = nowIso()
    return company
  }

  stats(): CompanyRegistryStats {
    const companies = this.listCompanies()
    const sources: Record<string, number> = {}
    const categories: Record<string, number> = {}
    for (const company of companies) {
      for (const [source, data] of Object.entries(company.sources)) {
        sources[source] = (sources[source] ?? 0) + data.jobsSeen
      }
    }
    for (const observation of Object.values(this.data.observations)) {
      increment(categories, observation.securityCategory)
    }
    return {
      companies: companies.length,
      jobsObserved: Object.keys(this.data.observations).length,
      securityJobsObserved: Object.values(this.data.observations).filter((observation) => observation.securityCategory !== null).length,
      companiesWithDomains: companies.filter((company) => company.domain).length,
      atsCandidateMappings: companies.filter((company) => company.ats.status === "candidate").length,
      verifiedAtsMappings: companies.filter((company) => company.ats.status === "verified").length,
      sources,
      categories,
    }
  }

  possibleDuplicates(): Array<{ normalizedName: string; companies: Array<{ id: string; canonicalName: string; domain?: string | null }> }> {
    const byName = new Map<string, CompanyRecord[]>()
    for (const company of this.listCompanies()) {
      const bucket = byName.get(company.normalizedName) ?? []
      bucket.push(company)
      byName.set(company.normalizedName, bucket)
    }
    return [...byName.entries()]
      .filter(([, companies]) => companies.length > 1)
      .map(([normalizedName, companies]) => ({ normalizedName, companies: companies.map(({ id, canonicalName, domain }) => ({ id, canonicalName, domain })) }))
  }

  upsertCompany(input: CompanyObservation): { company: CompanyRecord; created: boolean; duplicateJob: boolean; atsCandidateDetected: boolean } {
    const observedAt = input.observedAt || nowIso()
    const normalizedName = normalizeCompanyName(input.companyName)
    const domain = normalizeDomain(input.companyDomain)
    const existing = (domain ? this.findByDomain(domain) : null) ?? this.findByName(input.companyName).find((candidate) => candidate.domain === domain) ?? null
    const obsId = observationKey(input)
    const existingObservation = this.data.observations[obsId]
    let company: CompanyRecord
    let created = false
    if (existing) {
      company = existing
    } else {
      const id = `company_${randomUUID()}`
      company = {
        id,
        canonicalName: input.companyName.trim(),
        normalizedName,
        aliases: [input.companyName.trim()],
        domain,
        websiteUrl: input.companyWebsiteUrl ?? null,
        careersUrl: input.careersUrl ?? null,
        firstSeen: observedAt,
        lastSeen: observedAt,
        jobsObserved: 0,
        securityHiring: {
          jobsSeen: 0,
          firstSeen: observedAt,
          lastSeen: observedAt,
          titles: {},
          categories: {},
          locations: {},
        },
        sources: {},
        ats: defaultAts(),
        observedJobIds: [],
        createdAt: observedAt,
        updatedAt: observedAt,
      }
      this.data.companies[id] = company
      created = true
    }

    mergeAlias(company, input.companyName)
    if (!company.domain && domain) company.domain = domain
    if (!company.websiteUrl && input.companyWebsiteUrl) company.websiteUrl = input.companyWebsiteUrl
    if (!company.careersUrl && input.careersUrl) company.careersUrl = input.careersUrl
    company.lastSeen = observedAt
    company.updatedAt = observedAt

    const source = input.source || "unknown"
    if (!company.sources[source]) company.sources[source] = { jobsSeen: 0, firstSeen: observedAt, lastSeen: observedAt }
    company.sources[source].lastSeen = observedAt

    let duplicateJob = Boolean(existingObservation)
    if (existingObservation) {
      existingObservation.lastSeen = observedAt
      existingObservation.status = input.validation?.status === "active" ? "active" : input.validation?.status === "expired" ? "expired" : existingObservation.status
      if (company.sources[source].jobsSeen === 0) company.sources[source].jobsSeen = 1
    } else {
      const category = input.securityCategory ?? null
      this.data.observations[obsId] = {
        observationId: obsId,
        companyId: company.id,
        source,
        sourceJobId: input.jobId === undefined || input.jobId === null ? null : String(input.jobId),
        jobTitle: input.jobTitle ?? "Unknown job",
        jobUrl: input.jobUrl ?? null,
        location: input.location ?? null,
        securityCategory: category,
        firstSeen: observedAt,
        lastSeen: observedAt,
        status: input.validation?.status === "active" ? "active" : input.validation?.status === "expired" ? "expired" : "unknown",
      }
      company.observedJobIds.push(obsId)
      company.observedJobIds.sort()
      company.jobsObserved = (company.jobsObserved ?? company.securityHiring.jobsSeen) + 1
      if (category) {
        company.securityHiring.jobsSeen += 1
        company.securityHiring.lastSeen = observedAt
        increment(company.securityHiring.titles, input.jobTitle ?? "Unknown security role")
        increment(company.securityHiring.categories, category)
        increment(company.securityHiring.locations, input.location ?? null)
      }
      company.sources[source].jobsSeen += 1
      duplicateJob = false
    }

    let atsCandidateDetected = false
    if (company.ats.status === "unknown") {
      const candidate = atsCandidateFromUrl(input.atsUrl ?? input.jobUrl)
      if (candidate) {
        company.ats = candidate
        atsCandidateDetected = true
      }
    }
    return { company, created, duplicateJob, atsCandidateDetected }
  }

  async save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await atomicWriteJson(this.path, this.data)
    })
    return this.writeQueue
  }
}

export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const resolved = resolve(path)
  await mkdir(dirname(resolved), { recursive: true })
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`
  const json = `${JSON.stringify(data, null, 2)}\n`
  await writeFile(tmp, json, "utf8")
  const handle = await open(tmp, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, resolved)
}

export async function harvestCompanies(jobs: NormalizedJob[], options: { registryPath?: string; observedAt?: string; save?: boolean } = {}): Promise<{ stats: HarvestStats; registry: JsonCompanyRegistry }> {
  const registry = await JsonCompanyRegistry.load(options.registryPath)
  const stats: HarvestStats = {
    jobsProcessed: jobs.length,
    jobsRegistered: 0,
    securityJobs: 0,
    companiesCreated: 0,
    companiesUpdated: 0,
    jobsAlreadyKnown: 0,
    skippedMissingCompany: 0,
    skippedNonSecurity: 0,
    skippedInsufficientEvidence: 0,
    skippedExpired: 0,
    atsCandidatesDetected: 0,
  }
  for (const job of jobs) {
    try {
      if (job.validation?.status === "expired") {
        stats.skippedExpired += 1
        continue
      }
      const observation = observationFromJob(job, options.observedAt ?? nowIso())
      if (!observation) {
        if (typeof job.company !== "string" || !job.company.trim()) stats.skippedMissingCompany += 1
        else stats.skippedInsufficientEvidence += 1
        continue
      }
      stats.jobsRegistered += 1
      if (observation.securityCategory) stats.securityJobs += 1
      const upsert = registry.upsertCompany(observation)
      if (upsert.duplicateJob) stats.jobsAlreadyKnown += 1
      else if (upsert.created) stats.companiesCreated += 1
      else stats.companiesUpdated += 1
      if (upsert.atsCandidateDetected) stats.atsCandidatesDetected += 1
    } catch {
      if (!job.company) stats.skippedMissingCompany += 1
    }
  }
  if (options.save !== false) await registry.save()
  return { stats, registry }
}

function jobsFromUnknown(data: unknown): NormalizedJob[] {
  if (Array.isArray(data)) return data as NormalizedJob[]
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.results)) return obj.results as NormalizedJob[]
    if (Array.isArray(obj.all)) return obj.all as NormalizedJob[]
    if (obj.seen && typeof obj.seen === "object") return Object.values(obj.seen as Record<string, NormalizedJob>)
  }
  return []
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
    if (["registry", "format", "limit"].includes(key)) parsed[key] = argv[++i]
    else parsed[key] = true
  }
  return parsed
}

function print(data: unknown, format: string): void {
  if (format === "json") process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
  else process.stdout.write(`${data}\n`)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  const registryPath = typeof args.registry === "string" ? args.registry : DEFAULT_REGISTRY_PATH
  const format = args.format === "json" ? "json" : "plain"
  if (command === "harvest-file" || command === "import") {
    const file = args._[1]
    if (!file) throw new Error("usage: harvest-file <jobs.json> [--registry path] [--format json|plain]")
    const jobs = jobsFromUnknown(JSON.parse(await readFile(file, "utf8")))
    const { stats } = await harvestCompanies(jobs, { registryPath })
    print(format === "json" ? stats : `processed ${stats.jobsProcessed}, registered ${stats.jobsRegistered}, security ${stats.securityJobs}, created ${stats.companiesCreated}, updated ${stats.companiesUpdated}, duplicates ${stats.jobsAlreadyKnown}`, format)
    return 0
  }
  if (command === "import-seen") {
    const file = args._[1] ?? "job_scraper/seen_jobs.json"
    const jobs = jobsFromUnknown(JSON.parse(await readFile(file, "utf8")))
    const { stats } = await harvestCompanies(jobs, { registryPath })
    print(format === "json" ? stats : `processed ${stats.jobsProcessed}, registered ${stats.jobsRegistered}, security ${stats.securityJobs}, created ${stats.companiesCreated}, updated ${stats.companiesUpdated}, duplicates ${stats.jobsAlreadyKnown}`, format)
    return 0
  }
  const registry = await JsonCompanyRegistry.load(registryPath)
  if (command === "stats") {
    print(format === "json" ? registry.stats() : formatStats(registry.stats()), format)
    return 0
  }
  if (command === "list") {
    const limit = Number(args.limit ?? 50)
    const companies = registry.listCompanies().slice(0, Number.isFinite(limit) ? limit : 50)
    print(format === "json" ? companies : companies.map((company) => `${company.id}\t${company.canonicalName}\t${company.jobsObserved ?? company.securityHiring.jobsSeen}`).join("\n"), format)
    return 0
  }
  if (command === "show") {
    const query = args._[1]
    if (!query) throw new Error("usage: show <company-id-or-name> [--format json|plain]")
    const company = registry.getById(query) ?? registry.findByName(query)[0] ?? null
    print(format === "json" ? company : company ? `${company.canonicalName}\n${JSON.stringify(company, null, 2)}` : "not found", format)
    return company ? 0 : 1
  }
  if (command === "search") {
    const query = args._[1]
    if (!query) throw new Error("usage: search <query> [--format json|plain]")
    const normalized = normalizeCompanyName(query)
    const companies = registry.listCompanies().filter((company) => company.normalizedName.includes(normalized) || company.aliases.some((alias) => normalizeCompanyName(alias).includes(normalized)))
    print(format === "json" ? companies : companies.map((company) => `${company.id}\t${company.canonicalName}\t${company.domain ?? "-"}`).join("\n"), format)
    return 0
  }
  if (command === "duplicates") {
    print(format === "json" ? registry.possibleDuplicates() : JSON.stringify(registry.possibleDuplicates(), null, 2), format)
    return 0
  }
  process.stderr.write("usage: stats | list | show <id-or-name> | search <query> | duplicates | harvest-file <jobs.json> | import-seen [seen_jobs.json]\n")
  return 2
}

function formatStats(stats: CompanyRegistryStats): string {
  const sourceLines = Object.entries(stats.sources).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join("\n")
  const categoryLines = Object.entries(stats.categories).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join("\n")
  return [
    `Companies: ${stats.companies}`,
    `Jobs observed: ${stats.jobsObserved}`,
    `Security jobs observed: ${stats.securityJobsObserved}`,
    `Companies with domains: ${stats.companiesWithDomains}`,
    `ATS candidate mappings: ${stats.atsCandidateMappings}`,
    `Verified ATS mappings: ${stats.verifiedAtsMappings}`,
    "Sources:",
    sourceLines || "  -",
    "Categories:",
    categoryLines || "  -",
  ].join("\n")
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
