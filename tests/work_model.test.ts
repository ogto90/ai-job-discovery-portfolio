import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {classifyWorkModel} from "../tools/work_model"
import {classifyLocationEligibility, normalizeDiscoveredJob} from "../tools/generic_discovery"

const cases = JSON.parse(readFileSync(new URL("./fixtures/work_model_cases.json", import.meta.url), "utf8"))
const profile = {id: 1, user_id: "test", name: "Remote only", min_fit_score: 60, is_active: true,
  definition: {remote_only: true, work_models: ["remote"], allowed_regions: ["Austria", "Europe", "worldwide"]}}

describe("work-model evidence", () => {
  for (const item of cases) {
    test(item.name, () => {
      expect(classifyWorkModel({title: item.title, location: item.location, remoteScope: item.remote_scope,
        description: item.description, structuredWorkModel: item.structured_work_model})).toBe(item.expected)
      const job = normalizeDiscoveredJob({id: item.name, source: "test", company: "Example", title: item.title ?? "Security Engineer",
        location: item.location ?? "Vienna, Austria", remoteScope: item.remote_scope,
        description: item.description ?? "", sourceUrl: `https://example.test/${encodeURIComponent(item.name)}`}, "test")!
      const decision = classifyLocationEligibility(job, profile)
      if (item.structured_work_model) return
      if (item.expected === "hybrid" || item.expected === "onsite") expect(decision).toBe("ineligible")
      if (item.expected === "unknown") expect(decision).not.toBe("eligible")
    })
  }
  test("exact ATS workplace metadata outranks incidental benefits language", () => {
    const job = normalizeDiscoveredJob({id: "ats-hybrid", source: "example-ats", sourceType: "ats",
      company: "Example", title: "Security Engineer", location: "Vienna, Austria",
      workplaceType: "Hybrid", remoteScope: "Remote",
      description: "Remote work allowance and offices worldwide.", sourceUrl: "https://example.test/ats-hybrid"}, "example-ats")!
    expect(job.remoteScope).toBe("Hybrid")
    expect(classifyLocationEligibility(job, profile)).toBe("ineligible")
  })
})
