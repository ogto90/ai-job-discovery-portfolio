import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { buildSearchQueries, classifyLocationEligibility, classifyTargetRole, normalizeDiscoveredJob, runGenericDiscovery } from "../tools/generic_discovery"
import { makeCliSourceRunner, makeCliSourceRunnerWithCommand } from "../tools/job_pipeline"
import { matchesLocation as jobgetherLocation } from "../.agents/skills/jobgether-search/cli/src/helpers"
import { matchesLocation as arbeitnowLocation } from "../.agents/skills/arbeitnow-search/cli/src/helpers"
import { matchesLocation as remoteokLocation } from "../.agents/skills/remoteok-search/cli/src/helpers"
import { matchesLocation as himalayasLocation } from "../.agents/skills/himalayas-search/cli/src/helpers"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/discovery_correctness.json", import.meta.url), "utf8"))
const run12 = JSON.parse(readFileSync(new URL("./fixtures/run12_geography.json", import.meta.url), "utf8"))
const profile = { id: 1, user_id: "test", name: "Test", definition: fixture.definition, min_fit_score: 60, is_active: true }
const weekday = new Date("2026-10-13T12:00:00.000Z")

describe("discovery correctness", () => {
  for (const [title, expected] of Object.entries(fixture.titles)) {
    test(`title: ${title}`, () => expect(classifyTargetRole(title, profile)).toBe(expected))
  }
  for (const input of fixture.geographies) {
    test(`geography: ${JSON.stringify(input)}`, () => {
      const job = normalizeDiscoveredJob({ id: "test", source: "test", title: "Security Engineer", company: "Example", url: "https://example.test/jobs/1", ...input, remoteScope: input.remote_scope }, "test")!
      expect(classifyLocationEligibility(job, profile)).toBe(input.expected)
    })
  }
  for (const input of run12) {
    test(`run 12 job ${input.job_id}: employer restriction wins`, () => {
      const job = normalizeDiscoveredJob({ source: input.source, title: input.title, company: input.company, location: input.location, remoteScope: input.remote_scope, description: input.description }, input.source)!
      expect(classifyLocationEligibility(job, profile)).toBe(input.expected)
    })
  }
  test("broad queries retain existing terms and add token-based cybersecurity variants", () => {
    expect(buildSearchQueries(profile, "broad")).toEqual(expect.arrayContaining(["Security Engineer", "Security Lead", "Application Security", "Product Security", "Cybersecurity", "Cybersecurity Engineer", "Cybersecurity Lead"]))
    expect(buildSearchQueries({ ...profile, definition: { target_titles: ["Software Engineer"] } }, "broad")).toEqual(["Software Engineer"])
  })
  const adapters = [
    ["jobgether-search", jobgetherLocation], ["arbeitnow-search", arbeitnowLocation],
    ["remoteok-search", remoteokLocation], ["himalayas-search", himalayasLocation],
  ] as const
  for (const [source, matchesLocation] of adapters) {
    test(`${source}: multi-region acquisition preserves a valid Europe result`, async () => {
      const job = { id: "eu", title: "Security Engineer", company: "Example", url: "https://example.test/jobs/eu", location: "Europe / Austria", locationRestrictions: ["Austria"], description: "Remote security engineering role", tags: [] }
      const runner = makeCliSourceRunnerWithCommand(source, (query) => ["search", "--query", query, "--format", "json"])
      const result = await runner({
        discoveryQueries: ["Security Engineer"], discoveryLocations: fixture.definition.allowed_regions,
        now: weekday,
        commandRunner: async (_command, args) => {
          expect(args).not.toContain("--location")
          const index = args.indexOf("--location")
          const location = index >= 0 ? args[index + 1] : undefined
          const accepted = matchesLocation(job as never, location)
          expect(accepted).toBe(true)
          return { code: 0, stdout: JSON.stringify({ results: accepted ? [job] : [] }), stderr: "", timedOut: false }
        },
      })
      expect(result.jobs).toHaveLength(1)
    })
  }
  test("a single expressible region is still passed to the source", async () => {
    const runner = makeCliSourceRunnerWithCommand("jobgether-search", () => ["search"])
    await runner({ discoveryQueries: ["Security Engineer"], discoveryLocations: ["Europe"], now: weekday, commandRunner: async (_command, args) => {
      expect(args[args.indexOf("--location") + 1]).toBe("Europe")
      return { code: 0, stdout: '{"results":[]}', stderr: "", timedOut: false }
    } })
  })
  test("multi-region configuration removes a builder's existing literal location filter", async () => {
    const runner = makeCliSourceRunnerWithCommand("jobgether-search", () => ["search", "--location", "remote"])
    await runner({ discoveryQueries: ["Security Engineer"], discoveryLocations: fixture.definition.allowed_regions, now: weekday, commandRunner: async (_command, args) => {
      expect(args).toEqual(["search"])
      return { code: 0, stdout: '{"results":[]}', stderr: "", timedOut: false }
    } })
  })
  test("LinkedIn uses one required broad location and still reaches central eligibility", async () => {
    const runner = makeCliSourceRunnerWithCommand("linkedin-search", (query) => ["search", "--query", query, "--format", "json"])
    let calls = 0
    const sourceRunner = (options: Parameters<typeof runner>[0]) => runner({ ...options, commandRunner: async (_command, args) => {
      calls++
      expect(args.filter((item) => item === "--location")).toHaveLength(1)
      expect(args[args.indexOf("--location") + 1]).toBe("Europe")
      expect(args).not.toContain("Austria,EU,EEA,EMEA,Europe,worldwide")
      return { code: 0, stdout: JSON.stringify({ results: [
        { id: "eu", source: "linkedin-search", title: "Security Engineer", company: "Europe Co", location: "Remote Europe", url: "https://example.test/eu", description: "English is required. " + "Build security programs and collaborate with engineering teams. ".repeat(15) },
        { id: "us", source: "linkedin-search", title: "Security Engineer", company: "US Co", location: "Remote United States", url: "https://example.test/us", description: "English is required. " + "Build security programs and collaborate with engineering teams. ".repeat(15) },
      ] }), stderr: "", timedOut: false }
    } })
    const result = await runGenericDiscovery({
      mode: "targeted", profile, sourceNames: ["linkedin-search"], sourceRunners: [sourceRunner],
      now: weekday,
      validator: async (jobs) => ({ all: jobs.map((job) => ({ ...job, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-07T00:00:00Z" } })), results: jobs }),
    })
    expect(calls).toBe(buildSearchQueries(profile, "targeted").length)
    expect(result.sourceDetails[0].status).toBe("success")
    expect(result.stats.target_matches).toBe(2)
    expect(result.jobs.some((job) => job.company === "Europe Co" && classifyLocationEligibility(job, profile) === "eligible")).toBe(true)
    expect(result.jobs.some((job) => job.company === "US Co" && classifyLocationEligibility(job, profile) === "ineligible")).toBe(true)
  })
  test("InfoSec 429 preserves earlier candidates and is not zero results or a fatal discovery error", async () => {
    const runner = makeCliSourceRunnerWithCommand("infosecjobs-search", (query) => ["search", "--query", query, "--format", "json"])
    let attempts = 0
    const result = await runner({ discoveryQueries: ["Security Engineer", "Security Lead", "AppSec"], commandRunner: async () => {
      attempts++
      return attempts === 1
        ? { code: 0, stdout: JSON.stringify({ results: [{ id: "one", source: "infosecjobs-search", title: "Security Engineer", company: "Example", location: "Remote Europe", url: "https://example.test/one" }] }), stderr: "", timedOut: false }
        : { code: 1, stdout: "", stderr: "Unable to fetch jobs: 429 Too Many Requests", timedOut: false }
    } })
    expect(attempts).toBe(2)
    expect(result.detail.status).toBe("rate_limited")
    expect(result.detail.errorCategory).toBe("rate_limited")
    expect(result.jobs).toHaveLength(1)
  })
  test("an Austria-only profile accepts broad European remote scope, not Germany-only", () => {
    const p = { ...profile, definition: { remote_only: true, allowed_countries: ["Austria"] } }
    for (const [location, expected] of [["Remote Europe", "eligible"], ["Remote Austria", "eligible"], ["Remote Germany", "ineligible"]]) {
      const job = normalizeDiscoveredJob({ source: "test", title: "Security Engineer", company: "Example", location }, "test")!
      expect(classifyLocationEligibility(job, p)).toBe(expected)
    }
  })
  test("worldwide-only preferences do not establish country-restricted employment eligibility", () => {
    const p = { ...profile, definition: { remote_only: true, allowed_regions: ["worldwide"] } }
    const job = normalizeDiscoveredJob({ source: "test", title: "Security Engineer", company: "Example", location: "Remote worldwide", description: "Remote in Poland only." }, "test")!
    expect(classifyLocationEligibility(job, p)).toBe("unclear")
  })
  test("remote-only InfoSec invocation uses only supported flags", async () => {
    const supported = new Set(["--query", "--location", "--jobage", "--page", "--limit", "--format"])
    const runner = makeCliSourceRunnerWithCommand("infosecjobs-search", (query) => ["search", "--query", query, "--jobage", "14", "--format", "json"])
    const result = await runner({ discoveryQueries: ["Security Engineer"], discoveryWorkModels: ["remote"], discoveryLocations: fixture.definition.allowed_regions, commandRunner: async (_command, args) => {
      expect(args).not.toContain("--remote")
      expect(args.filter((arg) => arg.startsWith("--")).every((flag) => supported.has(flag))).toBe(true)
      return { code: 0, stdout: '{"results":[]}', stderr: "", timedOut: false }
    } })
    expect(result.detail.success).toBe(true)
  })
  test("production InfoSec command executes successfully with mocked HTTP", async () => {
    const runner = makeCliSourceRunner("infosecjobs-search")
    const result = await runner({
      discoveryQueries: ["Security Engineer"], discoveryWorkModels: ["remote"], discoveryLocations: fixture.definition.allowed_regions,
      commandRunner: async (_command, args) => {
        const script = `globalThis.fetch = async () => ({ok:true,status:200,text:async()=>"<html></html>"});
          process.argv = [process.execPath, ${JSON.stringify(args[1])}, ...${JSON.stringify(args.slice(2))}];
          await import(${JSON.stringify(new URL(`../${args[1]}`, import.meta.url).href)});`
        const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
        const stdout = await new Response(child.stdout).text()
        const stderr = await new Response(child.stderr).text()
        const code = await child.exited
        expect(stderr).not.toContain("UNKNOWN_FLAG")
        expect(code).toBe(0)
        return { code, stdout, stderr, timedOut: false }
      },
    })
    expect(result.detail.success).toBe(true)
  })
})
