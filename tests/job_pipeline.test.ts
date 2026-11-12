import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import {
  evaluateEligibility,
  makeCliSourceRunnerWithCommand,
  runJobPipeline,
  type PipelineOptions,
  type SourceRunResult,
} from "../tools/job_pipeline"
import { emptyRegistry, type NormalizedJob } from "../tools/company_registry"
import type { CandidateProfile } from "../tools/eligibility_engine"
import { JsonJobHistoryStore } from "../tools/job_history"
import type { AtsFetchResult, AtsIngestionStats } from "../tools/ats_job_ingestor"
import { evaluateFinalJobEligibility, normalizeDiscoveredJob, type SearchProfileRecord } from "../tools/generic_discovery"
import { selectTopJobs } from "../tools/daily_job_report"

const now = new Date("2026-09-05T10:00:00.000Z")
const candidate: CandidateProfile = {
  schemaVersion: 1,
  location: { country: "AT", city: "Vienna", acceptableRemoteRegions: ["EU", "Europe", "EMEA", "Worldwide"], relocation: false, hybridCities: ["Vienna"] },
  languages: [{ language: "English", level: "professional" }, { language: "German", level: "basic" }],
  rolePreferences: { targetRoles: ["application_security", "product_security", "security_engineering", "security_management"], excludedRoles: ["soc_analyst", "cloud_security"] },
  careerTrack: { allowHandsOnLead: true, allowPeopleManagement: true, excluded: ["executive"] },
  seniority: { acceptable: ["mid", "senior", "staff", "principal", "lead", "manager"], excluded: ["intern", "graduate", "junior"] },
  employmentTypes: ["full_time"],
}

function tmpPath(name: string): string {
  return `/tmp/job-pipeline-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}.json`
}

function job(input: Partial<NormalizedJob> & { title: string; company: string; url: string }): NormalizedJob {
  return {
    id: input.id ?? input.url,
    title: input.title,
    company: input.company,
    location: input.location ?? "Remote Europe",
    date: input.date ?? "2026-09-05",
    url: input.url,
    source: input.source ?? "test-source",
    portal: input.portal ?? input.source ?? "test-source",
    sourceType: input.sourceType ?? "aggregator",
    description: input.description ?? "Application security and vulnerability management role.",
    ...input,
  }
}

function source(name: string, jobs: NormalizedJob[], status: SourceRunResult["detail"]["status"] = jobs.length ? "success" : "zero_results", error?: string): () => Promise<SourceRunResult> {
  return async () => ({
    detail: {
      name,
      attempted: true,
      success: status === "success" || status === "zero_results",
      status,
      errorCategory: status === "success" || status === "zero_results" ? undefined : status,
      error,
      jobsReturned: jobs.length,
      normalizedJobs: jobs.length,
      expiredJobs: 0,
      validationFailures: 0,
      uniqueJobs: jobs.length,
      duplicateJobs: 0,
      finalActionableJobs: 0,
    },
    jobs: jobs.map((item) => ({ ...item, portal: name, source: name })),
  })
}

function validation(statuses: Record<string, "active" | "expired" | "validation_failed" | "uncertain">): PipelineOptions["validator"] {
  return async (jobs) => {
    const all = jobs.map((item) => ({
      ...item,
      validation: {
        status: statuses[String(item.id)] ?? "active",
        method: "page_content" as const,
        confidence: 90,
        checkedAt: now.toISOString(),
      },
    }))
    return {
      all,
      results: all.filter((item) => item.validation.status !== "expired"),
    }
  }
}

function emptyAts(): { stats: AtsIngestionStats; results: AtsFetchResult[]; jobs: NormalizedJob[] } {
  return {
    stats: {
      verifiedCompanies: 0,
      companiesAttempted: 0,
      successfulBoards: 0,
      failedBoards: 0,
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
    },
    results: [],
    jobs: [],
  }
}

function atsSuccess(jobs: NormalizedJob[], snapshotComplete = true): { stats: AtsIngestionStats; results: AtsFetchResult[]; jobs: NormalizedJob[] } {
  return {
    stats: {
      ...emptyAts().stats,
      verifiedCompanies: 1,
      companiesAttempted: 1,
      successfulBoards: snapshotComplete ? 1 : 0,
      failedBoards: snapshotComplete ? 0 : 1,
      totalJobsFetched: jobs.length,
      jobsNormalized: jobs.length,
      providerDistribution: { greenhouse: 1 },
    },
    results: [{
      companyId: "company_acme",
      provider: "greenhouse",
      identifier: "acme",
      fetchedAt: now.toISOString(),
      jobs: snapshotComplete ? jobs : [],
      allJobs: snapshotComplete ? jobs : [],
      success: snapshotComplete,
      snapshotComplete,
      error: snapshotComplete ? undefined : "provider error",
      retryable: !snapshotComplete,
    }],
    jobs: snapshotComplete ? jobs : [],
  }
}

async function registry(path: string): Promise<void> {
  await mkdir("/tmp", { recursive: true })
  await writeFile(path, `${JSON.stringify(emptyRegistry(), null, 2)}\n`, "utf8")
}

describe("deterministic pipeline orchestration", () => {
  test("a Jobnet authorization failure stops only that source run", async () => {
    let jobnetCalls = 0
    const jobnet = makeCliSourceRunnerWithCommand("jobnet-search", () => ["search"])
    const result = await jobnet({
      candidateProfilePath: "profile.md",
      discoveryQueries: ["security engineer", "application security", "product security"],
      commandRunner: async (_command, args) => {
        expect(args).toEqual(["search"])
        jobnetCalls += 1
        return { code: 1, stdout: "", stderr: '{"error":"API request failed: 401 Unauthorized","code":"API_ERROR"}', timedOut: false }
      },
    })

    expect(jobnetCalls).toBe(1)
    expect(result.jobs).toEqual([])
    expect(result.detail).toMatchObject({
      attempted: true,
      success: false,
      status: "authorization_failed",
      errorCategory: "authorization_failed",
      queriesAttempted: 1,
      pagesAttempted: 1,
    })
  })

  test("a Jobnet authorization failure does not interrupt another provider", async () => {
    const availableJob = job({ id: "other-provider", title: "Application Security Engineer", company: "Other", url: "https://other.example/job" })
    let jobnetCalls = 0
    const jobnet = makeCliSourceRunnerWithCommand("jobnet-search", () => ["search"])
    const result = await runJobPipeline({
      now,
      candidateProfilePath: "profile.md",
      discoveryQueries: ["security engineer", "application security"],
      commandRunner: async () => {
        jobnetCalls += 1
        return { code: 1, stdout: "", stderr: '{"error":"API request failed: 401 Unauthorized","code":"API_ERROR"}', timedOut: false }
      },
      sourceRunners: [jobnet, source("other-provider", [availableJob])],
      validator: validation({}),
      atsRunner: async () => emptyAts(),
      writeArtifact: false,
    })

    expect(jobnetCalls).toBe(1)
    expect(result.artifact.sources.details.find((item) => item.name === "jobnet-search")).toMatchObject({
      success: false,
      status: "authorization_failed",
      jobsReturned: 0,
    })
    expect(result.artifact.sources.details.find((item) => item.name === "other-provider")?.status).toBe("success")
    expect(result.artifact.counts.finalCandidates).toBe(1)
    expect(result.artifact.ats.details).toEqual([])
  })

  test("a transient timeout does not short-circuit later queries", async () => {
    let calls = 0
    const runner = makeCliSourceRunnerWithCommand("jobnet-search", () => ["search"])
    const result = await runner({
      candidateProfilePath: "profile.md",
      discoveryQueries: ["security engineer", "application security"],
      commandRunner: async () => {
        calls += 1
        return { code: null, stdout: "", stderr: "", timedOut: true }
      },
    })

    expect(calls).toBe(2)
    expect(result.detail).toMatchObject({
      success: false,
      status: "timeout",
      errorCategory: "timeout",
      queriesAttempted: 2,
    })
  })

  test("two successful portal sources, zero-result source, 403, timeout, and source stats", async () => {
    const appsec = job({ id: "appsec", title: "Application Security Engineer", company: "A", url: "https://a.example/job" })
    const mgr = job({ id: "mgr", title: "Security Manager", company: "B", url: "https://b.example/job" })
    const result = await runJobPipeline({
      now,
      candidateProfilePath: "profile.md",
      sourceRunners: [
        source("one", [appsec]),
        source("two", [mgr]),
        source("zero", []),
        source("blocked", [], "blocked", "403 Forbidden"),
        source("slow", [], "timeout", "timed out"),
      ],
      validator: validation({}),
      atsRunner: async () => emptyAts(),
      writeArtifact: false,
    })
    expect(result.artifact.sources).toMatchObject({ attempted: 5, successful: 3, failed: 2 })
    expect(result.artifact.sources.details.find((item) => item.name === "zero")?.status).toBe("zero_results")
    expect(result.artifact.sources.details.find((item) => item.name === "blocked")?.errorCategory).toBe("blocked")
    expect(result.artifact.sources.details.find((item) => item.name === "slow")?.errorCategory).toBe("timeout")
    expect(result.artifact.counts.finalCandidates).toBe(2)
  })

  test("expired jobs are excluded but transient validation failures remain candidate-visible", async () => {
    const expired = job({ id: "expired", title: "Security Engineer", company: "A", url: "https://a.example/expired" })
    const failed = job({ id: "failed", title: "Product Security Engineer", company: "B", url: "https://b.example/failed" })
    const result = await runJobPipeline({
      now,
      candidateProfilePath: "profile.md",
      sourceRunners: [source("one", [expired, failed])],
      validator: validation({ expired: "expired", failed: "validation_failed" }),
      atsRunner: async () => emptyAts(),
      writeArtifact: false,
    })
    expect(result.artifact.counts.expired).toBe(1)
    expect(result.artifact.counts.validationFailed).toBe(1)
    expect(result.artifact.counts.finalCandidates).toBe(1)
    expect(result.artifact.jobs).toHaveLength(2)
    expect(result.artifact.jobs.find((item) => item.id === "failed")?.pipeline?.excluded).toBe(false)
    expect(result.artifact.jobs.find((item) => item.id === "expired")?.pipeline?.excluded).toBe(true)
  })

  test("fresh source jobs with transient HTTP validation failures are not silently removed", async () => {
    const failures = [
      job({ id: "403", title: "Application Security Engineer", company: "A", url: "https://a.example/403" }),
      job({ id: "429", title: "Product Security Engineer", company: "B", url: "https://b.example/429" }),
      job({ id: "timeout", title: "Security Manager", company: "C", url: "https://c.example/timeout" }),
      job({ id: "500", title: "Vulnerability Management Lead", company: "D", url: "https://d.example/500" }),
    ]
    const result = await runJobPipeline({
      now,
      candidateProfilePath: "profile.md",
      sourceRunners: [source("fresh-api", failures)],
      validator: async (jobs) => {
        const all = jobs.map((item) => ({
          ...item,
          validation: {
            status: "validation_failed" as const,
            method: "http_status" as const,
            confidence: 25,
            checkedAt: now.toISOString(),
            reason: String(item.id) === "timeout" ? "timeout" : `HTTP ${item.id}`,
            httpStatus: String(item.id) === "timeout" ? undefined : Number(item.id),
          },
        }))
        return { all, results: all }
      },
      atsRunner: async () => emptyAts(),
      writeArtifact: false,
    })
    expect(result.artifact.counts.validationFailed).toBe(4)
    expect(result.artifact.counts.finalCandidates).toBe(4)
    expect(result.artifact.jobs.every((item) => item.pipeline?.excluded === false)).toBe(true)
  })

  test("location, language, seniority, management, and unknown eligibility are deterministic", () => {
    expect(evaluateEligibility(job({ title: "Security Engineer", company: "US", location: "Remote (North America)", url: "https://us.example" }), candidate).reasons).toContain("location")
    expect(evaluateEligibility(job({ title: "Senior Information Security Specialist (German-speaking)", company: "DE", url: "https://de.example", description: "German (C1/C2) is a must" }), candidate).reasons).toContain("language")
    expect(evaluateEligibility(job({ title: "Junior Security Engineer", company: "J", url: "https://j.example" }), candidate).reasons).toContain("seniority")
    expect(evaluateEligibility(job({ title: "Chief Information Security Officer", company: "D", url: "https://d.example" }), candidate).reasons).toContain("management")
    expect(evaluateEligibility(job({ title: "Security Manager", company: "M", location: "Remote Europe", url: "https://m.example", description: "Report to a director and mentor graduates.", employmentType: "Full Time" }), candidate).status).toBe("pass")
    expect(evaluateEligibility(job({ title: "Cyber Security Analyst / Security Engineer", company: "A", location: "Remote Europe", url: "https://a.example" }), candidate).reasons).toContain("roleMismatch")
    expect(evaluateEligibility(job({ title: "Cloud Security Engineer", company: "C", location: "Remote Europe", url: "https://c.example" }), candidate).reasons).toContain("roleMismatch")
    expect(evaluateEligibility(job({ title: "Security Engineer", company: "R", location: "Remote", url: "https://r.example" }), candidate).status).toBe("unknown")
  })

  test("ATS success merges with aggregator duplicate, preserves provenance, and chooses direct ATS", async () => {
    const aggregator = job({
      id: "agg",
      title: "Security Engineer",
      company: "Acme",
      url: "https://himalayas.example/acme",
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/123",
      source: "himalayas",
    })
    const direct = job({
      id: "123",
      title: "Security Engineer",
      company: "Acme",
      companyId: "company_acme",
      url: "https://boards.greenhouse.io/acme/jobs/123",
      canonicalUrl: "https://boards.greenhouse.io/acme/jobs/123",
      source: "greenhouse",
      sourceType: "ats",
      ats: { provider: "greenhouse", companyIdentifier: "acme", requisitionId: "123" },
      validation: { status: "active", method: "ats_api", confidence: 100, checkedAt: now.toISOString() },
    })
    const result = await runJobPipeline({
      now,
      candidateProfilePath: "profile.md",
      sourceRunners: [source("himalayas", [aggregator])],
      validator: validation({}),
      atsRunner: async () => atsSuccess([direct]),
      writeArtifact: false,
    })
    expect(result.artifact.counts.duplicatesRemoved).toBe(1)
    expect(result.artifact.jobs.find((item) => item.sourceType === "ats")?.metadata).toMatchObject({ seenVia: expect.arrayContaining(["himalayas", "greenhouse"]) })
    expect(result.artifact.jobs.filter((item) => item.pipeline?.directATS)).toHaveLength(1)
  })

  test("stable schema, dry-run artifact behavior, and no duplicate inflation on repeated run", async () => {
    const registryPath = tmpPath("registry")
    const historyPath = tmpPath("history")
    await registry(registryPath)
    const candidate = job({ id: "one", title: "Security Engineer", company: "A", url: "https://a.example/one" })
    const opts: PipelineOptions = {
      now,
      candidateProfilePath: "profile.md",
      sourceRunners: [source("one", [candidate])],
      validator: validation({}),
      atsRunner: async () => emptyAts(),
      registryPath,
      historyPath,
      dryRun: true,
    }
    const first = await runJobPipeline(opts)
    const second = await runJobPipeline(opts)
    expect(first.artifactPath).toBeUndefined()
    expect(first.artifact).toHaveProperty("runId")
    expect(first.artifact).toHaveProperty("sources.details")
    expect(first.artifact).toHaveProperty("counts.finalCandidates")
    expect(second.artifact.counts.finalCandidates).toBe(first.artifact.counts.finalCandidates)
    expect(existsSync(historyPath)).toBe(false)
  })

  test("complete ATS snapshot closes disappeared history but failed snapshot does not", async () => {
    const historyPath = tmpPath("history-close")
    const store = await JsonJobHistoryStore.load(historyPath)
    const direct = job({
      id: "123",
      title: "Security Engineer",
      company: "Acme",
      companyId: "company_acme",
      url: "https://boards.greenhouse.io/acme/jobs/123",
      source: "greenhouse",
      sourceType: "ats",
      ats: { provider: "greenhouse", companyIdentifier: "acme", requisitionId: "123" },
    })
    store.upsertSnapshot({ companyId: "company_acme", companyName: "Acme", source: "greenhouse", provider: "greenhouse", identifier: "acme", jobs: [direct], fetchedAt: now.toISOString(), snapshotComplete: true })
    store.upsertSnapshot({ companyId: "company_acme", companyName: "Acme", source: "greenhouse", provider: "greenhouse", identifier: "acme", jobs: [], fetchedAt: "2026-09-05T11:00:00.000Z", snapshotComplete: false })
    expect(store.list()[0].status).toBe("active")
    store.upsertSnapshot({ companyId: "company_acme", companyName: "Acme", source: "greenhouse", provider: "greenhouse", identifier: "acme", jobs: [], fetchedAt: "2026-09-05T12:00:00.000Z", snapshotComplete: true })
    expect(store.list()[0].status).toBe("closed")
  })

  test("daily path and active discovery share multi-profile actionability outcomes", async () => {
    const profiles: Array<{ profile: SearchProfileRecord; jobs: Array<[string, string]>; accepted: string[] }> = [
      { profile: { id: 1, user_id: "u1", name: "Security", is_active: true, min_fit_score: 60, definition: { target_titles: ["Security Engineer", "Application Security", "Product Security"], work_models: ["remote"] } }, jobs: [["Senior Security Engineer", "Security"], ["Senior Software Engineer", "Software"]], accepted: ["Senior Security Engineer"] },
      { profile: { id: 2, user_id: "u2", name: "Software", is_active: true, min_fit_score: 60, definition: { target_titles: ["Software Engineer", "Backend Engineer", "Platform Engineer"], work_models: ["remote"] } }, jobs: [["Senior Software Engineer", "Software"], ["Platform Engineer", "Platform"], ["Senior Security Engineer", "Security"]], accepted: ["Senior Software Engineer", "Platform Engineer"] },
      { profile: { id: 3, user_id: "u3", name: "Sales", is_active: true, min_fit_score: 60, definition: { target_titles: ["Account Executive", "Sales", "Business Development"], work_models: ["remote"] } }, jobs: [["Account Executive", "AE"], ["Business Development Manager", "BD"], ["Senior Security Engineer", "Security"]], accepted: ["Account Executive", "Business Development Manager"] },
    ]
    for (const { profile, jobs: rows, accepted } of profiles) {
      const sourceJobs = rows.map(([title, id]) => job({ id, title, company: id, url: `https://example.test/${id}` }))
      const result = await runJobPipeline({
        now,
        candidateProfilePath: null,
        searchProfile: profile,
        sourceRunners: [source("profile-fixture", sourceJobs)],
        validator: validation({}),
        atsRunner: async () => emptyAts(),
        writeArtifact: false,
      })
      for (const item of result.artifact.jobs) {
        const normalizedJob = normalizeDiscoveredJob(item, String(item.source))!
        normalizedJob.validation = item.validation
        expect(item.pipeline?.searchEligibility).toEqual(evaluateFinalJobEligibility(normalizedJob, profile))
      }
      const actionable = result.artifact.jobs.filter((item) => item.pipeline?.searchEligibility?.actionable).map((item) => item.title).sort()
      expect(actionable).toEqual([...accepted].sort())
      const selected = selectTopJobs(result.artifact, 0, 20).map((item) => item.title).sort()
      expect(selected).toEqual([...accepted].sort())
    }
  })

  test("per-user application/ignore suppression is applied after generic eligibility without changing lifecycle", async () => {
    const profile: SearchProfileRecord = { id: 5, user_id: "u1", name: "Security", is_active: true, min_fit_score: 60, definition: { target_titles: ["Application Security Engineer"], work_models: ["remote"] } }
    const target = job({ id: "suppressed", title: "Application Security Engineer", company: "Co", url: "https://example.test/suppressed" })
    const result = await runJobPipeline({
      now,
      candidateProfilePath: null,
      searchProfile: profile,
      sourceRunners: [source("fixture", [target])],
      validator: validation({}),
      atsRunner: async () => emptyAts(),
      suppressionChecker: async () => true,
      writeArtifact: false,
    })
    const processed = result.artifact.jobs[0]
    expect(processed.pipeline?.searchEligibility?.actionable).toBe(true)
    expect(processed.pipeline?.suppressed).toBe(true)
    expect(processed.pipeline?.excluded).toBe(true)
    expect(processed.validation?.status).toBe("active")
    expect(result.artifact.counts.finalCandidates).toBe(0)
  })

  test("artifact is written when not dry-run", async () => {
    const artifactDir = `/tmp/job-pipeline-artifacts-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const result = await runJobPipeline({
      now,
      candidateProfilePath: "profile.md",
      sourceRunners: [source("one", [job({ id: "one", title: "Security Engineer", company: "A", url: "https://a.example/one" })])],
      validator: validation({}),
      atsRunner: async () => emptyAts(),
      artifactDir,
    })
    expect(result.artifactPath).toBeTruthy()
    const saved = JSON.parse(await readFile(result.artifactPath!, "utf8"))
    expect(saved.runId).toBe(result.artifact.runId)
  })
})
