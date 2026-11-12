import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { normalizeCompanyName, type AtsProvider, type NormalizedJob } from "./company_registry"

export const JOB_HISTORY_SCHEMA_VERSION = 1
export const DEFAULT_JOB_HISTORY_PATH = "job_history/jobs.json"

export interface HistoricalJob {
  id: string
  companyId: string
  companyName: string
  sourceType: "ats" | "aggregator"
  source: string
  ats?: {
    provider: AtsProvider | string
    companyIdentifier: string
    requisitionId: string
  }
  title: string
  normalizedTitle?: string
  location?: string | null
  canonicalUrl?: string | null
  applicationUrl?: string | null
  descriptionHash?: string | null
  firstSeen: string
  lastSeen: string
  firstPostedAt?: string | null
  lastPostedAt?: string | null
  status: "active" | "closed" | "unknown"
  timesObserved: number
  disappearedAt?: string | null
  reappearedAt?: string | null
  reappearanceCount?: number
  possibleRepostOf?: string | null
  repostSimilarity?: number | null
  closedAt?: string | null
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface AtsFetchState {
  companyId: string
  provider: AtsProvider | string
  identifier: string
  lastAttemptedAt: string
  lastSuccessfulAt?: string | null
  lastJobCount?: number | null
  snapshotComplete: boolean
  persistencePending?: boolean
  lastError?: string | null
  updatedAt: string
}

export interface JobHistoryData {
  schemaVersion: number
  jobs: Record<string, HistoricalJob>
  fetchState: Record<string, AtsFetchState>
}

export interface UpsertHistoryStats {
  created: number
  updated: number
  closed: number
  reappeared: number
  repostCandidates: number
  unchanged: number
  closedJobIds: string[]
}

export function emptyJobHistory(): JobHistoryData {
  return { schemaVersion: JOB_HISTORY_SCHEMA_VERSION, jobs: {}, fetchState: {} }
}

export function normalizeJobDescription(input: unknown): string {
  if (typeof input !== "string") return ""
  return input
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt);/gi, (_entity, name: string) => ({ nbsp: " ", amp: "&", lt: "<", gt: ">" })[name.toLowerCase() as "nbsp" | "amp" | "lt" | "gt"])
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

export function descriptionHash(description: unknown): string | null {
  const normalized = normalizeJobDescription(description)
  if (!normalized) return null
  return createHash("sha256").update(normalized).digest("hex")
}

export function stableHistoricalJobId(job: NormalizedJob): string {
  const companyId = typeof job.companyId === "string" ? job.companyId : "unknown_company"
  const ats = job.ats && typeof job.ats === "object" ? job.ats as Record<string, unknown> : {}
  const provider = typeof ats.provider === "string" ? ats.provider : "unknown_provider"
  const requisitionId = typeof ats.requisitionId === "string" ? ats.requisitionId : String(job.id ?? job.url ?? "")
  const raw = `${companyId}|${provider}|${requisitionId}`
  return `hist_${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`
}

function tokenSet(text: string): Set<string> {
  return new Set(text.split(/[^a-z0-9]+/i).filter((token) => token.length >= 3))
}

export function jaccardSimilarity(a: string, b: string): number {
  const left = tokenSet(a)
  const right = tokenSet(b)
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

function postedAt(job: NormalizedJob): string | null {
  for (const key of ["postedAt", "date"] as const) {
    const value = job[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function toHistoricalJob(job: NormalizedJob, now: string): HistoricalJob {
  const ats = job.ats && typeof job.ats === "object" ? job.ats as Record<string, unknown> : {}
  const title = typeof job.title === "string" ? job.title : "Unknown role"
  const firstPostedAt = postedAt(job)
  return {
    id: stableHistoricalJobId(job),
    companyId: typeof job.companyId === "string" ? job.companyId : "unknown_company",
    companyName: typeof job.company === "string" ? job.company : "Unknown company",
    sourceType: job.sourceType === "ats" ? "ats" : "aggregator",
    source: typeof job.source === "string" ? job.source : "unknown",
    ats: typeof ats.provider === "string" && typeof ats.companyIdentifier === "string" && typeof ats.requisitionId === "string"
      ? { provider: ats.provider, companyIdentifier: ats.companyIdentifier, requisitionId: ats.requisitionId }
      : undefined,
    title,
    normalizedTitle: normalizeCompanyName(title),
    location: typeof job.location === "string" ? job.location : null,
    canonicalUrl: typeof job.canonicalUrl === "string" ? job.canonicalUrl : typeof job.url === "string" ? job.url : null,
    applicationUrl: typeof job.applicationUrl === "string" ? job.applicationUrl : null,
    descriptionHash: descriptionHash(job.description),
    firstSeen: now,
    lastSeen: now,
    firstPostedAt,
    lastPostedAt: firstPostedAt,
    status: "active",
    timesObserved: 1,
    disappearedAt: null,
    reappearedAt: null,
    reappearanceCount: 0,
    possibleRepostOf: null,
    repostSimilarity: null,
    closedAt: null,
    metadata: typeof job.metadata === "object" && job.metadata !== null ? job.metadata as Record<string, unknown> : {},
    createdAt: now,
    updatedAt: now,
  }
}

function sameLocation(a: HistoricalJob, b: HistoricalJob): boolean {
  return (a.location ?? "").trim().toLowerCase() === (b.location ?? "").trim().toLowerCase()
}

function findPossibleRepost(newJob: HistoricalJob, existingJobs: HistoricalJob[], now: string): { id: string; similarity: number } | null {
  const closed = existingJobs.filter((job) => (
    job.companyId === newJob.companyId &&
    job.status === "closed" &&
    job.ats?.requisitionId !== newJob.ats?.requisitionId &&
    job.closedAt &&
    Date.parse(now) - Date.parse(job.closedAt) <= 120 * 24 * 60 * 60 * 1000
  ))
  let best: { id: string; similarity: number } | null = null
  for (const old of closed) {
    if (old.normalizedTitle !== newJob.normalizedTitle) continue
    if (!sameLocation(old, newJob)) continue
    let similarity = 0
    if (old.descriptionHash && newJob.descriptionHash && old.descriptionHash === newJob.descriptionHash) similarity = 1
    else {
      const oldText = typeof old.metadata?.descriptionText === "string" ? old.metadata.descriptionText : ""
      const newText = typeof newJob.metadata?.descriptionText === "string" ? newJob.metadata.descriptionText : ""
      similarity = jaccardSimilarity(oldText, newText)
    }
    if (similarity >= 0.95 || similarity >= 0.85) {
      if (!best || similarity > best.similarity) best = { id: old.id, similarity }
    }
  }
  return best
}

export class JsonJobHistoryStore {
  private data: JobHistoryData
  private path: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(path = DEFAULT_JOB_HISTORY_PATH, data: JobHistoryData = emptyJobHistory()) {
    this.path = resolve(path)
    this.data = data
  }

  static async load(path = DEFAULT_JOB_HISTORY_PATH): Promise<JsonJobHistoryStore> {
    const resolved = resolve(path)
    let data: JobHistoryData
    try {
      data = JSON.parse(await readFile(resolved, "utf8")) as JobHistoryData
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") data = emptyJobHistory()
      else throw new Error(`Unable to read job history at ${resolved}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (data.schemaVersion !== JOB_HISTORY_SCHEMA_VERSION || !data.jobs || !data.fetchState) {
      throw new Error(`Unsupported or corrupt job history at ${resolved}`)
    }
    return new JsonJobHistoryStore(resolved, data)
  }

  snapshot(): JobHistoryData {
    return JSON.parse(JSON.stringify(this.data)) as JobHistoryData
  }

  get(id: string): HistoricalJob | null {
    return this.data.jobs[id] ?? null
  }

  list(): HistoricalJob[] {
    return Object.values(this.data.jobs).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
  }

  stats(): Record<string, number> {
    const jobs = this.list()
    return {
      historicalJobs: jobs.length,
      active: jobs.filter((job) => job.status === "active").length,
      closed: jobs.filter((job) => job.status === "closed").length,
      unknown: jobs.filter((job) => job.status === "unknown").length,
      reappeared: jobs.filter((job) => (job.reappearanceCount ?? 0) > 0).length,
      potentialReposts: jobs.filter((job) => job.possibleRepostOf).length,
      companiesObserved: new Set(jobs.map((job) => job.companyId)).size,
    }
  }

  upsertSnapshot(input: { companyId: string; companyName: string; source: string; provider: string; identifier: string; jobs: NormalizedJob[]; fetchedAt: string; snapshotComplete: boolean }): UpsertHistoryStats {
    const stats: UpsertHistoryStats = { created: 0, updated: 0, closed: 0, reappeared: 0, repostCandidates: 0, unchanged: 0, closedJobIds: [] }
    const seenIds = new Set<string>()
    const existingBefore = this.list()
    for (const job of input.jobs) {
      const id = stableHistoricalJobId(job)
      seenIds.add(id)
      const existing = this.data.jobs[id]
      if (!existing) {
        const created = toHistoricalJob(job, input.fetchedAt)
        const repost = findPossibleRepost(created, existingBefore, input.fetchedAt)
        if (repost) {
          created.possibleRepostOf = repost.id
          created.repostSimilarity = repost.similarity
          stats.repostCandidates += 1
        }
        this.data.jobs[id] = created
        stats.created += 1
        continue
      }
      const wasClosed = existing.status === "closed"
      existing.lastSeen = input.fetchedAt
      existing.timesObserved += 1
      existing.status = "active"
      existing.updatedAt = input.fetchedAt
      existing.closedAt = null
      if (wasClosed) {
        existing.reappearedAt = input.fetchedAt
        existing.reappearanceCount = (existing.reappearanceCount ?? 0) + 1
        stats.reappeared += 1
      }
      const latest = toHistoricalJob(job, input.fetchedAt)
      existing.title = latest.title
      existing.normalizedTitle = latest.normalizedTitle
      existing.location = latest.location
      existing.canonicalUrl = latest.canonicalUrl
      existing.applicationUrl = latest.applicationUrl
      existing.descriptionHash = latest.descriptionHash
      existing.lastPostedAt = latest.lastPostedAt ?? existing.lastPostedAt ?? null
      existing.metadata = { ...(existing.metadata ?? {}), ...(latest.metadata ?? {}) }
      stats.updated += 1
    }

    if (input.snapshotComplete) {
      for (const job of Object.values(this.data.jobs)) {
        if (
          job.companyId === input.companyId &&
          job.sourceType === "ats" &&
          job.ats?.provider === input.provider &&
          job.ats?.companyIdentifier === input.identifier &&
          job.status === "active" &&
          !seenIds.has(job.id)
        ) {
          job.status = "closed"
          job.disappearedAt = input.fetchedAt
          job.closedAt = input.fetchedAt
          job.updatedAt = input.fetchedAt
          stats.closed += 1
          stats.closedJobIds.push(job.id)
        }
      }
    }
    return stats
  }

  recordFetchState(state: AtsFetchState): void {
    this.data.fetchState[`${state.companyId}:${state.provider}:${state.identifier}`] = state
  }

  async commitSuccessfulFetches(results: Array<{ companyId: string; provider: string; identifier: string; fetchedAt: string; success: boolean; snapshotComplete: boolean }>): Promise<void> {
    for (const result of results) {
      if (!result.success || !result.snapshotComplete) continue
      const key = `${result.companyId}:${result.provider}:${result.identifier}`
      const state = this.data.fetchState[key]
      if (!state || !state.persistencePending) continue
      this.data.fetchState[key] = {
        ...state,
        lastSuccessfulAt: result.fetchedAt,
        snapshotComplete: true,
        persistencePending: false,
        lastError: null,
        updatedAt: result.fetchedAt,
      }
    }
    await this.save()
  }

  getFetchState(companyId: string, provider?: string, identifier?: string): AtsFetchState | undefined {
    if (provider && identifier) return this.data.fetchState[`${companyId}:${provider}:${identifier}`]
    return Object.values(this.data.fetchState).find((state) => state.companyId === companyId)
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
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8")
  const handle = await open(tmp, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, resolved)
}

function print(data: unknown, format: string): void {
  process.stdout.write(format === "json" ? `${JSON.stringify(data, null, 2)}\n` : `${data}\n`)
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const command = args[0]
  const format = args.includes("--format") && args[args.indexOf("--format") + 1] === "json" ? "json" : "plain"
  const historyPath = args.includes("--history") ? args[args.indexOf("--history") + 1] : DEFAULT_JOB_HISTORY_PATH
  const store = await JsonJobHistoryStore.load(historyPath)
  if (command === "stats") {
    print(store.stats(), format)
    return 0
  }
  if (command === "show") {
    const id = args[1]
    const job = id ? store.get(id) : null
    print(job ?? "not found", format)
    return job ? 0 : 1
  }
  if (command === "active" || command === "closed" || command === "reposts") {
    const jobs = store.list().filter((job) => command === "reposts" ? job.possibleRepostOf : job.status === command)
    print(jobs, format)
    return 0
  }
  if (command === "company") {
    const query = args[1]
    const jobs = store.list().filter((job) => job.companyId === query || normalizeCompanyName(job.companyName).includes(normalizeCompanyName(query ?? "")))
    print(jobs, format)
    return 0
  }
  process.stderr.write("usage: job_history.ts stats|show <id>|company <id-or-name>|active|closed|reposts [--format json] [--history path]\n")
  return 2
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
