import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { emptyRegistry, type AtsProvider, type CompanyRecord, type CompanyRegistryData } from "../tools/company_registry"
import { fetchAtsJobs, runAtsJobIngestion } from "../tools/ats_job_ingestor"
import {
  boardRowToCompany,
  companyToAtsBoard,
  importVerifiedAtsBoards,
  loadAtsCompanyRegistry,
  planVerifiedAtsBoardImport,
  providerRegion,
  SupabaseAtsBoardRepository,
  type AtsBoardRepository,
  type AtsBoardRow,
} from "../tools/ats_board_registry"

const timestamp = "2026-09-16T11:07:20.684Z"

function company(id: string, provider: AtsProvider = "greenhouse", changes: Partial<CompanyRecord> = {}): CompanyRecord {
  const board = provider === "personio" ? `https://${id}.jobs.personio.de` : provider === "lever" ? `https://jobs.lever.co/${id}` : `https://boards.greenhouse.io/${id}`
  return {
    id: `company-${id}`,
    canonicalName: id,
    normalizedName: id.toLowerCase(),
    aliases: [],
    firstSeen: "2026-09-01T00:00:00.000Z",
    lastSeen: timestamp,
    securityHiring: { jobsSeen: 0, firstSeen: timestamp, lastSeen: timestamp, titles: {}, categories: {}, locations: {} },
    sources: {},
    ats: {
      provider,
      identifier: id,
      boardUrl: board,
      apiUrl: null,
      verified: true,
      confidence: 100,
      discoveredFrom: "api_validation",
      evidence: [{ type: "api_validation", url: `${board}/api`, detail: "verified", observedAt: timestamp }],
      firstDetected: timestamp,
      lastVerified: timestamp,
      status: "verified",
    },
    observedJobIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...changes,
  }
}

class MemoryBoardRepository implements AtsBoardRepository {
  rows: AtsBoardRow[] = []
  upsertCalls = 0
  async listAll() { return [...this.rows] }
  async listVerified() { return this.rows.filter((row) => row.status === "verified") }
  async upsert(rows: AtsBoardRow[]) {
    this.upsertCalls += 1
    for (const row of rows) {
      const key = `${row.provider}/${row.board_identifier.toLowerCase()}/${row.region}`
      const index = this.rows.findIndex((item) => `${item.provider}/${item.board_identifier.toLowerCase()}/${item.region}` === key)
      if (index < 0) this.rows.push({ ...row })
    }
  }
}

async function writeRegistry(path: string, companies: CompanyRecord[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  const data = emptyRegistry() as CompanyRegistryData
  for (const item of companies) data.companies[item.id] = item
  await writeFile(path, JSON.stringify(data), "utf8")
}

describe("durable ATS board registry", () => {
  test("verified local mappings become normalized rows with provider-region identity and evidence", () => {
    const lever = company("europe-board", "lever")
    lever.ats.boardUrl = "https://jobs.eu.lever.co/europe-board"
    lever.ats.apiUrl = "https://api.eu.lever.co/v0/postings/europe-board?mode=json"
    const row = companyToAtsBoard(lever)!
    expect(row).toMatchObject({ provider: "lever", board_identifier: "europe-board", region: "eu", status: "verified", verified_at: timestamp })
    expect(row.verification_evidence).toHaveLength(1)
    expect(providerRegion("lever", "https://jobs.eu.lever.co/x", "https://api.lever.co/x")).toBe("eu")
    expect(providerRegion("lever", "https://jobs.lever.co/x", "https://api.lever.co/x")).toBe("default")
  })

  test("the same Lever board identifier remains distinct across regions", () => {
    const defaultRegion = company("shared-board", "lever")
    const euRegion = company("shared-board-eu", "lever")
    defaultRegion.ats.boardUrl = "https://jobs.lever.co/shared-board"
    euRegion.ats.identifier = "shared-board"
    euRegion.ats.boardUrl = "https://jobs.eu.lever.co/shared-board"
    euRegion.ats.apiUrl = "https://api.eu.lever.co/v0/postings/shared-board?mode=json"
    const plan = planVerifiedAtsBoardImport([defaultRegion, euRegion])
    expect(plan.rows.map((row) => row.region).sort()).toEqual(["default", "eu"])
    expect(plan.conflicts).toEqual([])
  })

  test("old verification timestamps do not silently downgrade verified mappings", () => {
    const old = company("old-but-verified")
    old.ats.lastVerified = "2020-01-01T00:00:00.000Z"
    expect(companyToAtsBoard(old)).toMatchObject({ status: "verified", verified_at: "2020-01-01T00:00:00.000Z" })
  })

  test("verification provenance is retained without copying credential-like values", () => {
    const source = company("evidence")
    source.ats.evidence = [{
      type: "api_validation",
      url: "https://boards.example/jobs?token=private&view=all#secret",
      detail: "api_key=private-value; validation succeeded",
      observedAt: timestamp,
    }]
    const evidence = companyToAtsBoard(source)!.verification_evidence[0]
    expect(evidence.url).toBe("https://boards.example/jobs?view=all")
    expect(evidence.detail).toContain("api_key=[redacted]")
    expect(JSON.stringify(evidence)).not.toContain("private")
  })

  test("only verified mappings are planned and exact duplicates collapse", () => {
    const original = company("acme")
    const duplicate = { ...company("acme-copy"), canonicalName: "Acme" }
    duplicate.ats = { ...duplicate.ats, identifier: "acme", boardUrl: original.ats.boardUrl, apiUrl: original.ats.apiUrl }
    const candidate = company("pending")
    candidate.ats.status = "candidate"
    candidate.ats.verified = false
    const plan = planVerifiedAtsBoardImport([original, duplicate, candidate])
    expect(plan.verifiedSourceCount).toBe(2)
    expect(plan.ignoredUnverifiedCount).toBe(1)
    expect(plan.rows).toHaveLength(1)
    expect(plan.duplicateCount).toBe(1)
    expect(plan.conflicts).toHaveLength(0)

    const conflict = company("other")
    conflict.ats = { ...conflict.ats, identifier: "acme" }
    const conflictPlan = planVerifiedAtsBoardImport([original, conflict])
    expect(conflictPlan.rows).toHaveLength(0)
    expect(conflictPlan.conflicts).toHaveLength(1)
    expect(conflictPlan.conflicts[0].companies).toEqual(["acme", "other"])
  })

  test("an existing pending identity is a conflict and is never promoted", () => {
    const pending = { ...companyToAtsBoard(company("acme"))!, status: "candidate" as const }
    const plan = planVerifiedAtsBoardImport([company("acme")], [pending])
    expect(plan.rows).toHaveLength(0)
    expect(plan.conflicts).toHaveLength(1)
  })

  test("one company may contribute multiple ATS boards without company-name deduplication", () => {
    const greenhouse = company("first-board", "greenhouse")
    greenhouse.canonicalName = "Same Employer"
    const ashby = company("second-board", "ashby")
    ashby.canonicalName = "Same Employer"
    const plan = planVerifiedAtsBoardImport([greenhouse, ashby])
    expect(plan.rows).toHaveLength(2)
    expect(new Set(plan.rows.map((row) => row.provider)).size).toBe(2)
    expect(plan.conflicts).toEqual([])
  })

  test("apply is idempotent and leaves an already imported mapping unchanged", async () => {
    const repository = new MemoryBoardRepository()
    const companies = [company("acme")]
    const first = await importVerifiedAtsBoards({ companies, repository, apply: true })
    const second = await importVerifiedAtsBoards({ companies, repository, apply: true })
    expect(first).toMatchObject({ existingCount: 0, afterCount: 1, importedCount: 1, applied: true })
    expect(second).toMatchObject({ existingCount: 1, afterCount: 1, importedCount: 0, duplicateCount: 1, applied: true })
    expect(repository.upsertCalls).toBe(1)
  })

  test("durable reader only requests verified rows with server-only credentials", async () => {
    const row = companyToAtsBoard(company("acme"))!
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const repository = new SupabaseAtsBoardRepository("https://example.supabase.co", "server-secret", async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify([{ ...row, id: "uuid", created_at: timestamp, updated_at: timestamp }]), { status: 200 })
    })
    const loaded = await loadAtsCompanyRegistry({
      source: "supabase",
      repository,
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "server-secret" },
    })
    expect(loaded.source).toBe("supabase")
    expect(loaded.registry.listCompanies()).toHaveLength(1)
    expect(calls[0].url).toContain("status=eq.verified")
    expect(new Headers(calls[0].init?.headers).get("apikey")).toBe("server-secret")
    expect(JSON.stringify(loaded.registry.listCompanies()[0])).not.toContain("user_id")
  })

  test("durable registry loads on a fresh checkout without reading local registry JSON", async () => {
    const missingPath = `/tmp/ats-registry-not-present-${Date.now()}-${Math.random()}.json`
    const repository = new MemoryBoardRepository()
    repository.rows = [companyToAtsBoard(company("durable-only"))!]
    const loaded = await loadAtsCompanyRegistry({
      source: "supabase", registryPath: missingPath, repository,
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "key" },
    })
    expect(loaded.source).toBe("supabase")
    expect(loaded.registry.listCompanies().map((item) => item.id)).toEqual(["company-durable-only"])
  })

  test("Supabase service credentials cannot be sent to a non-HTTPS endpoint", () => {
    expect(() => new SupabaseAtsBoardRepository("http://example.supabase.co", "server-secret")).toThrow("must use HTTPS")
  })

  test("import conflicts are ignored at the database boundary to avoid overwriting a concurrent mapping", async () => {
    let prefer = ""
    const repository = new SupabaseAtsBoardRepository("https://example.supabase.co", "server-secret", async (_input, init) => {
      prefer = new Headers(init?.headers).get("Prefer") ?? ""
      return new Response(null, { status: 201 })
    })
    await repository.upsert([companyToAtsBoard(company("new-board"))!])
    expect(prefer).toContain("resolution=ignore-duplicates")
    expect(prefer).not.toContain("merge-duplicates")
  })

  test("strict durable mode distinguishes missing configuration from an allowed empty registry", async () => {
    await expect(loadAtsCompanyRegistry({ source: "supabase", env: {} })).rejects.toThrow("SUPABASE_URL and SUPABASE_SECRET_KEY")
    const repository = new MemoryBoardRepository()
    const loaded = await loadAtsCompanyRegistry({
      source: "supabase", repository,
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "key" },
    })
    expect(loaded.source).toBe("supabase")
    expect(loaded.registry.listCompanies()).toEqual([])
  })

  test("fresh checkout with no local registry fails a required minimum instead of treating it as an empty board snapshot", async () => {
    const missingPath = `/tmp/ats-registry-missing-${Date.now()}-${Math.random()}.json`
    await expect(runAtsJobIngestion({
      registrySource: "local",
      registryPath: missingPath,
      registryMinVerifiedBoards: 1,
      noHistory: true,
    })).rejects.toThrow("loaded 0 verified board(s) from local; expected at least 1")

    const legitimateZero = await runAtsJobIngestion({
      registrySource: "local",
      registryPath: missingPath,
      registryMinVerifiedBoards: 0,
      noHistory: true,
      dryRun: true,
    })
    expect(legitimateZero.stats).toMatchObject({ verifiedCompanies: 0, boardsCrawled: 0 })
    expect(legitimateZero.results).toEqual([])
  })

  test("auto mode has an explicit local JSON fallback when durable data is unavailable or empty", async () => {
    const path = `/tmp/ats-registry-${Date.now()}-${Math.random()}.json`
    await writeRegistry(path, [company("local")])
    const noConfig = await loadAtsCompanyRegistry({ source: "auto", registryPath: path, env: {} })
    expect(noConfig.source).toBe("local")
    expect(noConfig.warning).toContain("not configured")
    const emptyRemote = await loadAtsCompanyRegistry({
      source: "auto", registryPath: path, repository: new MemoryBoardRepository(),
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "key" },
    })
    expect(emptyRemote.source).toBe("local")
    expect(emptyRemote.warning).toContain("zero verified boards")
    expect(emptyRemote.registry.listCompanies()).toHaveLength(1)

    const unavailableRepository: AtsBoardRepository = {
      async listAll() { throw new Error("network unavailable") },
      async listVerified() { throw new Error("network unavailable") },
      async upsert() { throw new Error("network unavailable") },
    }
    const unavailable = await loadAtsCompanyRegistry({
      source: "auto", registryPath: path, repository: unavailableRepository,
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "key" },
    })
    expect(unavailable.source).toBe("local")
    expect(unavailable.warning).toContain("unavailable")
    expect(unavailable.registry.listCompanies()).toHaveLength(1)
  })

  test("durable mapping preserves its verified regional API URL for the existing adapter", async () => {
    const local = company("acme", "lever")
    local.ats.boardUrl = "https://jobs.eu.lever.co/acme"
    local.ats.apiUrl = "https://api.eu.lever.co/v0/postings/acme?mode=json"
    const row = companyToAtsBoard(local)!
    const durable = boardRowToCompany(row)
    let requested = ""
    const result = await fetchAtsJobs(durable, {
      resolveHost: async () => ["93.184.216.34"],
      fetchImpl: async (url) => {
        requested = url
        return new Response("[]", { status: 200 })
      },
    })
    expect(requested).toBe("https://api.eu.lever.co/v0/postings/acme?mode=json")
    expect(result).toMatchObject({ success: true, boardStatus: "empty", snapshotComplete: true })
  })
})
