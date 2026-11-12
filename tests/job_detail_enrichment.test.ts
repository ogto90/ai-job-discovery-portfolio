import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { unlink } from "node:fs/promises"
import type { NormalizedJob } from "../tools/company_registry"
import { evaluateCandidateEligibility, extractJobRequirements, type CandidateProfile } from "../tools/eligibility_engine"
import {
  applyEnrichment,
  enrichJobs,
  enrichmentFromHtml,
  enrichmentCacheKey,
  formatEnrichmentSummary,
  needsEnrichment,
  type JobDetailEnrichment,
  type SourceDetailAdapter,
} from "../tools/job_detail_enrichment"
import { runJobPipeline, type PipelineOptions, type SourceRunResult } from "../tools/job_pipeline"

const now = new Date("2026-09-05T10:00:00.000Z")

const candidate: CandidateProfile = {
  schemaVersion: 1,
  location: { country: "AT", city: "Vienna", acceptableRemoteRegions: ["EU", "Europe", "EMEA", "Worldwide"], relocation: false, hybridCities: ["Vienna"] },
  languages: [{ language: "English", level: "professional" }, { language: "German", level: "basic" }],
  rolePreferences: {
    targetRoles: ["application_security", "product_security", "security_engineering", "secure_sdlc", "vulnerability_management", "security_management", "grc"],
    secondaryRoles: ["security_operations", "technical_security_consulting"],
    lowInterestRoles: ["endpoint_security", "platform_security", "linux_systems", "cryptography", "sales_gtm", "soc"],
    excludedRoles: ["soc_analyst", "cloud_security"],
  },
  skills: [
    { skill: "Application Security", level: "strong" },
    { skill: "Secure SDLC", level: "strong" },
    { skill: "SAST", level: "strong" },
    { skill: "SCA", level: "strong" },
    { skill: "Acunetix", level: "strong" },
    { skill: "Tenable", level: "strong" },
    { skill: "ISO 27001", level: "strong" },
  ],
  certifications: ["CISM"],
  matchPreferences: {
    strengths: ["application_security", "product_security", "secure_sdlc", "sast", "sca", "vulnerability_management", "developer_facing_security", "iso_27001"],
    moderate: ["security_operations", "incident_response", "security_architecture", "grc"],
    lowInterest: ["deep_cloud", "endpoint_security", "linux_systems", "cryptography", "soc_only", "sales_gtm", "federal_clearance"],
    preferredIndustries: ["b2b_software", "product_company"],
    lowerInterestIndustries: ["federal_defense", "sales"],
  },
  careerTrack: { prefer: "hands_on_lead", allowHandsOnLead: true, allowPeopleManagement: true, excluded: ["executive"] },
  seniority: { target: ["senior", "lead"], acceptable: ["mid", "senior", "staff", "principal", "lead", "manager"], excluded: ["intern", "graduate", "junior"] },
  employmentTypes: ["full_time"],
}

function tmpPath(name: string): string {
  return `/tmp/job-detail-enrichment-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}.json`
}

function job(input: Partial<NormalizedJob> & { title: string; company?: string; url?: string }): NormalizedJob {
  return {
    id: input.id ?? input.url ?? input.title,
    title: input.title,
    company: input.company ?? "Example",
    location: input.location ?? "Remote",
    url: input.url ?? `https://jobgether.com/offer/${String(input.id ?? "aaaaaaaaaaaaaaaaaaaaaaaa")}-example`,
    source: input.source ?? "Jobgether",
    portal: input.portal ?? "jobgether-search",
    sourceType: input.sourceType ?? "aggregator",
    description: input.description ?? "",
    tags: input.tags ?? ["security"],
    category: input.category ?? "security compliance",
    ...input,
  }
}

function enrichment(input: Partial<JobDetailEnrichment> & { description?: string; location?: string } = {}): JobDetailEnrichment {
  return {
    status: input.status ?? "success",
    fetchedAt: now.toISOString(),
    source: input.source ?? "jobgether-search",
    description: input.description,
    location: input.location,
    employmentType: input.employmentType,
    salary: input.salary,
    applicationUrl: input.applicationUrl,
    structured: input.structured,
    sourceEvidence: input.sourceEvidence ?? [],
    detailCompleteness: input.detailCompleteness ?? {
      description: Boolean(input.description && input.description.length > 100),
      location: Boolean(input.location),
      workAuthorization: /citizen|authorization|clearance|visa|sponsorship/i.test(input.description ?? ""),
      languages: /german|english/i.test(input.description ?? ""),
      skills: /sast|sca|secure sdlc|application security|vulnerability/i.test(input.description ?? ""),
      salary: Boolean(input.salary),
      employmentType: Boolean(input.employmentType),
    },
    confidence: input.confidence ?? 0.9,
    reason: input.reason,
    httpStatus: input.httpStatus,
    finalUrl: input.finalUrl,
  }
}

function adapter(result: JobDetailEnrichment, calls: { count: number }): SourceDetailAdapter {
  return async () => {
    calls.count += 1
    return result
  }
}

function source(name: string, jobs: NormalizedJob[]): () => Promise<SourceRunResult> {
  return async () => ({
    detail: {
      name,
      attempted: true,
      success: true,
      status: "success",
      jobsReturned: jobs.length,
      normalizedJobs: jobs.length,
      expiredJobs: 0,
      validationFailures: 0,
      uniqueJobs: jobs.length,
      duplicateJobs: 0,
      finalActionableJobs: 0,
    },
    jobs: jobs.map((item) => ({ ...item, source: name, portal: name })),
  })
}

function validation(): PipelineOptions["validator"] {
  return async (jobs) => ({
    all: jobs.map((item) => ({ ...item, validation: { status: "active" as const, method: "page_content" as const, confidence: 90, checkedAt: now.toISOString() } })),
    results: jobs.map((item) => ({ ...item, validation: { status: "active" as const, method: "page_content" as const, confidence: 90, checkedAt: now.toISOString() } })),
  })
}

function emptyAts() {
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

describe("enrichment decisions", () => {
  const substantialDescription = `Responsibilities: Lead application security reviews, design practical controls, implement improvements,
    support product teams, assess vulnerabilities, respond to incidents, build secure processes, and maintain risk registers.
    Qualifications: Collaborate with engineering teams, communicate clearly, own delivery, establish sustainable security practices,
    prioritize competing requests, document decisions, and help product groups reduce measurable risk.`

  test("full-detail job does not need enrichment", () => {
    const full = job({
      title: "Application Security Engineer",
      location: "Remote Europe",
      description: substantialDescription,
    })
    expect(needsEnrichment(full)).toBe(false)
  })

  test("empty description needs enrichment", () => {
    expect(needsEnrichment(job({ title: "Security Engineer", description: "" }))).toBe(true)
  })

  test("remote without geographic scope needs enrichment", () => {
    expect(needsEnrichment(job({ title: "Security Engineer", location: "Remote", description: "Security engineering role. ".repeat(30) }))).toBe(true)
  })

  test("full-detail direct ATS job skips enrichment", () => {
    expect(needsEnrichment(job({ title: "Security Engineer", sourceType: "ats", location: "Remote Europe", description: substantialDescription }))).toBe(false)
  })

  test("onsite ATS location does not make a short description complete", () => {
    expect(needsEnrichment(job({ title: "Security Engineer", sourceType: "ats", location: "Vienna, Austria", description: "Review security controls." }))).toBe(true)
  })

  test("stable cache identity ignores tracking URL params", () => {
    const a = job({ title: "Security Engineer", id: "123", url: "https://jobgether.com/offer/123-title?utm_source=x" })
    const b = job({ title: "Security Engineer", id: "123", url: "https://jobgether.com/offer/123-title" })
    expect(enrichmentCacheKey(a)).toBe(enrichmentCacheKey(b))
  })

  test("JSON-LD detail must match the exact requisition instead of taking the first posting", () => {
    const postings = [
      { "@type": "JobPosting", title: "Designer", url: "https://example.test/jobs/designer", hiringOrganization: { name: "Other Co" }, description: "wrong" },
      { "@type": "JobPosting", title: "Security Engineer", url: "https://example.test/jobs/security", hiringOrganization: { name: "Example" }, description: "right description" },
    ]
    const html = `<script type="application/ld+json">${JSON.stringify({ "@graph": postings })}</script>`
    const parsed = enrichmentFromHtml(job({ title: "Security Engineer", company: "Example", sourceUrl: "https://example.test/jobs/security" }), html, "test", now)
    expect(parsed.status).toBe("success")
    expect(parsed.description).toBe("right description")
  })

  test("ambiguous JSON-LD is rejected rather than applying another job's details", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting", title: "Security Engineer", url: "https://example.test/jobs/other", hiringOrganization: { name: "Other Co" }, description: "wrong requisition",
    })}</script>`
    const parsed = enrichmentFromHtml(job({ title: "Security Engineer", company: "Example", sourceUrl: "https://example.test/jobs/security" }), html, "test", now)
    expect(parsed.status).toBe("failed")
    expect(parsed.description).toBeUndefined()
  })
})

describe("SmartRecruiters public posting detail", () => {
  const detailUrl = "https://api.smartrecruiters.com/v1/companies/Acme/postings/sr-1"
  const fullText = "Responsibilities: Design and implement product security controls, review application vulnerabilities, collaborate with engineering teams, and document risk decisions. Qualifications: Lead secure development reviews, assess threats, prioritize remediation, and communicate clearly with stakeholders. ".repeat(3)
  const posting = (description = "") => job({
    id: "sr-1", title: "Security Engineer", company: "Acme", source: "smartrecruiters", portal: "smartrecruiters",
    sourceType: "ats", location: "Remote Europe", description,
    url: "https://careers.smartrecruiters.com/Acme/job/sr-1",
    ats: { provider: "smartrecruiters", companyIdentifier: "Acme", requisitionId: "sr-1" },
  })
  const detail = (sections: Record<string, unknown>) => ({
    id: "sr-1", company: { identifier: "Acme" }, jobAd: { sections },
  })
  const run = async (input: NormalizedJob, fetchImpl: (url: string, init: RequestInit) => Promise<Response>, maxJobs = 30) =>
    enrichJobs([input], { now, useCache: false, resolveHost: async () => ["93.184.216.34"], fetchImpl, maxJobs })

  test("fetches documented sections, preserves identity, and obtains a full description", async () => {
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
    const result = await run(posting(), async (url, init) => {
      requests.push({ url, redirect: init.redirect })
      return new Response(JSON.stringify(detail({
        jobDescription: { title: "Job Description", text: `<p>${fullText}</p>` },
        qualifications: { title: "Qualifications", text: "<p>Security engineering experience.</p>" },
      })), { status: 200 })
    })
    expect(requests).toEqual([{ url: detailUrl, redirect: "manual" }])
    expect(result.stats).toMatchObject({ attempted: 1, success: 1, fullAfterEnrichment: 1, budget: 30 })
    expect(result.jobs[0].description).toContain("Design and implement product security controls")
    expect(result.jobs[0]).toMatchObject({ id: "sr-1", location: "Remote Europe", source: "smartrecruiters", ats: { requisitionId: "sr-1" } })
  })

  test("accepts a trimmed, case-insensitive company identifier", async () => {
    const result = await run(posting(), async () => new Response(JSON.stringify({
      ...detail({ jobDescription: { text: fullText } }), company: { identifier: " acme " },
    }), { status: 200 }))
    expect(result.stats).toMatchObject({ success: 1, fullAfterEnrichment: 1 })
  })

  test.each([
    ["missing company", undefined],
    ["null company", null],
    ["array company", []],
    ["non-object company", "Acme"],
    ["empty company object", {}],
    ["missing identifier", { name: "Acme" }],
    ["null identifier", { identifier: null }],
    ["empty identifier", { identifier: "" }],
    ["whitespace identifier", { identifier: "   " }],
    ["numeric identifier", { identifier: 42 }],
    ["object identifier", { identifier: { name: "Acme" } }],
    ["different company", { identifier: "OtherCompany" }],
  ])("rejects %s before accepting a full description", async (_label, company) => {
    const original = { ...posting("Current snippet"), applicationState: "applied" }
    const result = await run(original, async () => new Response(JSON.stringify({
      ...detail({ jobDescription: { text: fullText } }), company,
    }), { status: 200 }))
    expect(result.stats).toMatchObject({ attempted: 1, failed: 1, parseFailed: 1, success: 0, fullAfterEnrichment: 0 })
    expect(result.jobs[0]).toMatchObject({ description: "Current snippet", applicationState: "applied", ats: original.ats })
    expect(result.jobs[0].metadata?.detailEnrichment).toMatchObject({ status: "failed", failureKind: "parse" })
    expect(JSON.stringify(result.jobs[0].metadata?.detailEnrichment)).not.toContain(fullText)
  })

  test.each([[undefined], [null], [""], ["  "], [42], [{ id: "sr-1" }], ["other"]])(
    "rejects a missing, malformed, or different posting ID: %p", async (id) => {
      const result = await run(posting(), async () => new Response(JSON.stringify({
        ...detail({ jobDescription: { text: fullText } }), id,
      }), { status: 200 }))
      expect(result.stats).toMatchObject({ failed: 1, parseFailed: 1, success: 0, fullAfterEnrichment: 0 })
      expect(result.jobs[0].description).toBe("")
    },
  )

  test("invalid expected company identity makes no HTTP request", async () => {
    let requests = 0
    const result = await run({
      ...posting(), ats: { provider: "smartrecruiters", companyIdentifier: "   ", requisitionId: "sr-1" },
    }, async () => { requests++; throw new Error("unexpected request") })
    expect(requests).toBe(0)
    expect(result.stats).toMatchObject({ notSupported: 1, success: 0, fullAfterEnrichment: 0 })
  })

  test("an identity rejection does not stop a second posting or change the first", async () => {
    const first = { ...posting("Current snippet"), applicationState: "applied" }
    const second = { ...posting(), id: "sr-2", ats: { provider: "smartrecruiters", companyIdentifier: "Acme", requisitionId: "sr-2" } }
    const result = await enrichJobs([first, second], {
      now, useCache: false, resolveHost: async () => ["93.184.216.34"],
      fetchImpl: async (url) => new Response(JSON.stringify({
        id: url.endsWith("sr-1") ? "sr-1" : "sr-2",
        company: { identifier: url.endsWith("sr-1") ? "OtherCompany" : "Acme" },
        jobAd: { sections: { jobDescription: { text: fullText } } },
      }), { status: 200 }),
    })
    expect(result.stats).toMatchObject({ attempted: 2, failed: 1, success: 1, fullAfterEnrichment: 1 })
    expect(result.jobs[0]).toMatchObject({ description: "Current snippet", applicationState: "applied", ats: first.ats })
    expect(result.jobs[1].description).toContain("Design and implement product security controls")
  })

  test("does not fetch an already-full posting", async () => {
    let calls = 0
    const result = await run(posting(fullText), async () => { calls++; throw new Error("unexpected request") })
    expect(calls).toBe(0)
    expect(result.stats).toMatchObject({ attempted: 0, notNeeded: 1, fullAfterEnrichment: 1 })
  })

  test("paces concurrent posting requests below the documented per-second limit", async () => {
    const starts: number[] = []
    const jobs = ["sr-1", "sr-2", "sr-3"].map((id) => ({
      ...posting(), id, ats: { provider: "smartrecruiters", companyIdentifier: "Acme", requisitionId: id },
    }))
    const result = await enrichJobs(jobs, {
      now, useCache: false, maxJobs: 3, concurrency: 3, resolveHost: async () => ["93.184.216.34"],
      fetchImpl: async (url) => {
        starts.push(performance.now())
        const id = url.split("/").at(-1)
        return new Response(JSON.stringify({ ...detail({}), id }), { status: 200 })
      },
    })
    expect(result.stats.attempted).toBe(3)
    expect(starts).toHaveLength(3)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(80)
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(80)
  })

  test("reports empty details without promoting a missing description", async () => {
    const result = await run(posting(), async () => new Response(JSON.stringify(detail({})), { status: 200 }))
    expect(result.stats).toMatchObject({ attempted: 1, success: 1, fullAfterEnrichment: 0, stillInsufficient: 1 })
    expect(result.jobs[0].description).toBe("")
  })

  test("requires a source-scoped posting ID and rejects a different requisition", async () => {
    const noId = await run({ ...posting(), ats: { provider: "smartrecruiters", companyIdentifier: "Acme" } }, async () => { throw new Error("unexpected request") })
    expect(noId.stats).toMatchObject({ attempted: 1, notSupported: 1 })
    const mismatch = await run(posting(), async () => new Response(JSON.stringify({ ...detail({}), id: "other" }), { status: 200 }))
    expect(mismatch.stats).toMatchObject({ parseFailed: 1, fullAfterEnrichment: 0 })
  })

  test.each([[404, "notFound"], [429, "rateLimited"], [503, "failed"], [302, "failed"]] as const)(
    "classifies HTTP %i without replacing source facts", async (status, counter) => {
      const result = await run(posting(), async () => new Response("{}", { status }))
      expect(result.stats[counter]).toBe(1)
      expect(result.jobs[0].description).toBe("")
      expect(result.jobs[0].ats).toMatchObject({ requisitionId: "sr-1" })
    },
  )

  test("classifies malformed JSON and timeouts", async () => {
    const malformed = await run(posting(), async () => new Response("{", { status: 200 }))
    expect(malformed.stats.parseFailed).toBe(1)
    const timeout = await run(posting(), async () => { throw new Error("request timeout") })
    expect(timeout.stats.timeout).toBe(1)
  })
})

describe("enrichment outcome accounting and selection", () => {
  const fullDescription = "Responsibilities include designing secure systems, collaborating with engineering teams, conducting assessments, improving controls, and documenting outcomes. Requirements include relevant professional experience and clear communication. ".repeat(3)

  const sparseJobs = (count: number, portal = "jobgether-search", prefix = portal) => Array.from({ length: count }, (_, index) => job({
    id: `${prefix}-${index}`,
    title: `Application Security Engineer ${index}`,
    source: portal,
    portal,
    location: "Remote Europe",
    description: "",
    url: `https://example.test/jobs/${prefix}-${index}`,
  }))

  test.each([
    [29, 30, 29], [30, 30, 30], [31, 30, 30],
    [60, 60, 60], [61, 60, 60], [150, 30, 30], [150, 60, 60], [438, 30, 30], [438, 60, 60],
  ])("global budget caps %i eligible candidates at %i attempts", async (count, budget, expected) => {
    let calls = 0
    const result = await enrichJobs(sparseJobs(count), {
      now, useCache: false, maxJobs: budget,
      adapters: { "jobgether-search": async () => {
        calls += 1
        return enrichment({ description: fullDescription })
      } },
    })
    expect(calls).toBe(expected)
    expect(result.jobs).toHaveLength(count)
    expect(result.stats).toMatchObject({
      budget, considered: count, candidatesNeedingEnrichment: count,
      selectedByBudget: expected, attempted: expected, success: expected,
      fullAfterEnrichment: expected, deferred: count - expected,
      stillInsufficient: count - expected,
    })
    expect(result.stats.attempted).toBe(result.stats.success + result.stats.notFound + result.stats.failed + result.stats.rateLimited + result.stats.timeout)
    expect(result.stats.considered).toBe(result.stats.notNeeded + result.stats.notSupported + result.stats.deferred + result.stats.attempted)
    expect(result.stats.bySource["jobgether-search"]?.attempted).toBe(expected)
  })

  test.each([
    [30, { "jobgether-search": 11, greenhouse: 10, "linkedin-search": 9 }],
    [60, { "jobgether-search": 26, greenhouse: 25, "linkedin-search": 9 }],
  ])("Run 54-shaped source mix preserves round-robin order with budget %i", async (budget, expected) => {
    const jobs = [
      ...sparseJobs(40, "jobgether-search", "j"),
      ...sparseJobs(389, "greenhouse", "g"),
      ...sparseJobs(9, "linkedin-search", "l"),
    ]
    const selected: string[] = []
    const detail: SourceDetailAdapter = async (input) => {
      selected.push(String(input.id))
      return enrichment({ description: fullDescription })
    }
    const result = await enrichJobs(jobs, { now, useCache: false, maxJobs: budget,
      adapters: { "jobgether-search": detail, greenhouse: detail, "linkedin-search": detail },
    })
    expect(selected.slice(0, 9)).toEqual(["j-0", "g-0", "l-0", "j-1", "g-1", "l-1", "j-2", "g-2", "l-2"])
    expect(selected).toHaveLength(budget)
    expect(result.stats).toMatchObject({ budget, considered: 438, attempted: budget, success: budget,
      fullAfterEnrichment: budget, deferred: 438 - budget, stillInsufficient: 438 - budget })
    for (const [source, attempts] of Object.entries(expected)) {
      const sourceCount = source === "greenhouse" ? 389 : source === "jobgether-search" ? 40 : 9
      expect(result.stats.bySource[source]).toMatchObject({ considered: sourceCount, attempted: attempts,
        selectedByBudget: attempts, success: attempts, fullAfterEnrichment: attempts, deferred: sourceCount - attempts })
    }
    expect(Object.values(result.stats.bySource).reduce((sum, source) => sum + source.attempted, 0)).toBe(budget)
    expect(formatEnrichmentSummary(result.stats)).toContain(`budget=${budget}`)
  })

  test("unsupported and already-full observations do not consume a global budget", async () => {
    const full = job({ title: "Application Security Engineer", id: "full", sourceType: "ats", location: "Remote Europe", description: fullDescription })
    const jobs = [full, ...sparseJobs(4, "unsupported", "u"), ...sparseJobs(31)]
    let calls = 0
    const result = await enrichJobs(jobs, { now, useCache: false, maxJobs: 30,
      adapters: { "jobgether-search": async () => { calls += 1; return enrichment({ description: fullDescription }) } },
    })
    expect(calls).toBe(30)
    expect(result.stats).toMatchObject({ considered: 36, candidatesAlreadyFull: 1, notNeeded: 1,
      notSupported: 4, attempted: 30, deferred: 1 })
  })

  test("cache hits do not consume the adapter budget", async () => {
    const cachePath = tmpPath("pilot-cache")
    const cached = sparseJobs(1, "jobgether-search", "cached")
    const calls = { count: 0 }
    const detail = adapter(enrichment({ description: fullDescription }), calls)
    try {
      await enrichJobs(cached, { now, cachePath, adapters: { "jobgether-search": detail } })
      const result = await enrichJobs([...cached, ...sparseJobs(31)], {
        now: new Date(now.getTime() + 1_000), cachePath, maxJobs: 30,
        adapters: { "jobgether-search": detail },
      })
      expect(calls.count).toBe(31)
      expect(result.stats).toMatchObject({ considered: 32, cacheHits: 1, attempted: 30,
        selectedByBudget: 30, deferred: 1 })
    } finally {
      if (existsSync(cachePath)) await unlink(cachePath)
    }
  })

  test("concurrent mixed outcomes stay within the global cap and reconcile", async () => {
    let active = 0
    let peak = 0
    let calls = 0
    const result = await enrichJobs(sparseJobs(61), { now, useCache: false, maxJobs: 60, concurrency: 3,
      adapters: { "jobgether-search": async () => {
        const index = calls++
        active += 1
        peak = Math.max(peak, active)
        await Bun.sleep(2)
        active -= 1
        if (index % 5 === 0) return enrichment({ status: "rate_limited", httpStatus: 429 })
        if (index % 5 === 1) return enrichment({ status: "timeout" })
        if (index % 5 === 2) return enrichment({ status: "failed", httpStatus: 503 })
        return enrichment({ description: fullDescription })
      } },
    })
    expect(calls).toBe(60)
    expect(peak).toBe(3)
    expect(result.stats).toMatchObject({ attempted: 60, deferred: 1, rateLimited: 12,
      timeout: 12, failed: 12, httpFailed: 12, success: 24, fullAfterEnrichment: 24 })
    expect(result.stats.attempted).toBe(result.stats.rateLimited + result.stats.timeout + result.stats.failed + result.stats.success)
  })

  test("counts source-level outcomes separately from attempts and full descriptions", async () => {
    const missing = (id: string, portal: string) => job({ id, title: `Role ${id}`, portal, source: portal, description: "", url: `https://example.test/jobs/${id}` })
    const full = job({ id: "full", title: "Application Security Engineer", portal: "jobgether-search", sourceType: "ats", description: fullDescription, location: "Remote Europe" })
    const parseFailJob = missing("parse", "jobgether-search")
    const parseFailure = enrichmentFromHtml(parseFailJob, '<script type="application/ld+json">{"@type":"JobPosting","title":"Different","hiringOrganization":{"name":"Other"}}</script>', "jobgether-search", now)
    const result = await enrichJobs([
      full,
      missing("ok", "jobgether-search"),
      missing("short", "jobgether-search"),
      missing("unsupported", "unmapped-source"),
      missing("404", "source-404"),
      missing("http", "source-http"),
      missing("429", "source-429"),
      missing("timeout", "source-timeout"),
      parseFailJob,
    ], {
      now,
      useCache: false,
      adapters: {
        "source-404": async () => enrichment({ status: "not_found", source: "source-404" }),
        "source-http": async () => enrichment({ status: "failed", httpStatus: 503, source: "source-http" }),
        "source-429": async () => enrichment({ status: "rate_limited", httpStatus: 429, source: "source-429" }),
        "source-timeout": async () => enrichment({ status: "timeout", source: "source-timeout" }),
        "jobgether-search-parse": async () => parseFailure,
        "jobgether-search": async (input) => input.id === "parse" ? parseFailure : input.id === "ok"
          ? enrichment({ description: fullDescription, source: "jobgether-search" })
          : enrichment({ description: "too short", source: "jobgether-search" }),
      },
    })

    expect(result.stats.considered).toBe(9)
    expect(result.stats.candidatesAlreadyFull).toBe(1)
    expect(result.stats.candidatesNeedingEnrichment).toBe(8)
    expect(result.stats.attempted).toBe(7)
    expect(result.stats.deferred).toBe(0)
    expect(result.stats.notSupported).toBe(1)
    expect(result.stats.notFound).toBe(1)
    expect(result.stats.rateLimited).toBe(1)
    expect(result.stats.timeout).toBe(1)
    expect(result.stats.httpFailed).toBe(1)
    expect(result.stats.parseFailed).toBe(1)
    expect(result.stats.fullAfterEnrichment).toBe(2)
    expect(result.stats.stillInsufficient).toBe(7)
    expect(result.stats.bySource["jobgether-search"]?.considered).toBe(4)
    expect(result.stats.bySource["source-http"]?.httpFailed).toBe(1)
    expect(result.stats.attempted).toBe(result.stats.success + result.stats.notFound + result.stats.failed + result.stats.rateLimited + result.stats.timeout)
    const summary = formatEnrichmentSummary(result.stats)
    expect(summary).toContain("budget=30")
    expect(summary).toContain("http_failed=1")
    expect(summary).not.toContain(fullDescription)
  })

  test("budget deferrals are not reported as failed attempts", async () => {
    const selected: string[] = []
    const jobs = Array.from({ length: 31 }, (_, index) => job({
      id: `budget-${index}`,
      title: `Role ${index}`,
      portal: "jobgether-search",
      description: "",
      url: `https://jobgether.com/offer/${String(index).padStart(24, "0")}-role`,
    }))
    const result = await enrichJobs(jobs, {
      now,
      useCache: false,
      maxJobs: 30,
      selectionSeed: "run-a",
      adapters: { "jobgether-search": async (input) => {
        selected.push(String(input.id))
        return enrichment({ description: fullDescription })
      } },
    })
    expect(selected).toHaveLength(30)
    expect(result.stats.budget).toBe(30)
    expect(result.stats.selectedByBudget).toBe(30)
    expect(result.stats.attempted).toBe(30)
    expect(result.stats.deferred).toBe(1)
    expect(result.stats.failed).toBe(0)
    expect(result.stats.stillInsufficient).toBe(1)
  })

})

describe("enrichment cache", () => {
  test("successful cached detail is reused", async () => {
    const cachePath = tmpPath("cache-hit")
    const calls = { count: 0 }
    const jobs = [job({ title: "Security Engineer" })]
    await enrichJobs(jobs, { now, cachePath, adapters: { "jobgether-search": adapter(enrichment({ description: "Remote Europe application security ".repeat(30), location: "Remote Europe" }), calls) } })
    const second = await enrichJobs(jobs, { now: new Date(now.getTime() + 60_000), cachePath, adapters: { "jobgether-search": adapter(enrichment({}), calls) } })
    expect(calls.count).toBe(1)
    expect(second.stats.cacheHits).toBe(1)
    expect(second.jobs[0].description).toContain("Remote Europe")
  })

  test("expired cache is refreshed", async () => {
    const cachePath = tmpPath("expired")
    const calls = { count: 0 }
    const jobs = [job({ title: "Security Engineer" })]
    await enrichJobs(jobs, { now, cachePath, ttlMs: { success: 1 }, adapters: { "jobgether-search": adapter(enrichment({ description: "old ".repeat(200), location: "Remote Europe" }), calls) } })
    const second = await enrichJobs(jobs, { now: new Date(now.getTime() + 10), cachePath, ttlMs: { success: 1 }, adapters: { "jobgether-search": adapter(enrichment({ description: "new ".repeat(200), location: "Remote Europe" }), calls) } })
    expect(calls.count).toBe(2)
    expect(second.jobs[0].description).toContain("new")
  })

  test("transient failures are retried later and not cached", async () => {
    const cachePath = tmpPath("failure")
    const calls = { count: 0 }
    const transient = adapter(enrichment({ status: "timeout", reason: "timeout" }), calls)
    await enrichJobs([job({ title: "Security Engineer" })], { now, cachePath, adapters: { "jobgether-search": transient } })
    await enrichJobs([job({ title: "Security Engineer" })], { now: new Date(now.getTime() + 1_000), cachePath, adapters: { "jobgether-search": transient } })
    expect(calls.count).toBe(2)
  })

  test("not_found is cached", async () => {
    const cachePath = tmpPath("not-found")
    const calls = { count: 0 }
    const missing = adapter(enrichment({ status: "not_found", reason: "404" }), calls)
    await enrichJobs([job({ title: "Security Engineer" })], { now, cachePath, adapters: { "jobgether-search": missing } })
    await enrichJobs([job({ title: "Security Engineer" })], { now: new Date(now.getTime() + 1_000), cachePath, adapters: { "jobgether-search": missing } })
    expect(calls.count).toBe(1)
  })

  test("cache file is created for cacheable statuses", async () => {
    const cachePath = tmpPath("created")
    await enrichJobs([job({ title: "Security Engineer" })], { now, cachePath, adapters: { "jobgether-search": adapter(enrichment({ status: "not_found" }), { count: 0 }) } })
    expect(existsSync(cachePath)).toBe(true)
    await unlink(cachePath)
  })
})

describe("enrichment merge and requirements", () => {
  test("search metadata is preserved while detail description is added", () => {
    const original = job({ title: "Security Engineer", company: "SearchCo", description: "", location: "Anywhere" })
    const merged = applyEnrichment(original, enrichment({ description: "We hire across Europe for application security and secure SDLC. ".repeat(10), location: "Remote Europe" }))
    expect(merged.company).toBe("SearchCo")
    expect(merged.description).toContain("secure SDLC")
    expect((merged.metadata as Record<string, unknown>).originalFields).toBeTruthy()
  })

  test("detail location stronger than vague search location is used", () => {
    const merged = applyEnrichment(job({ title: "Security Engineer", location: "Remote" }), enrichment({ location: "Remote Europe", description: "Europe remote security role. ".repeat(20) }))
    expect(merged.location).toBe("Remote Europe")
    expect(merged.locationRestrictions).toContain("Remote Europe")
  })

  test("contradictory evidence is preserved", () => {
    const merged = applyEnrichment(job({ title: "Security Engineer", location: "Anywhere" }), enrichment({ location: "Remote United States", description: "Must be a U.S. citizen and eligible for security clearance." }))
    expect((merged.metadata as Record<string, unknown>).originalFields).toMatchObject({ location: "Anywhere" })
    expect(String(merged.description)).toContain("U.S. citizen")
  })

  test("US citizenship becomes work-authorization requirement", () => {
    const merged = applyEnrichment(job({ title: "Security and Compliance Engineer", location: "Anywhere" }), enrichment({ description: "Must be a U.S. citizen and be eligible for security clearance.", location: "Remote United States" }))
    const result = evaluateCandidateEligibility(candidate, extractJobRequirements(merged))
    expect(result.status).toBe("fail")
    expect(result.reasons).toContain("workAuthorization")
  })

  test("specific detail location is not overridden by boilerplate global regions", () => {
    const merged = applyEnrichment(job({ title: "Application Security Lead", location: "Remote" }), enrichment({
      description: "Global customer base and teams across Europe, APAC, and North America. Application security lead.",
      location: "Remote (North America)",
      structured: { allowedRegions: ["global", "Europe", "APAC", "North America"] },
    }))
    const result = evaluateCandidateEligibility(candidate, extractJobRequirements(merged))
    expect(result.status).toBe("fail")
    expect(result.reasons).toContain("location")
  })

  test("specific non-European country remains a location fail despite global boilerplate", () => {
    const merged = applyEnrichment(job({ title: "Security Engineer", location: "Remote" }), enrichment({
      description: "Remote-first global team across Europe and APAC.",
      location: "Australia",
      structured: { allowedRegions: ["global", "Europe", "APAC"] },
    }))
    const result = evaluateCandidateEligibility(candidate, extractJobRequirements(merged))
    expect(result.status).toBe("fail")
    expect(result.reasons).toContain("location")
  })

  test("ISO country-code location list including AT passes Austria candidate", () => {
    const merged = applyEnrichment(job({ title: "Product Security Engineer", location: "Europe" }), enrichment({
      description: "Full remote role available in selected countries.",
      location: "CY, GR, EE, LV, FI, PL, DK, GB, CH, SE, NL, AT, BE, DE, IE, FR, SK, CZ, NO, US, IT",
    }))
    const result = evaluateCandidateEligibility(candidate, extractJobRequirements(merged))
    expect(result.status).toBe("pass")
  })

  test("German required fails but German preferred does not", () => {
    const required = evaluateCandidateEligibility(candidate, extractJobRequirements(applyEnrichment(job({ title: "Security Engineer" }), enrichment({ description: "German language is required.", location: "Remote Europe" }))))
    const preferred = evaluateCandidateEligibility(candidate, extractJobRequirements(applyEnrichment(job({ title: "Security Engineer" }), enrichment({ description: "German preferred.", location: "Remote Europe" }))))
    expect(required.status).toBe("fail")
    expect(preferred.status).toBe("pass")
  })
})

describe("pipeline enrichment regressions", () => {
  async function run(input: NormalizedJob, detail: JobDetailEnrichment) {
    return await runJobPipeline({
      now,
      candidateProfilePath: "tests/fixtures/synthetic_candidate_profile.json",
      sourceRunners: [source("jobgether-search", [input])],
      validator: validation(),
      atsRunner: async () => emptyAts(),
      enricher: (jobs) => enrichJobs(jobs, { now, cachePath: tmpPath("pipeline"), adapters: { "jobgether-search": adapter(detail, { count: 0 }) } }),
      writeArtifact: false,
    })
  }

  test("sparse compliance job becomes FAIL after citizenship detail", async () => {
    const result = await run(job({ title: "Security and Compliance Engineer", location: "Anywhere" }), enrichment({ description: "Must be a U.S. citizen and be eligible for security clearance.", location: "Remote United States" }))
    expect(result.artifact.counts.eligibilityFail).toBe(1)
    expect(result.artifact.counts.finalCandidates).toBe(0)
  })

  test("sparse remote security engineer becomes PASS when detail says Europe", async () => {
    const result = await run(job({ title: "Security Engineer", location: "Remote" }), enrichment({ description: "We hire across Europe and strongly prefer European time zones. Security engineering.", location: "Remote Europe" }))
    expect(result.artifact.jobs[0].pipeline?.eligibility.status).toBe("pass")
  })

  test("sparse GTM role stays eligible but weakly matched", async () => {
    const result = await run(job({ title: "Cyber Security GTM Leader", location: "Remote Europe" }), enrichment({ description: "Lead go-to-market sales strategy and customer acquisition for cybersecurity.", location: "Remote Europe" }))
    expect(result.artifact.jobs[0].pipeline?.eligibility.status).toBe("pass")
    expect(result.artifact.jobs[0].pipeline?.match?.overallScore).toBeLessThan(50)
  })

  test("sparse AppSec role uses enriched features for high match", async () => {
    const result = await run(job({ title: "Application Security Engineer", location: "Remote Europe" }), enrichment({ description: "Own Secure SDLC, SAST, SCA, threat modeling, CI/CD security, vulnerability management, and developer coaching.", location: "Remote Europe" }))
    expect(result.artifact.jobs[0].pipeline?.match?.overallScore).toBeGreaterThanOrEqual(75)
  })
})
