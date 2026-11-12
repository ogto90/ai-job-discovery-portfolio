import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import {
  JsonCompanyRegistry,
  emptyRegistry,
  type AtsProvider,
  type CompanyRecord,
  type NormalizedJob,
} from "../tools/company_registry"
import { dedupePreferDirectAts, fetchAtsJobs, rotateAtsBoardCohort, runAtsJobIngestion } from "../tools/ats_job_ingestor"
import { providerApiUrl } from "../tools/ats_detector"
import {
  JsonJobHistoryStore,
  descriptionHash,
  jaccardSimilarity,
  normalizeJobDescription,
  stableHistoricalJobId,
} from "../tools/job_history"

const now = new Date("2026-09-04T12:00:00.000Z")
const nowIso = now.toISOString()
const resolveHost = async () => ["93.184.216.34"]

function tmpPath(name: string): string {
  return `/tmp/ats-job-ingestor-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}.json`
}

function response(status: number, body: string): Response {
  return new Response(body, { status })
}

function fetchMap(routes: Record<string, Response | Response[]>): (url: string, init: RequestInit) => Promise<Response> {
  return async (url) => {
    const value = routes[url]
    if (!value) return response(404, "{}")
    if (Array.isArray(value)) return value.shift() ?? response(404, "{}")
    return value
  }
}

function company(provider: AtsProvider, identifier = "acme"): CompanyRecord {
  return {
    id: `company_${provider}`,
    canonicalName: "Acme Security",
    normalizedName: "acme security",
    aliases: ["Acme Security"],
    domain: "acme.example",
    websiteUrl: null,
    careersUrl: null,
    firstSeen: nowIso,
    lastSeen: nowIso,
    securityHiring: { jobsSeen: 0, firstSeen: nowIso, lastSeen: nowIso, titles: {}, categories: {}, locations: {} },
    sources: {},
    ats: {
      provider,
      identifier,
      boardUrl: provider === "personio" ? `https://${identifier}.jobs.personio.de` : `https://example.com/${identifier}`,
      apiUrl: null,
      verified: true,
      confidence: 100,
      discoveredFrom: "job_url",
      evidence: [],
      firstDetected: nowIso,
      lastVerified: nowIso,
      lastAttempted: nowIso,
      failureReason: null,
      status: "verified",
    },
    observedJobIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  }
}

async function registryWith(companies: CompanyRecord[], path: string): Promise<void> {
  await mkdir("/tmp", { recursive: true })
  const data = emptyRegistry()
  for (const item of companies) data.companies[item.id] = item
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

describe("provider normalization", () => {
  test("all supported adapters distinguish successful, empty, failed, and rate-limited board responses", async () => {
    const cases: Array<{ provider: AtsProvider; successBody: string; emptyBody: string }> = [
      { provider: "greenhouse", successBody: JSON.stringify({ jobs: [{ id: 1, title: "Security Engineer" }] }), emptyBody: JSON.stringify({ jobs: [] }) },
      { provider: "lever", successBody: JSON.stringify([{ id: "1", text: "Security Engineer" }]), emptyBody: "[]" },
      { provider: "ashby", successBody: JSON.stringify({ jobs: [{ id: "1", title: "Security Engineer" }] }), emptyBody: JSON.stringify({ jobs: [] }) },
      { provider: "smartrecruiters", successBody: JSON.stringify({ totalFound: 1, content: [{ id: "1", name: "Security Engineer" }] }), emptyBody: JSON.stringify({ totalFound: 0, content: [] }) },
      { provider: "personio", successBody: "<workzag-jobs><position><id>1</id><name>Security Engineer</name></position></workzag-jobs>", emptyBody: "<workzag-jobs></workzag-jobs>" },
    ]
    for (const item of cases) {
      const board = company(item.provider, `board-${item.provider}`)
      const fetchBody = (body: string, status = 200) => async () => response(status, body)
      const success = await fetchAtsJobs(board, { now, resolveHost, fetchImpl: fetchBody(item.successBody) })
      const empty = await fetchAtsJobs(board, { now, resolveHost, fetchImpl: fetchBody(item.emptyBody) })
      const failed = await fetchAtsJobs(board, { now, resolveHost, fetchImpl: fetchBody("{}", 503) })
      const limited = await fetchAtsJobs(board, { now, resolveHost, fetchImpl: fetchBody("{}", 429) })
      expect(success).toMatchObject({ success: true, boardStatus: "success", snapshotComplete: true })
      expect(empty).toMatchObject({ success: true, boardStatus: "empty", snapshotComplete: true, allJobs: [] })
      expect(failed).toMatchObject({ success: false, boardStatus: "failed", snapshotComplete: false })
      expect(limited).toMatchObject({ success: false, boardStatus: "rate_limited", snapshotComplete: false })
      expect(providerApiUrl(item.provider, `board-${item.provider}`)).toBeString()
    }
  })

  test("Greenhouse response normalizes to the job contract", async () => {
    const result = await fetchAtsJobs(company("greenhouse", "acme"), {
      now,
      resolveHost,
      fetchImpl: fetchMap({
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": response(200, JSON.stringify({
          jobs: [{ id: 123, title: "Senior Application Security Engineer", absolute_url: "https://boards.greenhouse.io/acme/jobs/123", location: { name: "Remote" }, departments: [{ name: "Security" }], content: "<p>AppSec work</p>", updated_at: "2026-09-01" }],
        })),
      }),
    })
    expect(result.success).toBe(true)
    expect(result.jobs[0]).toMatchObject({ id: "123", title: "Senior Application Security Engineer", sourceType: "ats", companyId: "company_greenhouse" })
    expect(result.jobs[0].validation).toMatchObject({ status: "active", method: "ats_api", confidence: 100 })
  })

  test("Lever, Ashby, SmartRecruiters, and Personio normalize published jobs", async () => {
    const lever = await fetchAtsJobs(company("lever", "acme"), {
      now,
      resolveHost,
      fetchImpl: fetchMap({ "https://api.lever.co/v0/postings/acme?mode=json": response(200, JSON.stringify([{ id: "lev1", text: "Product Security Engineer", hostedUrl: "https://jobs.lever.co/acme/lev1", applyUrl: "https://jobs.lever.co/acme/lev1/apply", categories: { team: "Security", location: "Remote", commitment: "Full-time" }, descriptionPlain: "Product security role" }])) }),
    })
    const ashby = await fetchAtsJobs(company("ashby", "acme"), {
      now,
      resolveHost,
      fetchImpl: fetchMap({ "https://api.ashbyhq.com/posting-api/job-board/acme": response(200, JSON.stringify({ jobs: [{ id: "ash1", title: "Security Architect", jobUrl: "https://jobs.ashbyhq.com/acme/ash1", location: "Remote", descriptionHtml: "<p>Security architecture</p>" }] })) }),
    })
    const smart = await fetchAtsJobs(company("smartrecruiters", "Acme"), {
      now,
      resolveHost,
      fetchImpl: fetchMap({ "https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100&offset=0": response(200, JSON.stringify({ totalFound: 1, limit: 100, content: [{ id: "sr1", name: "GRC Specialist", ref: { careerSiteUrl: "https://careers.smartrecruiters.com/Acme/sr1" }, location: { city: "Remote" } }] })) }),
    })
    const personio = await fetchAtsJobs(company("personio", "acme"), {
      now,
      resolveHost,
      fetchImpl: fetchMap({ "https://acme.jobs.personio.de/xml?language=en": response(200, "<workzag-jobs><position><id>p1</id><name>Information Security Manager</name><office>Remote</office></position></workzag-jobs>") }),
    })
    expect(lever.jobs[0].ats).toMatchObject({ provider: "lever", requisitionId: "lev1" })
    expect(ashby.jobs[0].ats).toMatchObject({ provider: "ashby", requisitionId: "ash1" })
    expect(smart.jobs[0].ats).toMatchObject({ provider: "smartrecruiters", requisitionId: "sr1" })
    expect(personio.jobs[0].ats).toMatchObject({ provider: "personio", requisitionId: "p1" })
  })

  test("Lever retains documented structured posting sections without a detail request", async () => {
    const result = await fetchAtsJobs(company("lever", "acme"), {
      now, resolveHost,
      fetchImpl: fetchMap({ "https://api.lever.co/v0/postings/acme?mode=json": response(200, JSON.stringify([
        {
          id: "structured-1", text: "Security Engineer", hostedUrl: "https://jobs.lever.co/acme/structured-1",
          categories: { location: "Vienna", commitment: "Full-time" }, workplaceType: "hybrid",
          descriptionPlain: "Join our security team.",
          lists: [{ text: "Responsibilities", content: "<li>Design and implement security controls for production services.</li><li>Review application vulnerabilities and collaborate with engineering teams.</li>" }],
          additionalPlain: "We value clear communication and careful documentation.",
        },
        {
          id: "fallback-2", text: "Product Security Engineer",
          openingPlain: "Build safer products.", descriptionBodyPlain: "Own application security reviews.",
          lists: [{ text: "Qualifications", content: "<li>Experience with secure software development.</li>" }],
        },
      ])) }),
    })
    expect(result.jobs).toHaveLength(2)
    expect(result.jobs[0].description).toContain("Design and implement security controls")
    expect(result.jobs[0].description).toContain("We value clear communication")
    expect(result.jobs[0].ats).toMatchObject({ provider: "lever", companyIdentifier: "acme", requisitionId: "structured-1" })
    expect(result.jobs[0]).toMatchObject({ location: "Vienna", workplaceType: "hybrid", employmentType: "Full-time" })
    expect(result.jobs[1].description).toContain("Build safer products")
    expect(result.jobs[1].description).toContain("Own application security reviews")
    expect(result.jobs[1].description).toContain("Qualifications")
  })

  test("SmartRecruiters pagination failure makes snapshot incomplete", async () => {
    const result = await fetchAtsJobs(company("smartrecruiters", "Acme"), {
      now,
      resolveHost,
      fetchImpl: fetchMap({
        "https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100&offset=0": response(200, JSON.stringify({ totalFound: 101, limit: 100, content: [{ id: "sr1", name: "Security Engineer" }] })),
        "https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100&offset=1": response(500, "{}"),
      }),
    })
    expect(result.success).toBe(false)
    expect(result.snapshotComplete).toBe(false)
  })

  test("SmartRecruiters page budget is reported partial and never treated as closure evidence", async () => {
    const result = await fetchAtsJobs(company("smartrecruiters", "Acme"), {
      now,
      resolveHost,
      fetchImpl: async (url) => {
        const parsed = new URL(url)
        const offset = Number(parsed.searchParams.get("offset") ?? 0)
        return response(200, JSON.stringify({
          totalFound: 2500,
          limit: 100,
          content: Array.from({ length: 100 }, (_, index) => ({ id: String(offset + index), name: "Security Engineer" })),
        }))
      },
    })
    expect(result).toMatchObject({ success: true, boardStatus: "partial", snapshotComplete: false })
    expect(result.jobs).toHaveLength(2000)
  })
})

describe("profession-neutral ingestion and stable identity", () => {
  test("all published roles are normalized without occupation filtering", async () => {
    const result = await fetchAtsJobs(company("greenhouse", "acme"), {
      now,
      resolveHost,
      fetchImpl: fetchMap({
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": response(200, JSON.stringify({
          jobs: [
            { id: 1, title: "Application Security Engineer", absolute_url: "https://example.com/1", content: "AppSec" },
            { id: 2, title: "Software Engineer", absolute_url: "https://example.com/2", content: "cares about security" },
          ],
        })),
      }),
    })
    expect(result.allJobs).toHaveLength(2)
    expect(result.jobs.map((job) => job.title)).toEqual(["Application Security Engineer", "Software Engineer"])
  })

  test("stable IDs use company plus provider plus requisition", () => {
    const base: NormalizedJob = { id: "same", title: "Security Engineer", companyId: "company_a", sourceType: "ats", ats: { provider: "ashby", companyIdentifier: "a", requisitionId: "same" } }
    const otherCompany: NormalizedJob = { ...base, companyId: "company_b" }
    expect(stableHistoricalJobId(base)).toBe(stableHistoricalJobId({ ...base, title: "Renamed Security Engineer" }))
    expect(stableHistoricalJobId(base)).not.toBe(stableHistoricalJobId(otherCompany))
  })

  test("direct ATS rows take precedence over equivalent aggregator rows", () => {
    const direct: NormalizedJob = { id: "123", title: "Security Engineer", company: "Acme", companyId: "company_a", sourceType: "ats", source: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/123", ats: { provider: "greenhouse", companyIdentifier: "acme", requisitionId: "123" } }
    const aggregator: NormalizedJob = { id: "agg", title: "Security Engineer", company: "Acme", source: "himalayas", url: "https://himalayas.app/jobs/1", applicationUrl: "https://boards.greenhouse.io/acme/jobs/123" }
    const deduped = dedupePreferDirectAts([aggregator, direct])
    expect(deduped).toHaveLength(1)
    expect(deduped[0].sourceType).toBe("ats")
    expect(deduped[0].metadata).toMatchObject({ seenVia: expect.arrayContaining(["himalayas", "greenhouse"]) })
  })

  test("same company and title alone do not merge", () => {
    const a: NormalizedJob = { id: "1", title: "Security Engineer", company: "Acme", source: "one", url: "https://example.com/1" }
    const b: NormalizedJob = { id: "2", title: "Security Engineer", company: "Acme", source: "two", url: "https://example.com/2" }
    expect(dedupePreferDirectAts([a, b])).toHaveLength(2)
  })
})

describe("history snapshots", () => {
  test("first and second observation preserve firstSeen and increment timesObserved", async () => {
    const path = tmpPath("history")
    const store = await JsonJobHistoryStore.load(path)
    const job: NormalizedJob = { id: "1", title: "Security Engineer", company: "Acme", companyId: "company_a", location: "Remote", sourceType: "ats", source: "ashby", ats: { provider: "ashby", companyIdentifier: "acme", requisitionId: "1" }, description: "<p>secure systems</p>" }
    store.upsertSnapshot({ companyId: "company_a", companyName: "Acme", source: "ashby", provider: "ashby", identifier: "acme", jobs: [job], fetchedAt: "2026-09-04T12:00:00.000Z", snapshotComplete: true })
    store.upsertSnapshot({ companyId: "company_a", companyName: "Acme", source: "ashby", provider: "ashby", identifier: "acme", jobs: [job], fetchedAt: "2026-09-05T12:00:00.000Z", snapshotComplete: true })
    const historical = store.list()[0]
    expect(historical.firstSeen).toBe("2026-09-04T12:00:00.000Z")
    expect(historical.lastSeen).toBe("2026-09-05T12:00:00.000Z")
    expect(historical.timesObserved).toBe(2)
    expect(store.stats()).toMatchObject({ historicalJobs: 1, active: 1 })
  })

  test("absent job closes only after complete successful snapshot and can reappear", async () => {
    const store = await JsonJobHistoryStore.load(tmpPath("closure"))
    const job: NormalizedJob = { id: "1", title: "Security Engineer", company: "Acme", companyId: "company_a", sourceType: "ats", source: "ashby", ats: { provider: "ashby", companyIdentifier: "acme", requisitionId: "1" } }
    store.upsertSnapshot({ companyId: "company_a", companyName: "Acme", source: "ashby", provider: "ashby", identifier: "acme", jobs: [job], fetchedAt: "2026-09-04T12:00:00.000Z", snapshotComplete: true })
    store.upsertSnapshot({ companyId: "company_a", companyName: "Acme", source: "ashby", provider: "ashby", identifier: "acme", jobs: [], fetchedAt: "2026-09-05T12:00:00.000Z", snapshotComplete: false })
    expect(store.list()[0].status).toBe("active")
    store.upsertSnapshot({ companyId: "company_a", companyName: "Acme", source: "ashby", provider: "ashby", identifier: "acme", jobs: [], fetchedAt: "2026-09-06T12:00:00.000Z", snapshotComplete: true })
    expect(store.list()[0].status).toBe("closed")
    store.upsertSnapshot({ companyId: "company_a", companyName: "Acme", source: "ashby", provider: "ashby", identifier: "acme", jobs: [job], fetchedAt: "2026-09-07T12:00:00.000Z", snapshotComplete: true })
    expect(store.list()[0]).toMatchObject({ status: "active", reappearedAt: "2026-09-07T12:00:00.000Z", reappearanceCount: 1 })
  })

  test("new similar requisition links as possible repost conservatively", async () => {
    const store = await JsonJobHistoryStore.load(tmpPath("repost"))
    const oldJob: NormalizedJob = { id: "old", title: "Product Security Engineer", company: "Acme", companyId: "company_a", location: "Remote", sourceType: "ats", source: "ashby", ats: { provider: "ashby", companyIdentifier: "acme", requisitionId: "old" }, description: "<p>Build product security reviews and threat models.</p>" }
    const newJob: NormalizedJob = { ...oldJob, id: "new", ats: { provider: "ashby", companyIdentifier: "acme", requisitionId: "new" } }
    store.upsertSnapshot({ companyId: "company_a", companyName: "Acme", source: "ashby", provider: "ashby", identifier: "acme", jobs: [oldJob], fetchedAt: "2026-09-01T12:00:00.000Z", snapshotComplete: true })
    store.upsertSnapshot({ companyId: "company_a", companyName: "Acme", source: "ashby", provider: "ashby", identifier: "acme", jobs: [], fetchedAt: "2026-09-02T12:00:00.000Z", snapshotComplete: true })
    const stats = store.upsertSnapshot({ companyId: "company_a", companyName: "Acme", source: "ashby", provider: "ashby", identifier: "acme", jobs: [newJob], fetchedAt: "2026-09-04T12:00:00.000Z", snapshotComplete: true })
    expect(stats.repostCandidates).toBe(1)
    expect(store.list().find((job) => job.ats?.requisitionId === "new")?.possibleRepostOf).toBeTruthy()
  })

  test("description normalization and similarity are deterministic", () => {
    expect(normalizeJobDescription("<p>Hello&nbsp; SECURITY</p>")).toBe("hello security")
    expect(normalizeJobDescription("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;")
    expect(descriptionHash("<p>Hello&nbsp; security</p>")).toBe(descriptionHash("hello security"))
    expect(descriptionHash("materially different")).not.toBe(descriptionHash("hello security"))
    expect(jaccardSimilarity("security engineering appsec", "security engineering appsec program")).toBeGreaterThan(0.7)
  })

  test("history persists and corrupt state fails safely", async () => {
    const path = tmpPath("persist")
    const store = await JsonJobHistoryStore.load(path)
    const job: NormalizedJob = { id: "1", title: "Security Engineer", company: "Acme", companyId: "company_a", sourceType: "ats", source: "ashby", ats: { provider: "ashby", companyIdentifier: "acme", requisitionId: "1" } }
    store.upsertSnapshot({ companyId: "company_a", companyName: "Acme", source: "ashby", provider: "ashby", identifier: "acme", jobs: [job], fetchedAt: nowIso, snapshotComplete: true })
    await store.save()
    expect((await JsonJobHistoryStore.load(path)).list()).toHaveLength(1)
    const corrupt = tmpPath("corrupt")
    await writeFile(corrupt, "{bad", "utf8")
    await expect(JsonJobHistoryStore.load(corrupt)).rejects.toThrow("Unable to read job history")
  })
})

describe("batch ingestion behavior", () => {
  test("rotation is stable for retries and covers the real 22-board provider mix in three scheduled slots", async () => {
    const providerCounts: Array<[AtsProvider, number]> = [
      ["greenhouse", 9], ["ashby", 8], ["lever", 2], ["smartrecruiters", 2], ["personio", 1],
    ]
    const companies = providerCounts.flatMap(([provider, count]) =>
      Array.from({ length: count }, (_, index) => {
        const identifier = `${provider}-${index + 1}`
        return { ...company(provider, identifier), id: `company-${identifier}`, canonicalName: identifier }
      }))
    const registryPath = tmpPath("rotation-registry")
    await registryWith(companies, registryPath)
    const emptyBodies: Record<AtsProvider, string> = {
      greenhouse: JSON.stringify({ jobs: [] }),
      ashby: JSON.stringify({ jobs: [] }),
      lever: "[]",
      smartrecruiters: JSON.stringify({ totalFound: 0, content: [] }),
      personio: "<workzag-jobs></workzag-jobs>",
    }
    const fetchImpl = async (url: string) => {
      const hostname = new URL(url).hostname
      const body = hostname.includes("smartrecruiters") ? emptyBodies.smartrecruiters
        : hostname.includes("personio") ? emptyBodies.personio
          : hostname.includes("lever") ? emptyBodies.lever
            : hostname.includes("ashby") ? emptyBodies.ashby
              : emptyBodies.greenhouse
      return new Response(body, { status: 200 })
    }
    const runSlot = async (slot: number) => runAtsJobIngestion({
      registrySource: "local", registryPath, rotationSlot: slot, boardBudget: 8,
      dryRun: true, noHistory: true, now, resolveHost, fetchImpl,
    })
    const retry = await runSlot(41)
    const first = await runSlot(41)
    const second = await runSlot(42)
    const third = await runSlot(43)
    const firstIds = first.stats.selectedBoardIds ?? []
    const secondIds = second.stats.selectedBoardIds ?? []
    const thirdIds = third.stats.selectedBoardIds ?? []
    expect(retry.stats.selectedBoardIds).toEqual(firstIds)
    expect(firstIds).toHaveLength(8)
    expect(secondIds).toHaveLength(8)
    expect(thirdIds).toHaveLength(8)
    expect(secondIds).not.toEqual(firstIds)
    expect(new Set(firstIds).size).toBe(8)
    expect(new Set([...firstIds, ...secondIds]).size).toBe(16)
    expect(new Set([...firstIds, ...secondIds, ...thirdIds]).size).toBe(22)
    expect([first, second, third].map((result) => result.stats.boardsDeferredBudget)).toEqual([14, 14, 14])
    for (const result of [first, second, third]) {
      expect(Object.values(result.stats.providerDistribution).reduce((sum, count) => sum + count, 0)).toBe(8)
    }

    const reordered = [...companies].reverse()
    expect(rotateAtsBoardCohort(companies, 8, 42, (item) => `${item.ats.provider}/${item.ats.identifier}`)
      .map((item) => item.id)).toEqual(rotateAtsBoardCohort(reordered, 8, 42, (item) => `${item.ats.provider}/${item.ats.identifier}`)
      .map((item) => item.id))
  })

  test("rotation handles zero, small, and oversized budgets", () => {
    const rows = ["a", "b", "c", "d"]
    expect(rotateAtsBoardCohort(rows, 0, 0, (item) => item)).toEqual([])
    expect(rotateAtsBoardCohort(rows, 2, 1, (item) => item)).toEqual(["c", "d"])
    expect(rotateAtsBoardCohort(rows, 8, 3, (item) => item)).toEqual(["a", "b", "c", "d"])
    expect(rotateAtsBoardCohort([], 8, 3, (item) => item)).toEqual([])
  })

  test("provider and region both participate in stable board identity", () => {
    const boards = [
      { provider: "lever", region: "eu", identifier: "shared-board" },
      { provider: "lever", region: "default", identifier: "shared-board" },
      { provider: "ashby", region: "default", identifier: "shared-board" },
    ]
    const key = (board: typeof boards[number]) => `${board.provider}/${board.region}/${board.identifier}`
    expect(rotateAtsBoardCohort(boards, 3, 1, key).map(key)).toEqual([
      "ashby/default/shared-board",
      "lever/default/shared-board",
      "lever/eu/shared-board",
    ])
  })

  test("the same rotation slot selects the same real boards in fresh processes", async () => {
    const script = `
      import { rotateAtsBoardCohort } from "./tools/ats_job_ingestor"
      const counts = [["greenhouse", 9], ["ashby", 8], ["lever", 2], ["smartrecruiters", 2], ["personio", 1]]
      const boards = counts.flatMap(([provider, count]) => Array.from({ length: count }, (_, i) => ({
        provider, region: "default", identifier: provider + "-" + (i + 1),
      })))
      const key = (board) => board.provider + "/" + board.region + "/" + board.identifier
      const selected = rotateAtsBoardCohort(boards, 8, 73, key)
      console.log(JSON.stringify(selected.map(key)))
    `
    const runInFreshProcess = () => {
      const result = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode).toBe(0)
      return result.stdout.toString().trim()
    }
    expect(runInFreshProcess()).toBe(runInFreshProcess())
  })

  test("a budget-skipped board is never treated as evidence that its jobs closed", async () => {
    const registryPath = tmpPath("skipped-board-registry")
    const historyPath = tmpPath("skipped-board-history")
    const boards = ["a", "b"].map((identifier) => ({
      ...company("greenhouse", identifier),
      id: `company-${identifier}`,
      canonicalName: `Company ${identifier}`,
    }))
    await registryWith(boards, registryPath)
    const history = await JsonJobHistoryStore.load(historyPath)
    for (const board of boards) {
      const job: NormalizedJob = {
        id: `old-${board.ats.identifier}`,
        title: "Security Engineer",
        company: board.canonicalName,
        companyId: board.id,
        sourceType: "ats",
        source: "greenhouse",
        ats: { provider: "greenhouse", companyIdentifier: board.ats.identifier!, requisitionId: `old-${board.ats.identifier}` },
      }
      history.upsertSnapshot({
        companyId: board.id,
        companyName: board.canonicalName,
        source: "greenhouse",
        provider: "greenhouse",
        identifier: board.ats.identifier!,
        jobs: [job],
        fetchedAt: "2026-09-01T00:00:00.000Z",
        snapshotComplete: true,
      })
    }
    await history.save()

    const result = await runAtsJobIngestion({
      registryPath,
      historyPath,
      rotationSlot: 0,
      boardBudget: 1,
      now,
      resolveHost,
      fetchImpl: fetchMap({
        "https://boards-api.greenhouse.io/v1/boards/a/jobs?content=true": response(200, JSON.stringify({ jobs: [] })),
      }),
    })
    const jobs = result.history!.list()
    expect(result.stats).toMatchObject({ boardsCrawled: 1, boardsDeferredBudget: 1, emptyBoards: 1 })
    expect(result.stats.selectedBoardIds).toEqual(["greenhouse/default/a"])
    expect(jobs.find((job) => job.ats?.requisitionId === "old-a")?.status).toBe("closed")
    expect(jobs.find((job) => job.ats?.requisitionId === "old-b")?.status).toBe("active")
  })

  test("deferred successful fetch stays retryable until persistence commits freshness", async () => {
    const registryPath = tmpPath("deferred-registry")
    const historyPath = tmpPath("deferred-history")
    await registryWith([company("greenhouse", "deferred")], registryPath)
    const result = await runAtsJobIngestion({
      registryPath, historyPath, deferSuccessfulFreshness: true, now, resolveHost,
      fetchImpl: fetchMap({ "https://boards-api.greenhouse.io/v1/boards/deferred/jobs?content=true": response(200, JSON.stringify({ jobs: [] })) }),
    })
    expect(result.history?.getFetchState("company_greenhouse", "greenhouse", "deferred")).toMatchObject({
      lastSuccessfulAt: null, snapshotComplete: true, persistencePending: true,
    })
    await result.history!.commitSuccessfulFetches(result.results)
    expect((await JsonJobHistoryStore.load(historyPath)).getFetchState("company_greenhouse", "greenhouse", "deferred")).toMatchObject({
      lastSuccessfulAt: nowIso, snapshotComplete: true, persistencePending: false,
    })
    const second = await runAtsJobIngestion({
      registryPath, historyPath, boardBudget: 1, now: new Date(now.getTime() + 1000), resolveHost,
      fetchImpl: fetchMap({}),
    })
    expect(second.stats.boardsSkippedFresh).toBe(1)
    expect(second.stats.boardsCrawled).toBe(0)
  })

  test("eight-board batches rotate deterministically across verified boards", async () => {
    const registryPath = tmpPath("rotation-registry")
    const historyPath = tmpPath("rotation-history")
    const boards = Array.from({ length: 10 }, (_, index) => {
      const identifier = `board-${String(index).padStart(2, "0")}`
      return { ...company("greenhouse", identifier), id: `company-${String(index).padStart(2, "0")}`, canonicalName: `Company ${index}` }
    })
    await registryWith(boards, registryPath)
    const emptyFetch = (items: typeof boards) => fetchMap(Object.fromEntries(items.map((item) => [
      `https://boards-api.greenhouse.io/v1/boards/${item.ats.identifier}/jobs?content=true`,
      response(200, JSON.stringify({ jobs: [] })),
    ])))
    const first = await runAtsJobIngestion({ registryPath, historyPath, boardBudget: 8, now, resolveHost, fetchImpl: emptyFetch(boards) })
    expect(first.stats.boardsCrawled).toBe(8)
    expect(first.results.map((item) => item.identifier)).toEqual(boards.slice(0, 8).map((item) => item.ats.identifier))
    const second = await runAtsJobIngestion({ registryPath, historyPath, boardBudget: 8, now, resolveHost, fetchImpl: emptyFetch(boards) })
    expect(second.stats.boardsCrawled).toBe(2)
    expect(second.results.map((item) => item.identifier)).toEqual(["board-08", "board-09"])

    const dueAt = new Date(now.getTime() + 25 * 60 * 60 * 1000)
    const third = await runAtsJobIngestion({ registryPath, historyPath, boardBudget: 3, now: dueAt, resolveHost, fetchImpl: emptyFetch(boards) })
    const fourth = await runAtsJobIngestion({ registryPath, historyPath, boardBudget: 3, now: new Date(dueAt.getTime() + 1), resolveHost, fetchImpl: emptyFetch(boards) })
    expect(third.results.map((item) => item.identifier)).toEqual(["board-00", "board-01", "board-02"])
    expect(fourth.results.map((item) => item.identifier)).toEqual(["board-03", "board-04", "board-05"])
    expect(fourth.stats.boardsCrawled).toBeLessThanOrEqual(3)
  })

  test("board budget favors never-crawled boards and skips recently healthy boards", async () => {
    const registryPath = tmpPath("budget-registry")
    const historyPath = tmpPath("budget-history")
    const boards = ["a", "b", "c"].map((identifier) => ({ ...company("greenhouse", identifier), id: `company-${identifier}`, canonicalName: `Company ${identifier}` }))
    await registryWith(boards, registryPath)
    const history = await JsonJobHistoryStore.load(historyPath)
    history.recordFetchState({ companyId: "company-a", provider: "greenhouse", identifier: "a", lastAttemptedAt: "2026-09-04T11:00:00.000Z", lastSuccessfulAt: "2026-09-04T11:00:00.000Z", lastJobCount: 1, snapshotComplete: true, updatedAt: "2026-09-04T11:00:00.000Z" })
    await history.save()
    const result = await runAtsJobIngestion({
      registryPath, historyPath, boardBudget: 1, now,
      resolveHost,
      fetchImpl: fetchMap({ "https://boards-api.greenhouse.io/v1/boards/b/jobs?content=true": response(200, JSON.stringify({ jobs: [] })) }),
    })
    expect(result.stats).toMatchObject({ boardsConsidered: 3, boardsCrawled: 1, boardsSkippedFresh: 1, boardsDeferredBudget: 1, successfulBoards: 0, emptyBoards: 1 })
    expect(result.results[0].identifier).toBe("b")
  })

  test("failed board retains incomplete status and existing retry backoff", async () => {
    const registryPath = tmpPath("failure-backoff-registry")
    const historyPath = tmpPath("failure-backoff-history")
    await registryWith([company("greenhouse", "unavailable")], registryPath)
    const failed = await runAtsJobIngestion({
      registryPath, historyPath, boardBudget: 1, now, resolveHost,
      fetchImpl: fetchMap({ "https://boards-api.greenhouse.io/v1/boards/unavailable/jobs?content=true": response(503, "{}") }),
    })
    expect(failed.stats.failedBoards).toBe(1)
    expect(failed.history?.getFetchState("company_greenhouse", "greenhouse", "unavailable")).toMatchObject({
      snapshotComplete: false, persistencePending: false, lastSuccessfulAt: null,
    })
    const retryTooSoon = await runAtsJobIngestion({
      registryPath, historyPath, boardBudget: 1, now: new Date(now.getTime() + 30 * 60 * 1000), resolveHost,
      fetchImpl: fetchMap({}),
    })
    expect(retryTooSoon.stats).toMatchObject({ boardsCrawled: 0, boardsSkippedFresh: 1 })
  })

  test("due successful boards precede failed boards after their retry backoff", async () => {
    const registryPath = tmpPath("fairness-registry")
    const historyPath = tmpPath("fairness-history")
    const due = { ...company("greenhouse", "due"), id: "company-a", canonicalName: "Due board" }
    const failed = { ...company("greenhouse", "failed"), id: "company-b", canonicalName: "Failed board" }
    await registryWith([due, failed], registryPath)
    const history = await JsonJobHistoryStore.load(historyPath)
    const old = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
    history.recordFetchState({ companyId: due.id, provider: "greenhouse", identifier: "due", lastAttemptedAt: old, lastSuccessfulAt: old, snapshotComplete: true, updatedAt: old })
    history.recordFetchState({ companyId: failed.id, provider: "greenhouse", identifier: "failed", lastAttemptedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), lastSuccessfulAt: new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString(), snapshotComplete: false, updatedAt: nowIso })
    await history.save()
    const result = await runAtsJobIngestion({
      registryPath, historyPath, boardBudget: 1, now, resolveHost,
      fetchImpl: fetchMap({ "https://boards-api.greenhouse.io/v1/boards/due/jobs?content=true": response(200, JSON.stringify({ jobs: [] })) }),
    })
    expect(result.results.map((item) => item.identifier)).toEqual(["due"])
  })

  test("only verified mappings are queried and one failure does not stop the batch", async () => {
    const registryPath = tmpPath("registry")
    const historyPath = tmpPath("history")
    const verified = company("greenhouse", "good")
    const failed = company("ashby", "bad")
    const unverified = company("lever", "candidate")
    unverified.ats.verified = false
    unverified.ats.status = "candidate"
    await registryWith([verified, failed, unverified], registryPath)
    const result = await runAtsJobIngestion({
      registryPath,
      historyPath,
      now,
      resolveHost,
      fetchImpl: fetchMap({
        "https://boards-api.greenhouse.io/v1/boards/good/jobs?content=true": response(200, JSON.stringify({ jobs: [{ id: 1, title: "Security Engineer", absolute_url: "https://example.com/1" }] })),
        "https://api.ashbyhq.com/posting-api/job-board/bad": response(500, "{}"),
      }),
    })
    expect(result.stats.companiesAttempted).toBe(2)
    expect(result.stats.successfulBoards).toBe(1)
    expect(result.stats.failedBoards).toBe(1)
    expect(result.history?.stats()).toMatchObject({ historicalJobs: 1, active: 1 })
  })

  test("dry-run does not write history", async () => {
    const registryPath = tmpPath("registry-dry")
    const historyPath = tmpPath("history-dry")
    await registryWith([company("greenhouse", "good")], registryPath)
    await runAtsJobIngestion({
      registryPath,
      historyPath,
      dryRun: true,
      now,
      resolveHost,
      fetchImpl: fetchMap({ "https://boards-api.greenhouse.io/v1/boards/good/jobs?content=true": response(200, JSON.stringify({ jobs: [{ id: 1, title: "Security Engineer" }] })) }),
    })
    expect((await JsonJobHistoryStore.load(historyPath)).list()).toHaveLength(0)
  })
})


test("oversized full Greenhouse response falls back to a complete lightweight snapshot", async () => {
  const result = await fetchAtsJobs(company("greenhouse", "acme"), {
    now, resolveHost,
    fetchImpl: fetchMap({
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": response(200, "{\"jobs\":["),
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=false": response(200, JSON.stringify({ jobs: [{ id: 42, title: "Security Lead", absolute_url: "https://boards.greenhouse.io/acme/jobs/42" }] })),
    }),
  })
  expect(result.success).toBe(true)
  expect(result.snapshotComplete).toBe(true)
  expect(result.jobs).toHaveLength(1)
})
