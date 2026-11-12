import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import {
  JsonCompanyRegistry,
  classifySecurityCategory,
  emptyRegistry,
  harvestCompanies,
  isSecurityRelevant,
  normalizeCompanyName,
  normalizeDomain,
  observationFromJob,
  type NormalizedJob,
} from "../tools/company_registry"

const observedAt = "2026-09-04T12:00:00.000Z"

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: "job-1",
    title: "Senior Application Security Engineer",
    company: "Cloudflare, Inc.",
    url: "https://example.com/careers/senior-application-security-engineer-1",
    location: "Remote Europe",
    portal: "himalayas-search",
    source: "cli",
    ...overrides,
  }
}

function tmpPath(name: string): string {
  return `/tmp/company-registry-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}.json`
}

describe("normalization", () => {
  test("normalizes company names conservatively", () => {
    expect(normalizeCompanyName("Cloudflare")).toBe("cloudflare")
    expect(normalizeCompanyName("CLOUDFLARE")).toBe("cloudflare")
    expect(normalizeCompanyName("Cloudflare, Inc.")).toBe("cloudflare")
    expect(normalizeCompanyName("Stripe Partners")).not.toBe(normalizeCompanyName("Stripe"))
  })

  test("normalizes domains and avoids ATS domains", () => {
    expect(normalizeDomain("https://www.example.com/path?q=1")).toBe("example.com")
    expect(normalizeDomain("https://careers.example.com/jobs")).toBe("example.com")
    expect(normalizeDomain("https://jobs.example.com/openings")).toBe("example.com")
    expect(normalizeDomain("https://jobs.ashbyhq.com/acme/abc")).toBeNull()
    expect(normalizeDomain("https://jobs.lever.co/acme/abc")).toBeNull()
    expect(normalizeDomain("https://www.linkedin.com/jobs/view/123")).toBeNull()
    expect(normalizeDomain("https://uk.linkedin.com/jobs/view/123")).toBeNull()
    expect(normalizeDomain("https://himalayas.app/companies/acme/jobs/security")).toBeNull()
    expect(normalizeDomain("https://remotive.com/remote-jobs/security")).toBeNull()
    expect(normalizeDomain("https://jobnet.dk/find-job/123")).toBeNull()
    expect(normalizeDomain("https://freehire.me/job/123")).toBeNull()
    expect(normalizeDomain("https://djinni.co/jobs/123-security")).toBeNull()
    expect(normalizeDomain("https://dou.ua/jobs/123-security")).toBeNull()
  })
})

describe("security relevance", () => {
  test("classifies common security titles", () => {
    expect(classifySecurityCategory(job({ title: "Senior Application Security Engineer" }))).toBe("application_security")
    expect(classifySecurityCategory(job({ title: "SOC Detection Engineer" }))).toBe("soc_detection")
    expect(classifySecurityCategory(job({ title: "Security Manager" }))).toBe("security_management")
    expect(classifySecurityCategory(job({ title: "GRC Lead" }))).toBe("grc")
  })

  test("does not harvest generic jobs merely mentioning security in description", () => {
    expect(isSecurityRelevant(job({ title: "Software Engineer", description: "You care about security." }))).toBe(false)
    expect(isSecurityRelevant(job({ title: "Finance Manager" }))).toBe(false)
  })
})

describe("creation and update", () => {
  test("creates a new company from a normalized security job", async () => {
    const path = tmpPath("create")
    const { stats, registry } = await harvestCompanies([job()], { registryPath: path, observedAt })
    const companies = registry.listCompanies()
    expect(stats).toMatchObject({ jobsProcessed: 1, securityJobs: 1, companiesCreated: 1 })
    expect(companies).toHaveLength(1)
    expect(companies[0].canonicalName).toBe("Cloudflare, Inc.")
    expect(companies[0].firstSeen).toBe(observedAt)
    expect(companies[0].lastSeen).toBe(observedAt)
    expect(companies[0].sources["himalayas-search"].jobsSeen).toBe(1)
    expect(companies[0].securityHiring.jobsSeen).toBe(1)
  })

  test("second unique job updates counters while preserving firstSeen", async () => {
    const path = tmpPath("update")
    await harvestCompanies([job()], { registryPath: path, observedAt })
    const later = "2026-09-05T12:00:00.000Z"
    const { stats, registry } = await harvestCompanies([job({ id: "job-2", title: "Security Manager", location: "Austria", url: "https://example.com/careers/security-manager-2" })], { registryPath: path, observedAt: later })
    const company = registry.listCompanies()[0]
    expect(stats).toMatchObject({ companiesUpdated: 1 })
    expect(company.firstSeen).toBe(observedAt)
    expect(company.lastSeen).toBe(later)
    expect(company.securityHiring.jobsSeen).toBe(2)
    expect(company.securityHiring.titles["Security Manager"]).toBe(1)
    expect(company.securityHiring.categories.security_management).toBe(1)
    expect(company.securityHiring.locations.Austria).toBe(1)
  })

  test("same job does not increment unique jobs but updates observation lastSeen", async () => {
    const path = tmpPath("dupe")
    await harvestCompanies([job()], { registryPath: path, observedAt })
    const later = "2026-09-06T12:00:00.000Z"
    const { stats, registry } = await harvestCompanies([job()], { registryPath: path, observedAt: later })
    const company = registry.listCompanies()[0]
    const observation = Object.values(registry.snapshot().observations)[0]
    expect(stats.jobsAlreadyKnown).toBe(1)
    expect(company.securityHiring.jobsSeen).toBe(1)
    expect(observation.lastSeen).toBe(later)
  })

  test("same job from a second source preserves source provenance without inflating unique total when job id matches", async () => {
    const path = tmpPath("source")
    await harvestCompanies([job({ id: "source-a-id", portal: "remotive-search", url: "https://company.example/jobs/security-lead-123" })], { registryPath: path, observedAt })
    await harvestCompanies([job({ id: "source-b-id", portal: "jobgether-search", url: "https://company.example/jobs/security-lead-123" })], { registryPath: path, observedAt: "2026-09-07T12:00:00.000Z" })
    const company = (await JsonCompanyRegistry.load(path)).listCompanies()[0]
    expect(company.securityHiring.jobsSeen).toBe(1)
    expect(company.sources["remotive-search"].jobsSeen).toBe(1)
    expect(company.sources["jobgether-search"].jobsSeen).toBe(1)
  })
})

describe("identity resolution", () => {
  test("name variants resolve when evidence supports it", async () => {
    const path = tmpPath("names")
    await harvestCompanies([job({ company: "Cloudflare", id: "1" }), job({ company: "CLOUDFLARE", id: "2" }), job({ company: "Cloudflare, Inc.", id: "3" })], { registryPath: path, observedAt })
    const companies = (await JsonCompanyRegistry.load(path)).listCompanies()
    expect(companies).toHaveLength(1)
    expect(companies[0].aliases.length).toBe(3)
  })

  test("similar distinct names do not merge", async () => {
    const path = tmpPath("false-merge")
    await harvestCompanies([
      job({ company: "Stripe", id: "1", url: "https://stripe.com/jobs/security-engineer-1" }),
      job({ company: "Stripe Consulting", id: "2", url: "https://stripe-consulting.example/jobs/security-engineer-2" }),
    ], { registryPath: path, observedAt })
    expect((await JsonCompanyRegistry.load(path)).listCompanies()).toHaveLength(2)
  })

  test("conflicting domains prevent unsafe name merge", async () => {
    const path = tmpPath("domains")
    await harvestCompanies([job({ company: "Acme", id: "1", companyDomain: "acme.com" })], { registryPath: path, observedAt })
    await harvestCompanies([job({ company: "Acme", id: "2", companyDomain: "acme-partners.com" })], { registryPath: path, observedAt })
    expect((await JsonCompanyRegistry.load(path)).listCompanies()).toHaveLength(2)
  })

  test("domain is strongest identity signal", async () => {
    const path = tmpPath("domain-merge")
    await harvestCompanies([job({ company: "Cloudflare, Inc.", id: "1", companyDomain: "https://www.cloudflare.com" })], { registryPath: path, observedAt })
    await harvestCompanies([job({ company: "CLOUDFLARE", id: "2", companyDomain: "cloudflare.com" })], { registryPath: path, observedAt })
    expect((await JsonCompanyRegistry.load(path)).listCompanies()).toHaveLength(1)
  })
})

describe("ATS candidates", () => {
  test("direct ATS URLs create unverified candidate mappings", async () => {
    for (const [url, provider] of [
      ["https://boards.greenhouse.io/acme/jobs/123", "greenhouse"],
      ["https://jobs.lever.co/acme/abc-123", "lever"],
      ["https://jobs.ashbyhq.com/acme/abc-123", "ashby"],
      ["https://careers.smartrecruiters.com/Acme/743999999999999-security-lead", "smartrecruiters"],
    ] as const) {
      const path = tmpPath(provider)
      const { registry } = await harvestCompanies([job({ url, company: `${provider} Co`, id: provider })], { registryPath: path, observedAt })
      const company = registry.listCompanies()[0]
      expect(company.ats).toMatchObject({ provider, status: "candidate", verified: false, confidence: 70 })
    }
  })
})

describe("persistence and CLI-facing behavior", () => {
  test("save and reload preserves logical data", async () => {
    const path = tmpPath("persist")
    const first = await harvestCompanies([job()], { registryPath: path, observedAt })
    const reloaded = await JsonCompanyRegistry.load(path)
    expect(reloaded.snapshot()).toEqual(first.registry.snapshot())
  })

  test("corrupt registry fails safely", async () => {
    const path = tmpPath("corrupt")
    await mkdir("/tmp", { recursive: true })
    await writeFile(path, "{bad", "utf8")
    await expect(JsonCompanyRegistry.load(path)).rejects.toThrow("Unable to read company registry")
  })

  test("stats command data is computed", async () => {
    const path = tmpPath("stats")
    const { registry } = await harvestCompanies([job(), job({ id: "job-2", title: "Security Manager", url: "https://example.com/careers/security-manager-2" })], { registryPath: path, observedAt })
    expect(registry.stats()).toMatchObject({ companies: 1, securityJobsObserved: 2, companiesWithDomains: 1 })
  })

  test("observation conversion requires company evidence but is profession-neutral", () => {
    expect(observationFromJob(job({ company: null }), observedAt)).toBeNull()
    expect(observationFromJob(job({ title: "Software Engineer" }), observedAt)?.securityCategory).toBeNull()
    expect(observationFromJob(job({ title: "Product Manager" }), observedAt)?.securityCategory).toBeNull()
    expect(observationFromJob(job({ title: "Security Engineer" }), observedAt)?.securityCategory).toBe("security_engineering")
  })

  test("non-security employer jobs seed the generic registry without security stats", async () => {
    const path = tmpPath("backend-seed")
    const { stats, registry } = await harvestCompanies([job({ title: "Backend Engineer" })], { registryPath: path, observedAt })
    expect(stats).toMatchObject({ jobsProcessed: 1, jobsRegistered: 1, securityJobs: 0, companiesCreated: 1 })
    expect(registry.stats()).toMatchObject({ companies: 1, jobsObserved: 1, securityJobsObserved: 0 })
    expect(registry.listCompanies()[0].securityHiring.jobsSeen).toBe(0)
    expect(registry.listCompanies()[0].jobsObserved).toBe(1)
  })

  test("aggregator company strings without employer or ATS evidence do not seed registry", async () => {
    const path = tmpPath("insufficient-evidence")
    const listing = job({
      title: "Product Manager",
      url: "https://himalayas.app/jobs/123",
      applicationUrl: undefined,
      companyDomain: undefined,
      companyWebsiteUrl: undefined,
      careersUrl: undefined,
    })
    const { stats, registry } = await harvestCompanies([listing], { registryPath: path, observedAt })
    expect(stats.skippedInsufficientEvidence).toBe(1)
    expect(registry.listCompanies()).toHaveLength(0)
  })

  test("an untrusted aggregator posting host is not treated as an employer domain", () => {
    expect(observationFromJob(job({
      title: "Product Manager",
      sourceType: "aggregator",
      url: "https://jobs.example-aggregator.test/listing/123",
      companyDomain: undefined,
      companyWebsiteUrl: undefined,
      careersUrl: undefined,
      applicationUrl: undefined,
    }), observedAt)).toBeNull()
  })

  test("a profession-neutral direct ATS URL seeds an unverified candidate mapping", async () => {
    const path = tmpPath("ats-backend-seed")
    const { stats, registry } = await harvestCompanies([job({
      title: "Backend Engineer",
      url: "https://himalayas.app/jobs/123",
      applicationUrl: "https://jobs.ashbyhq.com/acme/1234abcd-5678-1234-9876-abcdef012345",
    })], { registryPath: path, observedAt })
    expect(stats.jobsRegistered).toBe(1)
    expect(stats.atsCandidatesDetected).toBe(1)
    expect(registry.listCompanies()[0].ats).toMatchObject({ provider: "ashby", status: "candidate", verified: false })
  })

  test("expired validated jobs are not harvested", async () => {
    const path = tmpPath("expired")
    const { stats, registry } = await harvestCompanies([job({ validation: { status: "expired", method: "http_status", confidence: 95, checkedAt: observedAt } })], { registryPath: path, observedAt })
    expect(stats.skippedExpired).toBe(1)
    expect(registry.listCompanies()).toHaveLength(0)
  })
})
