import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { dedupeShortlist } from "../tools/shortlist_dedup"
import { isSecurityLeadershipTitle } from "../tools/security_roles"
import { extractJobRequirements, evaluateCandidateEligibility, loadCandidateProfile } from "../tools/eligibility_engine"
import { matchCandidateToJob } from "../tools/matching_engine"
import { selectTopJobs, dailyReportExclusionReason, trackerJobKey } from "../tools/daily_job_report"

const candidate = (await loadCandidateProfile("tests/fixtures/synthetic_candidate_profile.json"))!
function evaluated(extra: Record<string, unknown> = {}) {
  const job = { title: "Security Lead", company: "Example", location: "Remote Europe", description: "Own security engineering, application security and vulnerability management.", url: "https://example.com/jobs/1", ...extra }
  const requirements = extractJobRequirements(job)
  const eligibility = evaluateCandidateEligibility(candidate, requirements)
  const hasReason = (reason: string) => eligibility.reasons.includes(reason as never)
  const location = hasReason("location") ? "ineligible" : eligibility.status === "unknown" ? "unclear" : "eligible"
  const role = hasReason("roleMismatch") ? "unrelated" : "target_match"
  const language = hasReason("language") ? "ineligible" : "eligible"
  const employmentType = hasReason("employmentType") ? "ineligible" : "eligible"
  const seniority = hasReason("seniority") || hasReason("management") ? "ineligible" : "eligible"
  return { ...job, pipeline: {
    requirements,
    eligibility,
    searchEligibility: { role, location, language, employmentType, seniority, actionable: eligibility.status === "pass" },
    excluded: eligibility.status === "fail",
    match: matchCandidateToJob(candidate, job, eligibility, requirements),
  } } as any
}

describe("shortlist vacancy identity", () => {
  test("three Canonical portal copies occupy one slot and retain their URLs", () => {
    const jobs = ["one", "two", "three"].map((portal) => evaluated({ company: "Canonical", title: "Engineering Manager - Ubuntu Security", portal, url: `https://${portal}.example/jobs/1` }))
    const result = selectTopJobs({ jobs } as any, 70, 10)
    expect(result).toHaveLength(1)
    expect(result[0].metadata.sourceUrls).toHaveLength(3)
    expect(jobs[0].metadata).toBeUndefined()
  })
  test("distinct known requisitions and same-source postings are preserved", () => {
    const jobs = ["1", "2"].map((id) => evaluated({ portal: id, applicationUrl: `https://jobs.lever.co/example/${id}` }))
    expect(dedupeShortlist(jobs)).toHaveLength(2)
    expect(dedupeShortlist([evaluated({ portal: "one" }), evaluated({ portal: "one", url: "https://example.com/jobs/2" })])).toHaveLength(2)
  })
  test("generic careers URLs are not vacancy identity", () => {
    expect(dedupeShortlist([evaluated({ applicationUrl: "https://example.com/careers" }), evaluated({ title: "Product Security Engineer", url: "https://other.example/jobs/2", applicationUrl: "https://example.com/careers" })])).toHaveLength(2)
  })
  test("shared application URL merges across portal IDs", () => {
    const jobs = ["one", "two"].map((portal) => evaluated({ portal, url: `https://${portal}.example/1`, applicationUrl: "https://jobs.lever.co/example/123" }))
    expect(dedupeShortlist(jobs)).toHaveLength(1)
  })
  test("different company, title or title jurisdiction never collapse by title alone", () => {
    expect(dedupeShortlist([evaluated(), evaluated({ company: "Other", url: "https://other.example/2" }), evaluated({ title: "Security Lead (Brazil)", url: "https://other.example/3" })])).toHaveLength(3)
  })
  test("tracker exclusions apply to copies and cannot consume the top-N budget", () => {
    const ignored = ["one", "two"].map((portal) => evaluated({ portal, url: `https://${portal}.example/1` }))
    const result = selectTopJobs({ jobs: [...ignored, evaluated({ company: "New employer" })] } as any, 70, 1, new Set([trackerJobKey("Example", "Security Lead")]))
    expect(result[0].company).toBe("New employer")
  })
})

describe("explicit geography takes precedence", () => {
  for (const country of ["Brazil", "UK or Ireland", "United States", "India"]) {
    test(`${country} in title cannot be waived by Europe label`, () => {
      const job = evaluated({ title: `Head of Systems & Security (${country})` })
      expect(job.pipeline.eligibility.status).toBe("fail")
      expect(selectTopJobs({ jobs: [job] } as any)).toHaveLength(0)
    })
  }
  test("title restriction narrows an aggregator's expanded country list", () => {
    const job = evaluated({ title: "Head of Systems & Security (Brazil)", location: "AT, DE, GB, BR", locationRestrictions: ["AT, DE, GB, BR"] })
    expect(job.pipeline.requirements.geography.allowedCountries).toEqual(["BR"])
    expect(selectTopJobs({ jobs: [job] } as any)).toHaveLength(0)
  })
  test("structured restrictions conflicting with worldwide copy require review", () => {
    const job = evaluated({ locationRestrictions: ["United Kingdom"], description: "Work from anywhere! Own our security program." })
    expect(job.pipeline.eligibility.status).toBe("unknown")
    expect(job.pipeline.requirements.geography.conflictingScope).toBe(true)
    expect(dailyReportExclusionReason(job)).not.toBeNull()
  })
  test("country-only location cannot be overwritten by remote Europe prose", () => {
    const job = evaluated({ location: "Brazil", description: "Fully remote anywhere in Europe." })
    expect(job.pipeline.eligibility.status).toBe("unknown")
    expect(dailyReportExclusionReason(job)).not.toBeNull()
  })
  test("genuinely unrestricted worldwide and Austria-inclusive roles still pass", () => {
    for (const extra of [{ location: "Remote Worldwide" }, { locationRestrictions: ["Austria", "Germany"] }]) expect(evaluated(extra).pipeline.eligibility.status).toBe("pass")
    expect(evaluated({ location: "Worldwide" }).pipeline.eligibility.status).toBe("unknown")
  })
})

describe("security team leadership is not product management", () => {
  for (const title of ["Product Manager - Security", "Product Manager - Security & Trust (EMEA/AMER)", "Security Product Manager", "Security Project Manager", "Security Account Manager"]) {
    test(title, () => {
      expect(isSecurityLeadershipTitle(title)).toBe(false)
      const job = evaluated({ title })
      job.pipeline.match.overallScore = 35
      expect(selectTopJobs({ jobs: [job] } as any, 70)).toHaveLength(0)
    })
  }
  for (const title of ["Security Lead", "Security Engineering Manager", "Head of Security", "Security Tech Lead", "Product Security Team Lead"]) test(title, () => expect(isSecurityLeadershipTitle(title)).toBe(true))
})

describe("required specialist depth", () => {
  const base = "Application security and vulnerability management. "
  const offensive = "Expert-level web application and API security experience is required.\nPractical experience finding complex vulnerabilities in white/grey-box appsec assessments."
  const cloud = "You've secured a modern AWS or GCP environment.\nYou've owned identity, MDM and joiner and leaver automation at a remote company."
  for (const [name, description] of [["offensive AppSec", offensive], ["cloud and IT ownership", cloud]]) {
    test(`${name} is not inferred from general AppSec experience`, () => {
      const baseline = evaluated({ description: base }).pipeline.match
      const match = evaluated({ description: base + description }).pipeline.match
      expect(match.gaps.some((gap: string) => gap.startsWith("Required depth not evidenced"))).toBe(true)
      expect(match.overallScore).toBeLessThan(baseline.overallScore)
      expect(match.features.requiredExpertise).toHaveLength(2)
    })
  }
  test("explicit matching expertise removes the unsupported-depth penalty", () => {
    const job = evaluated({ description: base + offensive })
    const supported = { ...candidate, skills: [...candidate.skills!, { skill: "offensive security", level: "strong" }, { skill: "manual code audit", level: "strong" }] }
    const match = matchCandidateToJob(supported, job, job.pipeline.eligibility, job.pipeline.requirements)
    expect(match.overallScore).toBeGreaterThan(job.pipeline.match.overallScore)
    expect(match.gaps.some((gap) => gap.startsWith("Required depth not evidenced"))).toBe(false)
  })
  test("nice-to-have specialist expertise is not treated as required", () => {
    expect(evaluated({ description: base + "\nNice to have:\n" + offensive }).pipeline.match.features.requiredExpertise).toHaveLength(0)
  })
})

test("Jobicy CLI flushes a large JSON response through a pipe without network access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jobicy-stdout-"))
  try {
    const fixture = join(dir, "run.ts")
    await writeFile(fixture, `globalThis.fetch = async () => new Response(JSON.stringify({ jobs: [{ id: 1, jobTitle: "Security Lead", companyName: "Fixture", url: "https://jobicy.com/jobs/1", jobDescription: "security ".repeat(300000), jobGeo: "Europe" }] }));\nprocess.argv = [process.execPath, "cli.ts", "search", "--format", "json"];\nawait import(${JSON.stringify(resolve(".agents/skills/jobicy-search/cli/src/cli.ts"))});`)
    const child = Bun.spawn([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(output.length).toBeGreaterThan(2000000)
    expect(JSON.parse(output).results).toHaveLength(1)
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 15000)
