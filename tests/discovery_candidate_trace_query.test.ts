import { describe, expect, test } from "bun:test"
import { buildTraceQueryUrl } from "../scripts/query_discovery_candidate_traces"

describe("candidate trace diagnostic query", () => {
  test("supports run, source, company, reason, outcome, and ATS-board filters", () => {
    const url = buildTraceQueryUrl("https://project.supabase.test", {
      "run-id": "47",
      source: "greenhouse",
      "query-reference": "a".repeat(64),
      company: "Example Inc",
      "reason-code": "LOCATION_INCOMPATIBLE",
      "final-outcome": "updated",
      "ats-provider": "greenhouse",
      "ats-board": "board-1",
    }, 25)
    expect(url.searchParams.get("search_run_id")).toBe("eq.47")
    expect(url.searchParams.get("source")).toBe("eq.greenhouse")
    expect(url.searchParams.get("source_query_reference")).toBe(`eq.${"a".repeat(64)}`)
    expect(url.searchParams.get("original_company")).toBe("eq.Example Inc")
    expect(url.searchParams.get("reason_codes")).toBe("cs.{LOCATION_INCOMPATIBLE}")
    expect(url.searchParams.get("final_outcome")).toBe("eq.updated")
    expect(url.searchParams.get("ats_provider")).toBe("eq.greenhouse")
    expect(url.searchParams.get("ats_board_id")).toBe("eq.board-1")
    expect(url.searchParams.get("limit")).toBe("25")
  })

  test("URL lookup checks canonical or source URL after removing sensitive query values", () => {
    const url = buildTraceQueryUrl("https://project.supabase.test", {
      url: "https://jobs.example.test/posting?token=secret#apply",
    }, 10)
    expect(url.searchParams.get("or")).toContain("https://jobs.example.test/posting")
    expect(url.searchParams.get("or")).not.toContain("secret")
  })

  test("company search text is constrained to safe exact-match characters", () => {
    const url = buildTraceQueryUrl("https://project.supabase.test", { company: "ACME, token=secret" }, 10)
    expect(url.searchParams.get("original_company")).toBe("eq.ACME token secret")
    expect(url.searchParams.get("original_company")).not.toContain("*")
  })
})
