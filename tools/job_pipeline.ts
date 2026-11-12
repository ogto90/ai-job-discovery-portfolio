import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  DEFAULT_REGISTRY_PATH,
  normalizeCompanyName,
  nowIso,
  type NormalizedJob,
} from "./company_registry"
import { dedupePreferDirectAts, runAtsJobIngestion, type AtsFetchResult, type AtsIngestionStats } from "./ats_job_ingestor"
import { validateJobs, normalizeCacheUrl, type AvailabilityValidation } from "./job_availability_validator"
import { emptyEnrichmentStats, enrichJobs, formatEnrichmentSummary, type EnrichmentStats } from "./job_detail_enrichment"
import {
  evaluateCandidateEligibility,
  extractJobRequirements,
  loadCandidateProfile,
  type CandidateProfile,
  type EligibilityDimension,
  type EligibilityResult,
  type JobRequirements,
} from "./eligibility_engine"
import { matchCandidateToJob, type MatchResult } from "./matching_engine"
import { evaluateFinalJobEligibility, normalizeDiscoveredJob, type FinalJobEligibility, type SearchProfileRecord } from "./generic_discovery"
import { evaluateSourceApplicability, parseSourceCapability, type SourceSelectionDiagnostic } from "./source_capabilities"

export type PipelineSourceStatus =
  | "success"
  | "zero_results"
  | "partial"
  | "timeout"
  | "authorization_failed"
  | "blocked"
  | "rate_limited"
  | "provider_error"
  | "parser_failure"
  | "validation_failure"
  | "failed"

export interface SourceRunDetail {
  name: string
  attempted: boolean
  success: boolean
  status: PipelineSourceStatus
  errorCategory?: PipelineSourceStatus
  error?: string
  runtimeMs: number
  jobsReturned: number
  queriesAttempted?: number
  pagesAttempted?: number
  normalizedJobs: number
  expiredJobs: number
  validationFailures: number
  uniqueJobs: number
  duplicateJobs: number
  finalActionableJobs: number
}

export interface SourceRunResult {
  detail: SourceRunDetail
  jobs: NormalizedJob[]
}

export type EligibilityReason = EligibilityDimension
export type JobEligibility = EligibilityResult

export interface PipelineJob extends NormalizedJob {
  pipeline?: {
    searchEligibility?: FinalJobEligibility
    suppressed?: boolean
    eligibility: JobEligibility
    requirements: JobRequirements
    match?: MatchResult
    excluded: boolean
    exclusionReasons: EligibilityReason[]
    directATS: boolean
  }
}

export interface PipelineArtifact {
  runId: string
  searchProfileId?: number
  searchProfileName?: string
  startedAt: string
  completedAt: string
  candidateProfile?: string | null
  sourceCoverage?: Array<{ name: string; state: string; missingEnv?: string[] }>
  retainedCount?: number
  cohort?: { stage: string; timestamp: string; processedJobIds: string[] }
  sources: {
    attempted: number
    successful: number
    failed: number
    details: SourceRunDetail[]
  }
  ats: {
    attempted: number
    successful: number
    failed: number
    details: Array<{
      companyId: string
      company?: string
      provider: string
      identifier: string
      success: boolean
      snapshotComplete: boolean
      jobsFound: number
      error?: string
    }>
    providers: Array<{
      provider: string
      companiesMonitored: number
      companiesSucceeded: number
      companiesFailed: number
      rawJobs: number
      normalizedJobs: number
      profileEligibleJobs: number
      finalCandidates: number
      uniqueContribution: number
    }>
    companies: Array<{
      companyId: string
      company: string
      provider: string
      identifier: string
      status: "success" | "failed"
      rawJobs: number
      normalizedJobs: number
      profileEligibleJobs: number
      finalCandidates: number
      uniqueContribution: number
      error?: string
    }>
  }
  enrichment: EnrichmentStats
  counts: {
    rawJobs: number
    normalized: number
    afterNormalization: number
    directATS: number
    aggregator: number
    expired: number
    validationFailed: number
    uncertain: number
    duplicatesRemoved: number
    eligibilityPass: number
    eligibilityFail: number
    eligibilityUnknown: number
    finalCandidates: number
  }
  exclusions: {
    profileRoleMismatch: number
    expired: number
    validationFailed: number
    uncertain: number
    location: number
    language: number
    seniority: number
    management: number
    roleMismatch: number
    workAuthorization: number
    employmentType: number
  }
  jobs: PipelineJob[]
}

export interface PipelineOptions {
  candidateProfilePath?: string | null
  searchProfile?: SearchProfileRecord
  suppressionChecker?: (job: NormalizedJob) => Promise<boolean>
  source?: string
  limit?: number
  includeUnvalidated?: boolean
  dryRun?: boolean
  format?: "json" | "plain"
  registryPath?: string
  historyPath?: string
  artifactDir?: string
  now?: Date
  commandRunner?: (command: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>
  sourceRunners?: SourceRunner[]
  atsRunner?: (options: PipelineOptions) => Promise<{ stats: AtsIngestionStats; results: AtsFetchResult[]; jobs: NormalizedJob[] }>
  validator?: (jobs: NormalizedJob[]) => Promise<{ results: NormalizedJob[]; all: NormalizedJob[] }>
  enricher?: (jobs: NormalizedJob[]) => Promise<{ jobs: NormalizedJob[]; stats: EnrichmentStats }>
  detailCachePath?: string
  disableEnrichment?: boolean
  retainedJobs?: NormalizedJob[]
  queryPlanPath?: string
  /** Search terms supplied by a generic SearchProfile-driven discovery run. */
  discoveryQueries?: string[]
  /** Optional generic SearchProfile context for source-level query flags. */
  discoveryLocations?: string[]
  discoveryWorkModels?: string[]
  writeArtifact?: boolean
}

export type SourceRunner = (options: PipelineOptions) => Promise<SourceRunResult>

const DEFAULT_ARTIFACT_DIR = "job_scraper/runs"
const SOURCE_COMMANDS: Record<string, (query: string, limit: number) => string[]> = {
  "linkedin-search": (query, limit) => ["run", ".agents/skills/linkedin-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "adzuna-search": (query, limit) => ["run", ".agents/skills/adzuna-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "freehire-search": (query, limit) => ["run", ".agents/skills/freehire-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--no-description", "--format", "json"],
  "remoteok-search": (query, limit) => ["run", ".agents/skills/remoteok-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "arbeitnow-search": (query, limit) => ["run", ".agents/skills/arbeitnow-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "himalayas-search": (query, limit) => ["run", ".agents/skills/himalayas-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "jobgether-search": (query, limit) => ["run", ".agents/skills/jobgether-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "infosecjobs-search": (query, limit) => ["run", ".agents/skills/infosecjobs-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "remotive-search": (query, limit) => ["run", ".agents/skills/remotive-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "weworkremotely-search": (query, limit) => ["run", ".agents/skills/weworkremotely-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "jobnet-search": (query, limit) => ["run", ".agents/skills/jobnet-search/cli/src/cli.ts", "search", "--search-string", query, "--order", "PublicationDate", "--limit", String(limit), "--format", "json"],
  "jobicy-search": (query, limit) => ["run", ".agents/skills/jobicy-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "jooble-search": (query, limit) => ["run", ".agents/skills/jooble-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--format", "json"],
  "reed-search": (query, limit) => ["run", ".agents/skills/reed-search/cli/src/cli.ts", "search", "--query", query, "--jobage", "14", "--limit", String(limit), "--details", "10", "--format", "json"],
}

export const EXPERIMENTAL_SOURCE_NAMES = ["jobicy-search", "jooble-search", "reed-search"] as const

export function getSourceMissingEnv(sourceName: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (sourceName === "adzuna-search") {
    const missing: string[] = []
    if (!env.ADZUNA_APP_ID?.trim()) missing.push("ADZUNA_APP_ID")
    if (!env.ADZUNA_APP_KEY?.trim()) missing.push("ADZUNA_APP_KEY")
    return missing
  }
  if (sourceName === "reed-search") return env.REED_API_KEY?.trim() ? [] : ["REED_API_KEY"]
  const joobleMarket = sourceName.match(/^jooble-search:([a-z]{2})$/)
  if (joobleMarket) {
    const keyName = `JOOBLE_API_KEY_${joobleMarket[1].toUpperCase()}`
    return env[keyName]?.trim() ? [] : [keyName]
  }
  if (sourceName === "jooble-search") {
    const markets = (env.JOOBLE_MARKETS ?? "at,de,uk").split(",").map((item) => item.trim().toUpperCase()).filter(Boolean)
    const keyNames = markets.map((market) => `JOOBLE_API_KEY_${market}`)
    return keyNames.some((key) => env[key]?.trim()) ? [] : keyNames
  }
  return []
}

function emptySourceDetail(name: string): SourceRunDetail {
  return {
    name,
    attempted: true,
    success: false,
    status: "failed",
    runtimeMs: 0,
    jobsReturned: 0,
    normalizedJobs: 0,
    expiredJobs: 0,
    validationFailures: 0,
    uniqueJobs: 0,
    duplicateJobs: 0,
    finalActionableJobs: 0,
  }
}

function classifyError(message: string, exitCode?: number | null): PipelineSourceStatus {
  if (/timeout|timed out|abort/i.test(message)) return "timeout"
  if (/\b401\b|unauthorized/i.test(message)) return "authorization_failed"
  if (/403|forbidden|cloudflare|blocked/i.test(message)) return "blocked"
  if (/429|rate.?limit/i.test(message)) return "rate_limited"
  if (/\b5\d\d\b|provider/i.test(message)) return "provider_error"
  if (/parse|json|schema|missing/i.test(message)) return "parser_failure"
  return exitCode && exitCode !== 0 ? "failed" : "validation_failure"
}

function parseJobs(data: unknown): NormalizedJob[] {
  if (Array.isArray(data)) return data as NormalizedJob[]
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.results)) return obj.results as NormalizedJob[]
    if (Array.isArray(obj.jobs)) return obj.jobs as NormalizedJob[]
    if (Array.isArray(obj.all)) return obj.all as NormalizedJob[]
  }
  return []
}

export function uniqueKey(job: NormalizedJob): string {
  const ats = job.ats && typeof job.ats === "object" ? job.ats as Record<string, unknown> : {}
  if (ats.provider && ats.companyIdentifier && ats.requisitionId) return `ats:${ats.provider}:${ats.companyIdentifier}:${ats.requisitionId}`
  if (typeof job.canonicalUrl === "string" && job.canonicalUrl) return `url:${normalizeCacheUrl(job.canonicalUrl)}`
  if (typeof job.applicationUrl === "string" && job.applicationUrl) return `url:${normalizeCacheUrl(job.applicationUrl)}`
  if (typeof job.url === "string" && job.url) return `url:${normalizeCacheUrl(job.url)}`
  return `fallback:${normalizeCompanyName(String(job.company ?? ""))}:${normalizeCompanyName(String(job.title ?? ""))}:${String(job.location ?? "")}`
}

function annotateSource(job: NormalizedJob, sourceName: string): NormalizedJob {
  return {
    ...job,
    portal: sourceName.startsWith("jooble-search:") ? sourceName : typeof job.portal === "string" ? job.portal : sourceName,
    source: typeof job.source === "string" ? job.source : sourceName,
    sourceType: job.sourceType === "ats" ? "ats" : "aggregator",
  }
}

async function runCommand(command: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
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

function bunExecutable(): string {
  return process.execPath || "bun"
}

export async function sourceCoverage(): Promise<NonNullable<PipelineArtifact["sourceCoverage"]>> {
  return Promise.all(Object.keys(SOURCE_COMMANDS).map(async (name) => {
    const text = await readFile(`.agents/skills/${name}/SKILL.md`, "utf8").catch(() => "enabled: false")
    const disabled = /^enabled:\s*false\b/m.test(text)
    const missingEnv = getSourceMissingEnv(name)
    return { name, state: disabled ? "disabled" : missingEnv.length ? "missing_credentials" : "enabled", ...(missingEnv.length ? { missingEnv } : {}) }
  })).then((rows) => rows.flatMap((row) => row.name !== "jooble-search" ? [row] :
    (process.env.JOOBLE_MARKETS ?? "at,de,uk").split(",").map((market) => {
      const name = `jooble-search:${market.trim().toLowerCase()}`
      const missingEnv = getSourceMissingEnv(name)
      return { name, state: row.state === "disabled" ? "disabled" : missingEnv.length ? "missing_credentials" : "enabled", missingEnv }
    })))
}

export async function loadQueryPlan(path = ".claude/skills/job-scraper/query-plan.json"): Promise<{ queries: string[]; pages: number; limit: number; paidQueries: string[] }> {
  const fallback = { queries: [], pages: 1, limit: 20, paidQueries: [] as string[] }
  try {
    const data = JSON.parse(await readFile(path, "utf8"))
    if (!Array.isArray(data.queries) || data.queries.some((q: unknown) => typeof q !== "string" || !q.trim())) throw new Error("Invalid query plan")
    return { queries: [...new Set<string>(data.queries)], pages: Math.max(1, Math.min(3, Number(data.pages) || 1)), limit: Math.max(1, Math.min(50, Number(data.limit) || 20)), paidQueries: data.paidQueries ?? fallback.paidQueries }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback
    throw error
  }
}

export async function diagnoseSourceSelection(
  skillsDir = ".agents/skills",
  searchProfile?: SearchProfileRecord,
): Promise<SourceSelectionDiagnostic[]> {
  const { readdir } = await import("node:fs/promises")
  const dirs = await readdir(skillsDir, { withFileTypes: true })
  const diagnostics: SourceSelectionDiagnostic[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    if (dir.name !== "jooble-search" && !SOURCE_COMMANDS[dir.name]) continue
    const skillPath = `${skillsDir}/${dir.name}/SKILL.md`
    let text = ""
    try {
      text = await readFile(skillPath, "utf8")
    } catch {
      continue
    }
    const frontmatter = text.startsWith("---") ? text.split("---", 3)[1] ?? "" : ""
    const enabled = !/^enabled:\s*false\b/m.test(frontmatter)
    const capability = parseSourceCapability(frontmatter)
    if (dir.name === "jooble-search") {
      for (const market of (process.env.JOOBLE_MARKETS ?? "at,de,uk").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)) {
        const name = `jooble-search:${market}`
        diagnostics.push(evaluateSourceApplicability(name, capability, enabled, getSourceMissingEnv(name), searchProfile))
      }
    } else {
      diagnostics.push(evaluateSourceApplicability(dir.name, capability, enabled, getSourceMissingEnv(dir.name), searchProfile))
    }
  }
  return diagnostics.sort((a, b) => a.provider.localeCompare(b.provider))
}

export async function discoverEnabledSourceNames(
  skillsDir = ".agents/skills",
  searchProfile?: SearchProfileRecord,
): Promise<string[]> {
  const diagnostics = await diagnoseSourceSelection(skillsDir, searchProfile)
  return diagnostics.filter((item) => item.selected).map((item) => item.provider)
}

export function makeCliSourceRunnerWithCommand(sourceName: string, build: (query: string, limit: number) => string[]): SourceRunner {
  return async (options) => {
    const startedAt = Date.now()
    const detail = emptySourceDetail(sourceName)
    const hasProfileQueries = Boolean(options.discoveryQueries?.length)
    const plan = hasProfileQueries
      ? { queries: options.discoveryQueries ?? [], pages: 1, limit: 20, paidQueries: options.discoveryQueries ?? [] }
      : await loadQueryPlan(options.queryPlanPath)
    const limit = Math.max(1, Math.min(options.limit ?? plan.limit, 50))
    const paid = /^(jooble|reed|adzuna)-search/.test(sourceName)
    const queries = options.discoveryQueries?.length
      ? [...new Set(options.discoveryQueries.map((query) => query.trim()).filter(Boolean))]
      : paid ? plan.paidQueries : plan.queries
    if (!queries.length) throw new Error("Search terms must come from the active SearchProfile or an explicit research query plan")
    const weekly = (options.now ?? new Date()).getDay() === 0
    const pages = !paid && /^(linkedin|himalayas|arbeitnow|jobgether|infosecjobs)-search$/.test(sourceName) ? weekly ? Math.min(3, plan.pages + 1) : plan.pages : 1
    const errors: string[] = []
    const byKey = new Map<string, NormalizedJob>()
    const finish = (patch: Partial<SourceRunDetail>, jobs = [...byKey.values()]): SourceRunResult => ({
      detail: { ...detail, jobsReturned: jobs.length, uniqueJobs: jobs.length, ...patch, runtimeMs: Date.now() - startedAt },
      jobs,
    })
    for (const query of queries) {
      detail.queriesAttempted = (detail.queriesAttempted ?? 0) + 1
      for (let page = 1; page <= pages; page++) {
      const args = build(query, limit)
      const locations = [...new Set(options.discoveryLocations?.map((value) => value.trim()).filter(Boolean) ?? [])]
      // A single provider filter cannot express a profile's OR of regions.
      // LinkedIn requires one location; Europe is one broad acquisition scope
      // for the profile's European OR-list, with eligibility checked later.
      const linkedinScope = locations.some((value) => /^(?:europe|eu|eea|emea)$/i.test(value)) ? "Europe"
        : locations.find((value) => !/^(?:worldwide|global|anywhere)$/i.test(value)) ?? "Remote"
      const providerLocation = sourceName === "linkedin-search" ? linkedinScope
        : locations.length === 1 && !/^(worldwide|global|anywhere)$/i.test(locations[0]) ? locations[0] : undefined
      if (locations.length && !providerLocation && args.includes("--location")) {
        args.splice(args.indexOf("--location"), 2)
      } else if (providerLocation && args.includes("--location")) {
        const locationIndex = args.indexOf("--location")
        args[locationIndex + 1] = providerLocation
      } else if (providerLocation && !["remotive-search", "weworkremotely-search", "jobnet-search"].includes(sourceName)) {
        args.push("--location", providerLocation)
      }
      const configuredModels = options.discoveryWorkModels ?? []
      const remoteOnly = configuredModels.length === 1 && configuredModels[0] === "remote"
      if (remoteOnly && ["linkedin-search", "freehire-search"].includes(sourceName)) {
        args.push("--remote", "remote")
      }
      detail.pagesAttempted = (detail.pagesAttempted ?? 0) + 1
      if (weekly && !paid && args.includes("--jobage")) args[args.indexOf("--jobage") + 1] = "30"
      if (pages > 1) args.push("--page", String(page))
      const result = await (options.commandRunner ?? runCommand)(bunExecutable(), args)
      if (result.timedOut) {
        errors.push("source command timed out"); break
      }
      if (result.code !== 0) {
        const message = result.stderr || result.stdout || `exit code ${result.code}`
        const category = classifyError(message, result.code)
        if (["authorization_failed", "rate_limited", "blocked"].includes(category) || /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return finish({ status: category, errorCategory: category, error: message.trim() })
        errors.push(message.trim()); break
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error)); break
      }
      const pageJobs = parseJobs(parsed)
      for (const job of pageJobs.map((item) => annotateSource(item, sourceName))) {
        const key = uniqueKey(job)
        const existing = byKey.get(key)
        const existingMetadata = existing?.metadata && typeof existing.metadata === "object"
          ? existing.metadata as Record<string, unknown>
          : {}
        const existingQueries = Array.isArray(existingMetadata.acquisitionQueries)
          ? existingMetadata.acquisitionQueries.filter((value): value is string => typeof value === "string")
          : []
        const acquisitionQueries = [...new Set([...existingQueries, query])]
        byKey.set(key, {
          ...job,
          metadata: {
            ...existingMetadata,
            ...job.metadata,
            acquisition: { source: sourceName, query, page, fetchedAt: nowIso(options.now ?? new Date()) },
            acquisitionQueries,
          },
        })
      }
      }
    }
    const jobs = [...byKey.values()]
    return finish({
      success: errors.length === 0,
      ...(errors.length ? { error: errors.join("; "), errorCategory: classifyError(errors[0]) } : {}),
      status: errors.length ? jobs.length ? "partial" : classifyError(errors[0]) : jobs.length === 0 ? "zero_results" : "success",
      jobsReturned: jobs.length,
      uniqueJobs: jobs.length,
    }, jobs)
  }
}

export function makeCliSourceRunner(sourceName: string): SourceRunner {
  const market = sourceName.match(/^jooble-search:([a-z]{2})$/)?.[1]
  const base = SOURCE_COMMANDS[market ? "jooble-search" : sourceName]
  const build = market && base ? (query: string, limit: number) => [...base(query, limit), "--market", market] : base
  if (!build) {
    return async () => ({ detail: { ...emptySourceDetail(sourceName), status: "failed", errorCategory: "failed", error: "no pipeline command mapping for source" }, jobs: [] })
  }
  return makeCliSourceRunnerWithCommand(sourceName, build)
}

function sourceForStats(job: NormalizedJob): string {
  return String(job.portal ?? job.source ?? "unknown")
}

export function evaluateEligibility(job: NormalizedJob, candidate: CandidateProfile | null): JobEligibility {
  return evaluateCandidateEligibility(candidate, extractJobRequirements(job))
}

function sourceStatsMap(details: SourceRunDetail[]): Map<string, SourceRunDetail> {
  return new Map(details.map((detail) => [detail.name, { ...detail }]))
}

function incrementSource(details: Map<string, SourceRunDetail>, job: PipelineJob, field: "normalizedJobs" | "expiredJobs" | "validationFailures" | "finalActionableJobs"): void {
  const source = sourceForStats(job)
  const detail = details.get(source)
  if (detail) detail[field] += 1
}

function summarizeAts(results: AtsFetchResult[]): PipelineArtifact["ats"]["details"] {
  return results.map((result) => ({
    companyId: result.companyId,
    company: result.allJobs[0]?.company ?? result.jobs[0]?.company,
    provider: result.provider,
    identifier: result.identifier,
    success: result.success,
    snapshotComplete: result.snapshotComplete,
    jobsFound: result.allJobs.length,
    error: result.error,
  }))
}

function summarizeAtsCompanies(results: AtsFetchResult[], jobs: PipelineJob[], finalJobs: PipelineJob[]): PipelineArtifact["ats"]["companies"] {
  return results.map((result) => {
    const companyJobs = jobs.filter((job) => job.sourceType === "ats" && job.companyId === result.companyId)
    const finalCompanyJobs = finalJobs.filter((job) => job.sourceType === "ats" && job.companyId === result.companyId)
    const company = result.allJobs[0]?.company ?? result.jobs[0]?.company ?? result.companyId
    return {
      companyId: result.companyId,
      company: String(company),
      provider: result.provider,
      identifier: result.identifier,
      status: result.success ? "success" : "failed",
      rawJobs: result.allJobs.length,
      normalizedJobs: result.jobs.length,
      profileEligibleJobs: companyJobs.filter((job) => job.pipeline?.searchEligibility?.actionable).length,
      finalCandidates: finalCompanyJobs.length,
      uniqueContribution: finalCompanyJobs.length,
      ...(result.error ? { error: result.error } : {}),
    }
  })
}

function summarizeAtsProviders(companies: PipelineArtifact["ats"]["companies"]): PipelineArtifact["ats"]["providers"] {
  const byProvider = new Map<string, PipelineArtifact["ats"]["providers"][number]>()
  for (const company of companies) {
    const current = byProvider.get(company.provider) ?? {
      provider: company.provider,
      companiesMonitored: 0,
      companiesSucceeded: 0,
      companiesFailed: 0,
      rawJobs: 0,
      normalizedJobs: 0,
      profileEligibleJobs: 0,
      finalCandidates: 0,
      uniqueContribution: 0,
    }
    current.companiesMonitored += 1
    if (company.status === "success") current.companiesSucceeded += 1
    else current.companiesFailed += 1
    current.rawJobs += company.rawJobs
    current.normalizedJobs += company.normalizedJobs
    current.profileEligibleJobs += company.profileEligibleJobs
    current.finalCandidates += company.finalCandidates
    current.uniqueContribution += company.uniqueContribution
    byProvider.set(company.provider, current)
  }
  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider))
}

async function saveArtifact(artifact: PipelineArtifact, dir = DEFAULT_ARTIFACT_DIR): Promise<string> {
  const path = resolve(dir, `${artifact.startedAt.replace(/[:.]/g, "-")}-${artifact.runId}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
  return path
}

export async function runJobPipeline(options: PipelineOptions = {}): Promise<{ artifact: PipelineArtifact; artifactPath?: string }> {
  const started = nowIso(options.now ?? new Date())
  const sourceNames = options.source
    ? [options.source]
    : options.sourceRunners
      ? []
      : await discoverEnabledSourceNames(".agents/skills", options.searchProfile)
  const sourceRunners = options.sourceRunners ?? sourceNames.map(makeCliSourceRunner)
  const sourceResults = await Promise.all(sourceRunners.map((runner) => runner(options)))
  const sourceDetails = sourceResults.map((result) => result.detail)
  const freshJobs = sourceResults.flatMap((result) => result.jobs).map((job) => ({ ...job, metadata: { ...job.metadata, lastDiscoveredAt: started } }))
  const freshKeys = new Set(freshJobs.map(uniqueKey))
  const retained = (options.retainedJobs ?? []).filter((job) => !freshKeys.has(uniqueKey(job)))
  const rawAggregatorJobs = [...freshJobs, ...retained]
  const normalizedAggregatorJobs = rawAggregatorJobs.filter((job) => job && typeof job === "object")
  const validator = options.validator ?? ((jobs: NormalizedJob[]) => validateJobs(jobs, { includeUnvalidated: options.includeUnvalidated, concurrency: 6 }))
  const validated = await validator(normalizedAggregatorJobs)
  const atsRunner = options.atsRunner ?? ((runnerOptions: PipelineOptions) => runAtsJobIngestion({
    registryPath: runnerOptions.registryPath ?? DEFAULT_REGISTRY_PATH,
    historyPath: runnerOptions.historyPath,
    dryRun: runnerOptions.dryRun,
    now: runnerOptions.now,
  }))
  const atsResult = await atsRunner(options)
  const directAtsJobs = atsResult.jobs.map((job) => ({ ...job, sourceType: "ats" as const }))
  const enrichmentInput = [...validated.all, ...directAtsJobs]
  const enrichmentResult = options.disableEnrichment
    ? { jobs: enrichmentInput, stats: emptyEnrichmentStats(0) satisfies EnrichmentStats }
    : await (options.enricher ?? ((jobs: NormalizedJob[]) => enrichJobs(jobs, {
      now: options.now,
      cachePath: options.detailCachePath,
      concurrency: 3,
      maxJobs: 30,
    })))(enrichmentInput)
  const validatedAggregatorAll = enrichmentResult.jobs.slice(0, validated.all.length)
  const enrichedDirectAtsJobs = enrichmentResult.jobs.slice(validated.all.length).map((job) => ({ ...job, sourceType: "ats" as const }))
  const validationAllowedKeys = new Set(validated.results.map(uniqueKey))
  const validationAllowed = validatedAggregatorAll.filter((job, index) => validationAllowedKeys.has(uniqueKey(validated.all[index])))

  const mergePool = [...validationAllowed, ...enrichedDirectAtsJobs]
  const deduped = dedupePreferDirectAts(mergePool) as PipelineJob[]
  const duplicatesRemoved = Math.max(0, mergePool.length - deduped.length)
  const candidate = await loadCandidateProfile(options.candidateProfilePath)
  const allJobsForAudit = dedupePreferDirectAts([...validatedAggregatorAll, ...enrichedDirectAtsJobs]) as PipelineJob[]
  const byFinalKey = new Set(deduped.map(uniqueKey))
  const jobs = await Promise.all(allJobsForAudit.map(async (job) => {
    const requirements = extractJobRequirements(job)
    const eligibility = evaluateCandidateEligibility(candidate, requirements)
    const match = candidate && (eligibility.status === "pass" || eligibility.status === "unknown") ? matchCandidateToJob(candidate, job, eligibility, requirements) : undefined
    const discovered = normalizeDiscoveredJob(job, String(job.source ?? "unknown"))
    const searchEligibility = options.searchProfile && discovered
      ? evaluateFinalJobEligibility({ ...discovered, validation: job.validation }, options.searchProfile)
      : undefined
    const suppressed = Boolean(options.suppressionChecker && searchEligibility?.actionable && await options.suppressionChecker(job))
    const excluded = job.validation?.status === "expired" || Boolean(searchEligibility && !searchEligibility.actionable) || suppressed || !byFinalKey.has(uniqueKey(job))
    const exclusionReasons = [
      ...(job.validation?.status === "expired" ? ["expired" as EligibilityReason] : []),
      ...(!searchEligibility && eligibility.status === "fail" ? eligibility.reasons : []),
    ]
    return {
      ...job,
      pipeline: {
        searchEligibility,
        suppressed,
        eligibility,
        requirements,
        match,
        excluded,
        exclusionReasons,
        directATS: job.sourceType === "ats",
      },
    }
  }))

  const finalJobs = jobs
    .filter((job) => byFinalKey.has(uniqueKey(job))
      && (options.searchProfile ? job.pipeline?.searchEligibility?.actionable === true && !job.pipeline.suppressed : job.pipeline?.eligibility.status !== "fail")
      && job.validation?.status !== "expired")
    .sort((a, b) => (b.pipeline?.match?.overallScore ?? -1) - (a.pipeline?.match?.overallScore ?? -1) || String(a.company ?? "").localeCompare(String(b.company ?? "")) || String(a.title ?? "").localeCompare(String(b.title ?? "")))
  const detailMap = sourceStatsMap(sourceDetails)
  const duplicateKeys = new Set(
    [...mergePool.reduce((counts, job) => counts.set(uniqueKey(job), (counts.get(uniqueKey(job)) ?? 0) + 1), new Map<string, number>()).entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key),
  )
  for (const job of jobs) {
    if (job.sourceType !== "ats") {
      incrementSource(detailMap, job, "normalizedJobs")
      if (job.validation?.status === "expired") incrementSource(detailMap, job, "expiredJobs")
      if (job.validation?.status === "validation_failed") incrementSource(detailMap, job, "validationFailures")
      if (duplicateKeys.has(uniqueKey(job))) {
        const detail = detailMap.get(sourceForStats(job))
        if (detail) detail.duplicateJobs += 1
      }
    }
  }
  for (const job of finalJobs) if (job.sourceType !== "ats") incrementSource(detailMap, job, "finalActionableJobs")
  const finalSourceDetails = [...detailMap.values()]
  const atsCompanies = summarizeAtsCompanies(atsResult.results, jobs, finalJobs)

  const countValidation = (status: AvailabilityValidation["status"]) => jobs.filter((job) => job.validation?.status === status && job.sourceType !== "ats").length
  const completed = nowIso(new Date())
  const artifact: PipelineArtifact = {
    runId: randomUUID(),
    searchProfileId: options.searchProfile?.id,
    searchProfileName: options.searchProfile?.name,
    cohort: {
      stage: "source_validation_enrichment_search_profile_eligibility",
      timestamp: started,
      processedJobIds: [...new Set(allJobsForAudit.map((job) => uniqueKey(job)))],
    },
    startedAt: started,
    completedAt: completed,
    candidateProfile: options.candidateProfilePath ?? null,
    sourceCoverage: options.sourceRunners ? [] : await sourceCoverage(),
    retainedCount: retained.length,
    sources: {
      attempted: sourceResults.length,
      successful: finalSourceDetails.filter((detail) => detail.success).length,
      failed: finalSourceDetails.filter((detail) => !detail.success).length,
      details: finalSourceDetails,
    },
    ats: {
      attempted: atsResult.results.length,
      successful: atsResult.results.filter((result) => result.success).length,
      failed: atsResult.results.filter((result) => !result.success).length,
      details: summarizeAts(atsResult.results),
      providers: summarizeAtsProviders(atsCompanies),
      companies: atsCompanies,
    },
    enrichment: enrichmentResult.stats,
    counts: {
      rawJobs: rawAggregatorJobs.length + atsResult.stats.totalJobsFetched,
      normalized: normalizedAggregatorJobs.length + atsResult.stats.totalJobsFetched,
      afterNormalization: normalizedAggregatorJobs.length + directAtsJobs.length,
      directATS: directAtsJobs.length,
      aggregator: validationAllowed.length,
      expired: countValidation("expired"),
      validationFailed: countValidation("validation_failed"),
      uncertain: countValidation("uncertain"),
      duplicatesRemoved,
      eligibilityPass: jobs.filter((job) => job.pipeline?.eligibility.status === "pass").length,
      eligibilityFail: jobs.filter((job) => job.pipeline?.eligibility.status === "fail").length,
      eligibilityUnknown: jobs.filter((job) => job.pipeline?.eligibility.status === "unknown").length,
      finalCandidates: finalJobs.length,
    },
    exclusions: {
      profileRoleMismatch: jobs.filter((job) => job.pipeline?.searchEligibility && ["unrelated", "excluded"].includes(job.pipeline.searchEligibility.role)).length,
      expired: countValidation("expired"),
      validationFailed: countValidation("validation_failed"),
      uncertain: countValidation("uncertain"),
      location: jobs.filter((job) => job.pipeline?.eligibility.reasons.includes("location")).length,
      language: jobs.filter((job) => job.pipeline?.eligibility.reasons.includes("language")).length,
      seniority: jobs.filter((job) => job.pipeline?.eligibility.reasons.includes("seniority")).length,
      management: jobs.filter((job) => job.pipeline?.eligibility.reasons.includes("management")).length,
      roleMismatch: jobs.filter((job) => job.pipeline?.eligibility.reasons.includes("roleMismatch")).length,
      workAuthorization: jobs.filter((job) => job.pipeline?.eligibility.reasons.includes("workAuthorization")).length,
      employmentType: jobs.filter((job) => job.pipeline?.eligibility.reasons.includes("employmentType")).length,
    },
    jobs: [...finalJobs, ...jobs.filter((job) => !finalJobs.includes(job))],
  }
  const artifactPath = options.writeArtifact === false || options.dryRun ? undefined : await saveArtifact(artifact, options.artifactDir)
  return { artifact, artifactPath }
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
    if (["candidate", "format", "source", "limit", "registry", "history", "artifact-dir", "detail-cache", "user-id"].includes(key)) parsed[key] = argv[++i]
    else parsed[key] = true
  }
  return parsed
}

function formatPlain(artifact: PipelineArtifact, artifactPath?: string): string {
  return [
    `Run: ${artifact.runId}`,
    artifactPath ? `Artifact: ${artifactPath}` : "Artifact: not written",
    `Sources: ${artifact.sources.successful}/${artifact.sources.attempted} successful`,
    `Raw jobs: ${artifact.counts.rawJobs}`,
    `Jobs after normalization: ${artifact.counts.afterNormalization}`,
    `Direct ATS: ${artifact.counts.directATS}`,
    formatEnrichmentSummary(artifact.enrichment),
    `Expired: ${artifact.counts.expired}`,
    `Validation failed: ${artifact.counts.validationFailed}`,
    `Eligibility pass/fail/unknown: ${artifact.counts.eligibilityPass}/${artifact.counts.eligibilityFail}/${artifact.counts.eligibilityUnknown}`,
    `Final candidates: ${artifact.counts.finalCandidates}`,
  ].join("\n")
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (command !== "run") {
    process.stderr.write("usage: bun run tools/job_pipeline.ts run [--candidate path] [--source name] [--limit n] [--include-unvalidated] [--disable-enrichment] [--detail-cache path] [--dry-run] [--format json|plain]\n")
    return 2
  }
  const userId = typeof args["user-id"] === "string" ? args["user-id"].trim() : process.env.AI_JOB_SEARCH_USER_ID?.trim()
  if (!userId) throw new Error("Pipeline runtime requires --user-id or AI_JOB_SEARCH_USER_ID")
  const { createSupabaseDiscoveryStoreFromEnv, buildSearchQueries } = await import("./generic_discovery")
  const searchProfile = await (await createSupabaseDiscoveryStoreFromEnv()).getActiveSearchProfile(userId)
  const result = await runJobPipeline({
    candidateProfilePath: typeof args.candidate === "string" ? args.candidate : null,
    searchProfile,
    discoveryQueries: buildSearchQueries(searchProfile, "broad"),
    source: typeof args.source === "string" ? args.source : undefined,
    limit: typeof args.limit === "string" ? Number(args.limit) : undefined,
    includeUnvalidated: Boolean(args["include-unvalidated"]),
    dryRun: Boolean(args["dry-run"]),
    format: args.format === "plain" ? "plain" : "json",
    registryPath: typeof args.registry === "string" ? args.registry : DEFAULT_REGISTRY_PATH,
    historyPath: typeof args.history === "string" ? args.history : undefined,
    artifactDir: typeof args["artifact-dir"] === "string" ? args["artifact-dir"] : undefined,
    detailCachePath: typeof args["detail-cache"] === "string" ? args["detail-cache"] : undefined,
    disableEnrichment: Boolean(args["disable-enrichment"]),
  })
  if (args.format === "plain") process.stdout.write(`${formatPlain(result.artifact, result.artifactPath)}\n`)
  else process.stdout.write(`${JSON.stringify({ artifactPath: result.artifactPath, ...result.artifact }, null, 2)}\n`)
  return 0
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
