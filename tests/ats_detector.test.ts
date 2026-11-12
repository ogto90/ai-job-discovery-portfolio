import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import {
  JsonCompanyRegistry,
  harvestCompanies,
  type AtsMapping,
  type NormalizedJob,
} from "../tools/company_registry"
import {
  parseAtsUrl,
  resolveCandidate,
  runAtsDetector,
  slugCandidates,
  validateAtsCandidate,
  type AtsCandidate,
} from "../tools/ats_detector"

const observedAt = "2026-09-04T12:00:00.000Z"
const resolveHost = async () => ["93.184.216.34"]

function tmpPath(name: string): string {
  return `/tmp/ats-detector-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}.json`
}

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: "job-1",
    title: "Senior Application Security Engineer",
    company: "Acme Security",
    url: "https://boards.greenhouse.io/acmesecurity/jobs/123",
    portal: "test",
    location: "Remote Europe",
    ...overrides,
  }
}

function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

function fetchMap(routes: Record<string, Response | Response[]>): (url: string, init: RequestInit) => Promise<Response> {
  return async (url) => {
    const value = routes[url]
    if (!value) return textResponse(404, "{}")
    if (Array.isArray(value)) return value.shift() ?? textResponse(404, "{}")
    return value
  }
}

function candidate(url: string): AtsCandidate {
  const parsed = parseAtsUrl(url)
  if (!parsed) throw new Error(`not an ATS URL: ${url}`)
  return parsed
}

describe("ATS URL parsing", () => {
  test("extracts supported provider identifiers", () => {
    expect(parseAtsUrl("https://boards.greenhouse.io/acme/jobs/123")?.identifier).toBe("acme")
    expect(parseAtsUrl("https://job-boards.greenhouse.io/acme/jobs/123")?.provider).toBe("greenhouse")
    expect(parseAtsUrl("https://jobs.lever.co/acme/abc-123")?.identifier).toBe("acme")
    expect(parseAtsUrl("https://jobs.ashbyhq.com/acme/abc-123")?.provider).toBe("ashby")
    expect(parseAtsUrl("https://careers.smartrecruiters.com/Acme/123-security")?.identifier).toBe("Acme")
    expect(parseAtsUrl("https://acme.jobs.personio.de/job/123")?.provider).toBe("personio")
  })

  test("rejects unrelated and aggregator URLs", () => {
    expect(parseAtsUrl("https://example.com/careers/security")).toBeNull()
    expect(parseAtsUrl("https://www.linkedin.com/jobs/view/123")).toBeNull()
    expect(parseAtsUrl("https://himalayas.app/companies/acme/jobs/security")).toBeNull()
  })
})

describe("provider validation", () => {
  test("validates Greenhouse, Lever, Ashby, SmartRecruiters, and Personio bodies", async () => {
    const routes = fetchMap({
      "https://boards-api.greenhouse.io/v1/boards/acmesecurity/jobs?content=false": textResponse(200, JSON.stringify({ jobs: [{ title: "AppSec" }] })),
      "https://api.lever.co/v0/postings/acmesecurity?mode=json": textResponse(200, JSON.stringify([{ text: "AppSec", company: "Acme Security" }])),
      "https://api.ashbyhq.com/posting-api/job-board/acmesecurity": textResponse(200, JSON.stringify({ organizationName: "Acme Security", jobs: [{ title: "AppSec" }] })),
      "https://api.smartrecruiters.com/v1/companies/AcmeSecurity/postings": textResponse(200, JSON.stringify({ content: [{ name: "AppSec", company: { name: "Acme Security" } }] })),
      "https://acme.jobs.personio.de/xml?language=en": textResponse(200, "<workzag-jobs><position><company>Acme Security</company></position></workzag-jobs>"),
    })
    await expect(validateAtsCandidate(candidate("https://boards.greenhouse.io/acmesecurity/jobs/123"), { fetchImpl: routes, resolveHost })).resolves.toMatchObject({ status: "valid" })
    await expect(validateAtsCandidate(candidate("https://jobs.lever.co/acmesecurity/abc"), { fetchImpl: routes, resolveHost })).resolves.toMatchObject({ status: "valid" })
    await expect(validateAtsCandidate(candidate("https://jobs.ashbyhq.com/acmesecurity/abc"), { fetchImpl: routes, resolveHost })).resolves.toMatchObject({ status: "valid" })
    await expect(validateAtsCandidate(candidate("https://careers.smartrecruiters.com/AcmeSecurity/123-appsec"), { fetchImpl: routes, resolveHost })).resolves.toMatchObject({ status: "valid" })
    await expect(validateAtsCandidate(candidate("https://acme.jobs.personio.de/job/123"), { fetchImpl: routes, resolveHost })).resolves.toMatchObject({ status: "valid" })
  })

  test("company-name validation is profession-neutral and keeps security-branded employers", async () => {
    const result = await validateAtsCandidate(candidate("https://boards.greenhouse.io/securityscorecard/jobs/123"), {
      fetchImpl: fetchMap({
        "https://boards-api.greenhouse.io/v1/boards/securityscorecard/jobs?content=false": textResponse(200, JSON.stringify({
          company_name: "SecurityScorecard",
          name: "Senior Security Engineer",
          jobs: [{ title: "Application Security Engineer" }],
        })),
      }),
      resolveHost,
    })
    expect(result.status).toBe("valid")
    expect(result.names).toContain("SecurityScorecard")
    expect(result.names).not.toContain("Senior Security Engineer")
  })

  test("definitive and transient failures are separate", async () => {
    await expect(validateAtsCandidate(candidate("https://boards.greenhouse.io/acme/jobs/123"), {
      fetchImpl: fetchMap({ "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=false": textResponse(404, "{}") }),
      resolveHost,
    })).resolves.toMatchObject({ status: "invalid" })
    await expect(validateAtsCandidate(candidate("https://jobs.lever.co/acme/abc"), {
      fetchImpl: fetchMap({ "https://api.lever.co/v0/postings/acme?mode=json": [textResponse(429, "{}"), textResponse(500, "{}")] }),
      resolveHost,
    })).resolves.toMatchObject({ status: "validation_failed" })
    await expect(validateAtsCandidate(candidate("https://acme.jobs.personio.de/job/123"), {
      fetchImpl: fetchMap({ "https://acme.jobs.personio.de/xml?language=en": textResponse(404, "") }),
      resolveHost,
    })).resolves.toMatchObject({ status: "validation_failed" })
  })
})

describe("identity and confidence", () => {
  test("direct job URL plus valid endpoint verifies when identity matches", async () => {
    const { registry } = await harvestCompanies([job()], { registryPath: tmpPath("direct"), observedAt, save: false })
    const company = registry.listCompanies()[0]
    const resolved = await resolveCandidate(company, candidate("https://boards.greenhouse.io/acmesecurity/jobs/123"), {
      fetchImpl: fetchMap({ "https://boards-api.greenhouse.io/v1/boards/acmesecurity/jobs?content=false": textResponse(200, JSON.stringify({ jobs: [{ title: "AppSec" }] })) }),
      resolveHost,
      now: new Date(observedAt),
    })
    expect(resolved.mapping.status).toBe("verified")
    expect(resolved.mapping.confidence).toBeGreaterThanOrEqual(80)
  })

  test("endpoint existence without identity match remains unverified", async () => {
    const { registry } = await harvestCompanies([job({ company: "Other Company", url: "https://example.com/security", companyDomain: "other.example" })], { registryPath: tmpPath("mismatch"), observedAt, save: false })
    const company = registry.listCompanies()[0]
    const slugOnly = candidate("https://boards.greenhouse.io/acmesecurity/jobs/123")
    slugOnly.evidence = [{ type: "slug_probe", url: slugOnly.boardUrl, detail: "test", observedAt }]
    const resolved = await resolveCandidate(company, slugOnly, {
      fetchImpl: fetchMap({ "https://boards-api.greenhouse.io/v1/boards/acmesecurity/jobs?content=false": textResponse(200, JSON.stringify({ jobs: [{ title: "AppSec" }] })) }),
      resolveHost,
      now: new Date(observedAt),
    })
    expect(resolved.mapping.status).toBe("candidate")
    expect(resolved.mapping.verified).toBe(false)
    expect(resolved.mapping.confidence).toBeLessThan(80)
  })

  test("slug candidate generation is bounded", async () => {
    expect(slugCandidates({
      ...(await harvestCompanies([job()], { registryPath: tmpPath("slug"), observedAt, save: false })).registry.listCompanies()[0],
      aliases: ["Acme Security GmbH", "Acme Security, Inc.", "Acme"],
    }).length).toBeLessThanOrEqual(3)
  })
})

describe("registry updates and discovery", () => {
  test("candidate moves to verified and preserves firstDetected", async () => {
    const path = tmpPath("persist")
    await harvestCompanies([job()], { registryPath: path, observedAt })
    const before = (await JsonCompanyRegistry.load(path)).listCompanies()[0].ats.firstDetected
    const result = await runAtsDetector({
      registryPath: path,
      onlyCandidates: true,
      force: true,
      fetchImpl: fetchMap({ "https://boards-api.greenhouse.io/v1/boards/acmesecurity/jobs?content=false": textResponse(200, JSON.stringify({ jobs: [{ title: "AppSec" }] })) }),
      resolveHost,
      now: new Date("2026-09-05T12:00:00.000Z"),
    })
    const company = result.registry.listCompanies()[0]
    expect(company.ats.status).toBe("verified")
    expect(company.ats.firstDetected).toBe(before)
    expect(company.ats.lastVerified).toBe("2026-09-05T12:00:00.000Z")
  })

  test("transient failure does not erase verified mapping", async () => {
    const path = tmpPath("verified-fail")
    const verified: AtsMapping = {
      provider: "lever",
      identifier: "acme",
      boardUrl: "https://jobs.lever.co/acme",
      apiUrl: "https://api.lever.co/v0/postings/acme?mode=json",
      verified: true,
      confidence: 100,
      discoveredFrom: "job_url",
      evidence: [{ type: "job_url", url: "https://jobs.lever.co/acme/abc", detail: "test", observedAt }],
      firstDetected: observedAt,
      lastVerified: observedAt,
      lastAttempted: observedAt,
      status: "verified",
    }
    const created = await harvestCompanies([job({ url: "https://example.com/jobs/security" })], { registryPath: path, observedAt })
    created.registry.updateAts(created.registry.listCompanies()[0].id, verified)
    await created.registry.save()
    const result = await runAtsDetector({
      registryPath: path,
      force: true,
      fetchImpl: fetchMap({ "https://api.lever.co/v0/postings/acme?mode=json": [textResponse(500, "{}"), textResponse(500, "{}")] }),
      resolveHost,
      now: new Date("2026-09-05T12:00:00.000Z"),
    })
    const company = result.registry.listCompanies()[0]
    expect(company.ats.status).toBe("verified")
    expect(company.ats.failureReason).toContain("500")
  })

  test("careers page anchor and iframe discovery works", async () => {
    const path = tmpPath("careers")
    await harvestCompanies([job({ url: "https://acme.example/jobs/security", companyDomain: "acme.example", careersUrl: "https://acme.example/careers" })], { registryPath: path, observedAt })
    const result = await runAtsDetector({
      registryPath: path,
      onlyUnknown: true,
      force: true,
      fetchImpl: fetchMap({
        "https://acme.example/careers": textResponse(200, '<a href="https://jobs.ashbyhq.com/acmesecurity">Jobs</a><iframe src="https://jobs.ashbyhq.com/acmesecurity"></iframe>'),
        "https://api.ashbyhq.com/posting-api/job-board/acmesecurity": textResponse(200, JSON.stringify({ organizationName: "Acme Security", jobs: [{ title: "AppSec" }] })),
      }),
      resolveHost,
      now: new Date(observedAt),
    })
    expect(result.registry.listCompanies()[0].ats).toMatchObject({ provider: "ashby", status: "verified" })
  })

  test("fresh verified mapping is skipped without force", async () => {
    const path = tmpPath("fresh")
    const created = await harvestCompanies([job()], { registryPath: path, observedAt })
    const company = created.registry.listCompanies()[0]
    created.registry.updateAts(company.id, {
      provider: "greenhouse",
      identifier: "acmesecurity",
      boardUrl: "https://boards.greenhouse.io/acmesecurity",
      apiUrl: "https://boards-api.greenhouse.io/v1/boards/acmesecurity/jobs?content=false",
      verified: true,
      confidence: 100,
      discoveredFrom: "job_url",
      evidence: [],
      firstDetected: observedAt,
      lastVerified: observedAt,
      lastAttempted: observedAt,
      status: "verified",
    })
    await created.registry.save()
    const result = await runAtsDetector({ registryPath: path, now: new Date("2026-09-05T12:00:00.000Z") })
    expect(result.stats.skippedFresh).toBe(1)
  })
})
