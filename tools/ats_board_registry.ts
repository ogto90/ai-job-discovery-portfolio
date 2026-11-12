import {
  DEFAULT_REGISTRY_PATH,
  JsonCompanyRegistry,
  type AtsEvidence,
  type AtsProvider,
  type CompanyRecord,
} from "./company_registry"
import { providerApiUrl, providerBoardUrl } from "./ats_detector"

export type AtsBoardRegistrySource = "auto" | "local" | "supabase"

export interface AtsBoardRow {
  id?: string
  registry_company_id: string
  provider: AtsProvider
  board_identifier: string
  normalized_board_identifier?: string
  region: string
  company_name: string
  canonical_board_url: string
  provider_api_url: string
  status: "candidate" | "verified" | "invalid" | "retired"
  evidence_source: string | null
  verification_evidence: AtsEvidence[]
  verified_at: string | null
  first_seen_at: string
  last_seen_at: string
  created_at?: string
  updated_at?: string
}

export interface AtsCompanyRegistry {
  listCompanies(): CompanyRecord[]
  getById(id: string): CompanyRecord | undefined
}

export interface AtsBoardRepository {
  listAll(): Promise<AtsBoardRow[]>
  listVerified(): Promise<AtsBoardRow[]>
  upsert(rows: AtsBoardRow[]): Promise<void>
}

export interface AtsBoardRegistryLoad {
  registry: AtsCompanyRegistry
  source: "local" | "supabase"
  warning?: string
}

const SELECT_COLUMNS = [
  "id", "registry_company_id", "provider", "board_identifier", "normalized_board_identifier", "region",
  "company_name", "canonical_board_url", "provider_api_url", "status", "evidence_source",
  "verification_evidence", "verified_at", "first_seen_at", "last_seen_at", "created_at", "updated_at",
].join(",")

export function providerRegion(provider: AtsProvider, boardUrl: string, apiUrl: string): string {
  const urls = [boardUrl, apiUrl]
  const hosts = urls.flatMap((value) => {
    try {
      return [new URL(value).hostname.toLowerCase()]
    } catch {
      return []
    }
  })
  if (provider === "lever" && hosts.some((host) => host === "jobs.eu.lever.co" || host === "api.eu.lever.co")) return "eu"
  return "default"
}

function normalizeUrl(value: string | null | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback
  const url = new URL(candidate)
  if (url.protocol !== "https:") throw new Error(`ATS board URL must use HTTPS: ${url.hostname}`)
  return url.toString()
}

function sanitizeEvidence(evidence: AtsEvidence[] | undefined): AtsEvidence[] {
  return (evidence ?? []).map((item) => {
    let url = item.url ?? null
    if (url) {
      try {
        const parsed = new URL(url)
        parsed.username = ""
        parsed.password = ""
        parsed.hash = ""
        for (const key of [...parsed.searchParams.keys()]) {
          if (/key|token|secret|auth|password|credential/i.test(key)) parsed.searchParams.delete(key)
        }
        url = parsed.toString()
      } catch {
        url = null
      }
    }
    const detail = (item.detail ?? "")
      .replace(/((?:api[_ -]?)?key|(?:access[_ -]?)?token|secret|auth(?:orization)?|password|credential|bearer)\s*[:=]\s*[^\s,;&]+/gi, "$1=[redacted]")
      .slice(0, 1000)
    return { type: item.type, url, detail, observedAt: item.observedAt }
  })
}

export function companyToAtsBoard(company: CompanyRecord): AtsBoardRow | null {
  const ats = company.ats
  if (!ats.verified || ats.status !== "verified" || !ats.provider || !ats.identifier || !ats.lastVerified) return null
  if (!company.id.trim() || !company.canonicalName.trim() || !Number.isFinite(Date.parse(ats.lastVerified))) throw new Error("Verified ATS mapping is missing a stable company identity or verification timestamp")
  const boardUrl = normalizeUrl(ats.boardUrl, providerBoardUrl(ats.provider, ats.identifier))
  const apiUrl = normalizeUrl(ats.apiUrl, providerApiUrl(ats.provider, ats.identifier))
  return {
    registry_company_id: company.id,
    provider: ats.provider,
    board_identifier: ats.identifier.trim(),
    region: providerRegion(ats.provider, boardUrl, apiUrl),
    company_name: company.canonicalName.trim(),
    canonical_board_url: boardUrl,
    provider_api_url: apiUrl,
    status: "verified",
    evidence_source: ats.discoveredFrom,
    verification_evidence: sanitizeEvidence(ats.evidence),
    verified_at: ats.lastVerified,
    first_seen_at: company.firstSeen,
    last_seen_at: company.lastSeen,
  }
}

function identity(row: Pick<AtsBoardRow, "provider" | "board_identifier" | "region">): string {
  return `${row.provider}\u0000${row.board_identifier.trim().toLocaleLowerCase()}\u0000${row.region.trim().toLocaleLowerCase()}`
}

function sameMapping(left: AtsBoardRow, right: AtsBoardRow): boolean {
  return left.company_name.trim().toLocaleLowerCase() === right.company_name.trim().toLocaleLowerCase()
    && left.canonical_board_url === right.canonical_board_url
    && left.provider_api_url === right.provider_api_url
}

export interface AtsBoardImportPlan {
  rows: AtsBoardRow[]
  verifiedSourceCount: number
  ignoredUnverifiedCount: number
  invalidVerifiedCount: number
  duplicateCount: number
  conflicts: Array<{ identity: string; companies: string[] }>
}

export function planVerifiedAtsBoardImport(companies: CompanyRecord[], existing: AtsBoardRow[] = []): AtsBoardImportPlan {
  const verifiedSourceCount = companies.filter((company) => company.ats.verified && company.ats.status === "verified").length
  const groups = new Map<string, AtsBoardRow[]>()
  let invalidVerifiedCount = 0
  for (const company of companies) {
    let row: AtsBoardRow | null
    try {
      row = companyToAtsBoard(company)
    } catch {
      row = null
    }
    if (!row && company.ats.verified && company.ats.status === "verified") invalidVerifiedCount += 1
    if (!row) continue
    const key = identity(row)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  const existingByIdentity = new Map(existing.map((row) => [identity(row), row]))
  const rows: AtsBoardRow[] = []
  const conflicts: AtsBoardImportPlan["conflicts"] = []
  let duplicateCount = 0
  for (const [key, candidates] of groups) {
    const existingRow = existingByIdentity.get(key)
    const all = existingRow ? [...candidates, existingRow] : candidates
    const winner = [...candidates].sort((a, b) => Date.parse(b.verified_at ?? "") - Date.parse(a.verified_at ?? ""))[0]
    if (all.length > 1 && all.some((row) => !sameMapping(winner, row))) {
      conflicts.push({ identity: key.replaceAll("\u0000", "/"), companies: [...new Set(all.map((row) => row.company_name))].sort() })
      continue
    }
    if (existingRow?.status !== undefined && existingRow.status !== "verified") {
      conflicts.push({ identity: key.replaceAll("\u0000", "/"), companies: [winner.company_name, `existing status: ${existingRow.status}`] })
      continue
    }
    duplicateCount += candidates.length - 1 + (existingRow ? 1 : 0)
    if (!existingRow) rows.push(winner)
  }
  return {
    rows,
    verifiedSourceCount,
    ignoredUnverifiedCount: companies.filter((company) => !(company.ats.verified && company.ats.status === "verified")).length,
    invalidVerifiedCount,
    duplicateCount,
    conflicts,
  }
}

export function boardRowToCompany(row: AtsBoardRow): CompanyRecord {
  if (row.status !== "verified" || !row.registry_company_id || !row.company_name || !row.board_identifier || !row.provider_api_url) {
    throw new Error("ATS board registry returned an incomplete or unverified row")
  }
  return {
    id: row.registry_company_id,
    canonicalName: row.company_name,
    normalizedName: row.company_name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(),
    aliases: [],
    firstSeen: row.first_seen_at,
    lastSeen: row.last_seen_at,
    securityHiring: { jobsSeen: 0, firstSeen: row.first_seen_at, lastSeen: row.last_seen_at, titles: {}, categories: {}, locations: {} },
    sources: {},
    ats: {
      provider: row.provider,
      identifier: row.board_identifier,
      boardUrl: row.canonical_board_url,
      apiUrl: row.provider_api_url,
      verified: true,
      confidence: 1,
      discoveredFrom: row.evidence_source,
      evidence: row.verification_evidence,
      firstDetected: row.first_seen_at,
      lastVerified: row.verified_at,
      lastAttempted: null,
      failureReason: null,
      status: "verified",
    },
    observedJobIds: [],
    createdAt: row.created_at ?? row.first_seen_at,
    updatedAt: row.updated_at ?? row.last_seen_at,
  }
}

export class StaticAtsCompanyRegistry implements AtsCompanyRegistry {
  private readonly companies: CompanyRecord[]
  private readonly byId: Map<string, CompanyRecord>

  constructor(companies: CompanyRecord[]) {
    this.companies = companies
    this.byId = new Map(companies.map((company) => [company.id, company]))
  }

  listCompanies(): CompanyRecord[] { return [...this.companies] }
  getById(id: string): CompanyRecord | undefined { return this.byId.get(id) }
}

export class SupabaseAtsBoardRepository implements AtsBoardRepository {
  private readonly baseUrl: string
  private readonly secretKey: string
  private readonly fetchImpl: typeof fetch

  constructor(baseUrl: string, secretKey: string, fetchImpl: typeof fetch = fetch) {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== "https:") throw new Error("Supabase ATS registry URL must use HTTPS")
    if (parsed.username || parsed.password) throw new Error("Supabase ATS registry URL must not embed credentials")
    this.baseUrl = parsed.toString().replace(/\/+$/, "")
    this.secretKey = secretKey
    this.fetchImpl = fetchImpl
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.secretKey,
        Authorization: `Bearer ${this.secretKey}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(15000),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`ATS board registry request failed (HTTP ${response.status})${body ? `: ${body.slice(0, 400)}` : ""}`)
    return body ? JSON.parse(body) as unknown : null
  }

  private async list(query: string): Promise<AtsBoardRow[]> {
    const all: AtsBoardRow[] = []
    const pageSize = 1000
    for (let offset = 0; ; offset += pageSize) {
      const rows = await this.request(`${query}&limit=${pageSize}&offset=${offset}`)
      if (!Array.isArray(rows)) throw new Error("ATS board registry returned an invalid row set")
      all.push(...rows as AtsBoardRow[])
      if (rows.length < pageSize) return all
    }
  }

  async listAll(): Promise<AtsBoardRow[]> {
    return this.list(`ats_board_registry?select=${SELECT_COLUMNS}&order=provider.asc,normalized_board_identifier.asc`)
  }

  async listVerified(): Promise<AtsBoardRow[]> {
    return (await this.list(`ats_board_registry?select=${SELECT_COLUMNS}&status=eq.verified&order=provider.asc,normalized_board_identifier.asc`)).map((row) => {
      if (row.status !== "verified") throw new Error("ATS board registry returned a nonverified row in its verified query")
      return row
    })
  }

  async upsert(rows: AtsBoardRow[]): Promise<void> {
    if (!rows.length) return
    await this.request("ats_board_registry?on_conflict=provider,normalized_board_identifier,region", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(rows.map(({ id: _id, normalized_board_identifier: _normalized, created_at: _created, ...row }) => row)),
    })
  }
}

export async function loadAtsCompanyRegistry(options: {
  source?: AtsBoardRegistrySource
  registryPath?: string
  env?: NodeJS.ProcessEnv
  repository?: AtsBoardRepository
  fetchImpl?: typeof fetch
} = {}): Promise<AtsBoardRegistryLoad> {
  const env = options.env ?? process.env
  const source = options.source ?? (env.AI_JOB_SEARCH_ATS_REGISTRY_SOURCE as AtsBoardRegistrySource | undefined) ?? "auto"
  const local = async (): Promise<AtsBoardRegistryLoad> => ({
    registry: await JsonCompanyRegistry.load(options.registryPath ?? DEFAULT_REGISTRY_PATH),
    source: "local",
  })
  if (source === "local") return local()
  if (source !== "auto" && source !== "supabase") throw new Error(`Unknown ATS registry source: ${source}`)

  const url = env.SUPABASE_URL?.trim()
  const secret = env.SUPABASE_SECRET_KEY?.trim()
  if (!url || !secret) {
    if (source === "supabase") throw new Error("ATS board registry requires SUPABASE_URL and SUPABASE_SECRET_KEY")
    const loaded = await local()
    return { ...loaded, warning: "Supabase ATS board registry is not configured; using the local JSON registry." }
  }

  try {
    const repository = options.repository ?? new SupabaseAtsBoardRepository(url, secret, options.fetchImpl)
    const rows = await repository.listVerified()
    if (source === "auto" && rows.length === 0) {
      const localRegistry = await JsonCompanyRegistry.load(options.registryPath ?? DEFAULT_REGISTRY_PATH)
      const localCompanies = localRegistry.listCompanies().filter((company) => company.ats.verified && company.ats.status === "verified")
      if (localCompanies.length) {
        return {
          registry: localRegistry,
          source: "local",
          warning: "Supabase ATS board registry returned zero verified boards; using the local JSON fallback.",
        }
      }
    }
    return { registry: new StaticAtsCompanyRegistry(rows.map(boardRowToCompany)), source: "supabase" }
  } catch (error) {
    if (source === "supabase") throw error
    const loaded = await local()
    return { ...loaded, warning: "Supabase ATS board registry unavailable; using the local JSON fallback." }
  }
}

export async function importVerifiedAtsBoards(options: {
  companies: CompanyRecord[]
  repository: AtsBoardRepository
  apply?: boolean
}): Promise<AtsBoardImportPlan & { existingCount: number; afterCount: number; importedCount: number; applied: boolean }> {
  const existing = await options.repository.listAll()
  const plan = planVerifiedAtsBoardImport(options.companies, existing)
  let importedCount = 0
  if (options.apply && plan.rows.length && plan.conflicts.length === 0) {
    await options.repository.upsert(plan.rows)
    importedCount = plan.rows.length
  }
  const after = options.apply ? await options.repository.listAll() : existing
  return {
    ...plan,
    existingCount: existing.length,
    afterCount: after.length,
    importedCount,
    applied: Boolean(options.apply),
  }
}
