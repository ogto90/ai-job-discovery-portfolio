import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  buildEml,
  createDailyReport,
  dailyReportExclusionReason,
  generateCvs,
  renderHtml,
  renderText,
  selectTopJobs,
  trackerJobKey,
  type DailyReportOptions,
} from "../tools/daily_job_report"
import type { PipelineArtifact, PipelineJob } from "../tools/job_pipeline"

const now = new Date("2026-09-14T10:00:00.000Z")
const baseCvFixture = "tests/fixtures/base_cv.tex"
const profileOptions = {
  userId: "test-user",
  masterCvPath: baseCvFixture,
  profileLoader: async (userId: string) => ({ id: 9, user_id: userId, name: "Test Profile", definition: { target_titles: ["Application Security Engineer"] }, min_fit_score: 60, is_active: true }),
}

function job(id: string, score: number, excluded = false): PipelineJob {
  return {
    id,
    title: id === "low" ? "Security Analyst" : "Senior Application Security Engineer",
    company: id === "top" ? "ExampleCo" : "OtherCo",
    location: "Remote Europe",
    url: `https://example.com/${id}`,
    description: "Application security, secure SDLC, vulnerability management.",
    pipeline: {
      searchEligibility: { role: "target_match", location: "eligible", language: "eligible", employmentType: "eligible", seniority: "eligible", actionable: !excluded },
      eligibility: { status: excluded ? "fail" : "pass", reasons: excluded ? ["roleMismatch"] : [], notes: [], confidence: 90 },
      requirements: {
        workplace: "remote",
        remoteRegions: ["Europe"],
        countries: [],
        languages: [],
        employmentTypes: ["full_time"],
        seniority: "senior",
        careerTrack: "individual_contributor",
        roleFamilies: ["application_security"],
        authorization: [],
        evidence: [],
      },
      match: {
        matcherVersion: 1,
        overallScore: score,
        recommendation: score >= 90 ? "excellent" : score >= 75 ? "strong" : "review",
        dimensions: {} as PipelineJob["pipeline"]["match"]["dimensions"],
        strengths: ["application_security", "vulnerability_management"],
        gaps: id === "top" ? ["verify salary and exact remote scope"] : [],
        eligibilityStatus: excluded ? "fail" : "pass",
        confidence: 0.86,
        features: {
          schemaVersion: 1,
          roleFamilies: ["application_security"],
          skills: [],
          technicalDomains: ["application_security"],
          certifications: [],
          industryContexts: [],
          flags: {
            salesGtm: false,
            cloudSpecialist: false,
            endpointSpecialist: false,
            socHeavy: false,
            auditOnly: false,
            iamHeavy: false,
            linuxCryptoHeavy: false,
            federalClearance: false,
            customerFacing: false,
            governanceHeavy: false,
          },
          evidence: [],
        },
      },
      excluded,
      exclusionReasons: excluded ? ["roleMismatch"] : [],
      directATS: false,
    },
  }
}

function artifact(jobs: PipelineJob[]): PipelineArtifact {
  return {
    runId: "run",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    sources: { attempted: 2, successful: 2, failed: 0, details: [] },
    ats: { attempted: 0, successful: 0, failed: 0, details: [], providers: [], companies: [] },
    enrichment: { considered: 0, attempted: 0, success: 0, cacheHits: 0, notNeeded: 0, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} },
    counts: {
      rawJobs: jobs.length,
      normalized: jobs.length,
      afterNormalization: jobs.length,
      directATS: 0,
      aggregator: jobs.length,
      expired: 0,
      validationFailed: 0,
      uncertain: 0,
      duplicatesRemoved: 0,
      eligibilityPass: jobs.filter((item) => item.pipeline?.eligibility.status === "pass").length,
      eligibilityFail: jobs.filter((item) => item.pipeline?.eligibility.status === "fail").length,
      eligibilityUnknown: 0,
      finalCandidates: jobs.filter((item) => !item.pipeline?.excluded).length,
    },
    exclusions: { profileRoleMismatch: 0, expired: 0, validationFailed: 0, uncertain: 0, location: 0, language: 0, seniority: 0, management: 0, roleMismatch: 0, workAuthorization: 0, employmentType: 0 },
    jobs,
  }
}

describe("daily job report", () => {
  test("selectTopJobs keeps only non-excluded jobs at or above threshold", () => {
    const selected = selectTopJobs(artifact([job("top", 92), job("mid", 80), job("low", 79), job("excluded", 95, true)]), 80, 10)
    expect(selected.map((item) => item.id)).toEqual(["top", "mid"])
  })

  test("report score threshold applies uniformly regardless of title", () => {
    const roles = [job("lead", 65), job("ic", 75)]
    roles[0].title = "Security Lead"
    const selected = selectTopJobs(artifact(roles), 70, 10)
    expect(selected.map((item) => item.id)).toEqual(["ic"])
  })

  test("selection uses the shared SearchProfile actionability result and tracker feedback", () => {
    const compatible = job("compatible", 80)
    compatible.pipeline!.searchEligibility!.actionable = true
    const excluded = job("excluded", 95)
    excluded.pipeline!.searchEligibility = { role: "excluded", location: "eligible", language: "eligible", employmentType: "eligible", seniority: "eligible", actionable: false }
    const tracked = job("tracked", 90)
    tracked.company = "Tracked Co"
    expect(dailyReportExclusionReason(compatible)).toBeNull()
    const selected = selectTopJobs(artifact([compatible, excluded, tracked]), 70, 10, new Set([trackerJobKey(tracked.company, tracked.title)]))
    expect(selected.map((item) => item.id)).toEqual(["compatible"])
    expect(dailyReportExclusionReason(excluded)).toBe("SearchProfile role preference not met")
  })

  test("jobs without a SearchProfile decision fail closed in scheduled reports", () => {
    const unresolved = job("unresolved", 99)
    delete unresolved.pipeline!.searchEligibility
    expect(dailyReportExclusionReason(unresolved)).toBe("SearchProfile eligibility is unresolved")
    expect(selectTopJobs(artifact([unresolved]), 0, 10)).toEqual([])
  })

  test("report presentation does not add profession-specific priority rules", () => {
    const role = { ...job("lead", 58), title: "Security Lead" }
    for (const report of [renderHtml(artifact([role]), [role], [], now), renderText(artifact([role]), [role], now)]) {
      expect(report).not.toContain("score cutoff waived")
      expect(report).toContain("58")
    }
  })
  test("renders listing links, realistic gaps, and score reasoning", () => {
    const art = artifact([job("top", 92)])
    const selected = selectTopJobs(art, 80, 10)
    const html = renderHtml(art, selected, [], now)
    const text = renderText(art, selected, now)
    expect(html).toContain("https://example.com/top")
    expect(html).toContain("verify salary and exact remote scope")
    expect(text).toContain("Application Security")
    expect(text).toContain("92")
  })

  test("generates tailored CV tex drafts without compiling", async () => {
    const outDir = `/tmp/daily-job-report-test-${Date.now()}`
    await mkdir(outDir, { recursive: true })
    const cvs = await generateCvs([job("top", 92)], outDir, false, baseCvFixture)
    expect(cvs).toHaveLength(1)
    expect(cvs[0].compileStatus).toBe("skipped")
    const tex = await readFile(cvs[0].texPath, "utf8")
    expect(tex).toContain("ExampleCo")
    expect(tex).toContain("Senior Application Security Engineer")
  })

  test("builds an eml with attachments", async () => {
    const outDir = `/tmp/daily-job-report-eml-${Date.now()}`
    await mkdir(outDir, { recursive: true })
    const attachment = join(outDir, "cv.tex")
    await Bun.write(attachment, "hello")
    const eml = await buildEml({
      to: "to@example.com",
      from: "from@example.com",
      subject: "Daily report",
      html: "<p>Hello</p>",
      text: "Hello",
      attachments: [{ path: attachment, contentType: "application/x-tex" }],
    })
    expect(eml).toContain("To: to@example.com")
    expect(eml).toContain("Content-Disposition: attachment")
    expect(eml).toContain("cv.tex")
  })
})


describe("daily workflow reliability", () => {
  test("scheduled report resolves the requested owner profile and passes its terms to discovery", async () => {
    const outDir = `/tmp/daily-profile-${Date.now()}`
    let received: any
    const result = await createDailyReport({
      ...profileOptions,
      now,
      outDir,
      shortlistPath: `${outDir}/shortlist.json`,
      trackerPath: `${outDir}/no-tracker.csv`,
      compileCv: false,
      send: false,
      pipelineRunner: async (options) => { received = options; return { artifact: artifact([]) } },
    })
    expect(result.topJobs).toHaveLength(0)
    expect(received.searchProfile.user_id).toBe("test-user")
    expect(received.discoveryQueries).toEqual(["Application Security Engineer", "Application Cybersecurity Engineer", "Cybersecurity"])
  })

  test("failed acquisition preserves the shortlist and does not build a no-matches report", async () => {
    const outDir = `/tmp/daily-failure-${Date.now()}`
    await mkdir(outDir, { recursive: true })
    const shortlistPath = `${outDir}/shortlist.json`
    await writeFile(shortlistPath, "[]")
    const failed = artifact([])
    failed.sources.successful = 0
    failed.sources.failed = 2
    await expect(createDailyReport({ ...profileOptions, now, outDir, shortlistPath, send: false, compileCv: false, pipelineRunner: async () => ({ artifact: failed }) })).rejects.toThrow("Acquisition failed")
    expect(await readFile(shortlistPath, "utf8")).toBe("[]")
    await expect(readFile(`${outDir}/daily-job-report.html`, "utf8")).rejects.toThrow()
  })
  test("healthy report applies the configured score threshold and records decisions without sending", async () => {
    const outDir = `/tmp/daily-lead-integration-${Date.now()}`
    const lead = { ...job("new-lead", 72), title: "Security Team Lead", company: "New Lead Employer" }
    const result = await createDailyReport({ ...profileOptions, now, outDir, shortlistPath: `${outDir}/shortlist.json`, trackerPath: `${outDir}/no-tracker.csv`, threshold: 70, compileCv: false, send: false, pipelineRunner: async () => ({ artifact: artifact([lead]) }) })
    expect(result.topJobs).toHaveLength(1)
    expect(result.sent).toBe(false)
    expect(await readFile(result.htmlPath, "utf8")).not.toContain("score cutoff waived")
    const decisions = JSON.parse(await readFile(`${outDir}/selection-decisions.json`, "utf8"))
    expect(decisions.jobs[0].decision).toBe("selected")
    expect(JSON.parse(await readFile(`${outDir}/shortlist.json`, "utf8"))).toHaveLength(1)
  })
})


test("frozen daily report groups portal copies before top-N and records duplicate decisions", async () => {
  const outDir = `/tmp/daily-dedup-integration-${Date.now()}`
  const copies = ["one", "two", "three"].map((portal) => ({ ...job(portal, 82), company: "Duplicate Fixture", portal, url: `https://${portal}.example/vacancies/1` }))
  const result = await createDailyReport({ ...profileOptions, now, outDir, shortlistPath: `${outDir}/shortlist.json`, trackerPath: `${outDir}/no-tracker.csv`, threshold: 70, compileCv: false, send: false, pipelineRunner: async () => ({ artifact: artifact(copies) }) })
  expect(result.topJobs).toHaveLength(1)
  expect(result.generatedCvs).toHaveLength(1)
  expect(result.sent).toBe(false)
  const decisions = JSON.parse(await readFile(`${outDir}/selection-decisions.json`, "utf8"))
  expect(decisions.jobs.filter((row: {decision: string}) => row.decision === "selected")).toHaveLength(1)
  expect(decisions.jobs.filter((row: {decision: string}) => row.decision === "duplicate_shortlist")).toHaveLength(2)
  expect(decisions.shortlistGroups[0].sourceUrls).toHaveLength(3)
})
