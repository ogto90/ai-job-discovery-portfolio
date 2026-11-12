import { describe, expect, test } from "bun:test"
import {
  appendTraceEvent,
  candidateTracingEnabled,
  capCandidateTraces,
  createCandidateTrace,
  sanitizeTraceUrl,
  sanitizeTraceReason,
  traceCandidateLimit,
  traceCleanupBatchSize,
  traceRetentionDays,
  traceSummary,
} from "../tools/discovery_candidate_tracing"
import type { NormalizedJob } from "../tools/company_registry"

function candidate(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    source: "portal-a",
    sourceType: "aggregator",
    sourceJobId: "posting-123",
    title: "Security Engineer",
    company: "Example Inc",
    url: "https://jobs.example.test/role?token=do-not-store#apply",
    metadata: { acquisitionQueries: ["security engineer europe"] },
    ...overrides,
  }
}

describe("candidate trace primitives", () => {
  test("identity is stable for the same source observation", () => {
    expect(createCandidateTrace(candidate(), "portal-a", 47).candidate_identity)
      .toBe(createCandidateTrace(candidate(), "portal-a", 47).candidate_identity)
  })

  test("the same posting returned by separate providers remains separate", () => {
    const left = createCandidateTrace(candidate({ source: "portal-a" }), "portal-a", 47)
    const right = createCandidateTrace(candidate({ source: "portal-b" }), "portal-b", 47)
    expect(left.candidate_identity).not.toBe(right.candidate_identity)
  })

  test("ATS requisition identity includes board identity", () => {
    const base: NormalizedJob = { source: "greenhouse", sourceType: "ats", id: "req-1", title: "Engineer", company: "Co", ats: { provider: "greenhouse", companyIdentifier: "board-a", requisitionId: "req-1" } }
    const other = { ...base, ats: { provider: "greenhouse", companyIdentifier: "board-b", requisitionId: "req-1" } }
    expect(createCandidateTrace(base, "ats:greenhouse:board-a", 1).candidate_identity)
      .not.toBe(createCandidateTrace(other, "ats:greenhouse:board-b", 1).candidate_identity)
  })

  test("different ATS requisition IDs remain distinct within one board", () => {
    const first = candidate({ sourceType: "ats", ats: { provider: "ashby", companyIdentifier: "board", requisitionId: "req-a" } })
    const second = { ...first, ats: { provider: "ashby", companyIdentifier: "board", requisitionId: "req-b" } }
    expect(createCandidateTrace(first, "ats", 1).candidate_identity).not.toBe(createCandidateTrace(second, "ats", 1).candidate_identity)
  })

  test("source ID is not fabricated from an ATS display id", () => {
    const row = candidate({ sourceType: "ats", id: "display-only", ats: { provider: "ashby", companyIdentifier: "board" } })
    expect(createCandidateTrace(row, "ats", 1).source_job_id).toBeNull()
  })

  test("ATS board identity stays distinct when requisition IDs are absent", () => {
    const first = candidate({ source: "greenhouse", sourceType: "ats", sourceJobId: undefined, url: "https://jobs.example.test/posting", ats: { provider: "greenhouse", companyIdentifier: "board-a" } })
    const second = { ...first, ats: { provider: "greenhouse", companyIdentifier: "board-b" } }
    expect(createCandidateTrace(first, "ats:greenhouse", 47).candidate_identity)
      .not.toBe(createCandidateTrace(second, "ats:greenhouse", 47).candidate_identity)
  })

  test("URLs remove credentials, query parameters and fragments", () => {
    expect(sanitizeTraceUrl("https://user:password@jobs.example.test/role?token=secret#top"))
      .toBe("https://jobs.example.test/role")
  })

  test("invalid and non-HTTP URLs are not persisted", () => {
    expect(sanitizeTraceUrl("javascript:alert(1)")).toBeNull()
    expect(sanitizeTraceUrl("not a url")).toBeNull()
  })

  test("validation reasons have embedded credentials and URL query secrets redacted", () => {
    expect(sanitizeTraceReason("HTTP 403 https://jobs.example.test/role?token=secret with api_key=abc123"))
      .toBe("HTTP 403 https://jobs.example.test/role with api_key=[redacted]")
  })

  test("fallback identity is deterministic when source ID and URL are absent", () => {
    const row = candidate({ sourceJobId: undefined, url: undefined, title: "Analyst", company: "Company" })
    expect(createCandidateTrace(row, "portal-a", 5).candidate_identity)
      .toBe(createCandidateTrace(row, "portal-a", 5).candidate_identity)
  })

  test("fallback identity changes when source observation facts change", () => {
    const first = candidate({ sourceJobId: undefined, url: undefined, title: "Analyst", company: "Company" })
    const second = { ...first, title: "Engineer" }
    expect(createCandidateTrace(first, "portal-a", 5).candidate_identity)
      .not.toBe(createCandidateTrace(second, "portal-a", 5).candidate_identity)
  })

  test("query references are hashed rather than stored verbatim", () => {
    const row = createCandidateTrace(candidate(), "portal-a", 2)
    expect(row.source_query_reference).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(row)).not.toContain("security engineer europe")
  })

  test("full job descriptions are never copied into trace metadata", () => {
    const row = createCandidateTrace(candidate({ description: "Private full job description contents" }), "portal-a", 2)
    expect(JSON.stringify(row)).not.toContain("Private full job description contents")
  })

  test("authorization and cookie-like values are not included from raw payload metadata", () => {
    const row = createCandidateTrace(candidate({ metadata: { token: "secret", cookie: "private", accessToken: "secret" } }), "portal-a", 2)
    expect(JSON.stringify(row)).not.toMatch(/secret|private/)
  })

  test("token-like values in public identity fields are redacted", () => {
    const trace = createCandidateTrace(candidate({
      sourceJobId: "access_token=private-value",
      title: "Security Engineer https://jobs.example.test/?api_key=private-value",
      company: "Example Bearer private-value",
    }), "fixture", 47)
    expect(JSON.stringify(trace)).not.toContain("private-value")
    expect(trace.original_company).toContain("Bearer [redacted]")
  })

  test("stage append records deterministic outcomes without free-form errors", () => {
    const initial = createCandidateTrace(candidate(), "portal-a", 2)
    const next = appendTraceEvent(initial, { stage: "verification", decision: "failed", reasonCode: "LISTING_VALIDATION_FAILED", evidenceStatus: "present" })
    expect(next).toMatchObject({ stage: "verification", decision: "failed", reason_code: "LISTING_VALIDATION_FAILED" })
    expect(next.metadata.stage_history).toHaveLength(1)
  })

  test("stage history is bounded", () => {
    let row = createCandidateTrace(candidate(), "portal-a", 2)
    for (let index = 0; index < 30; index += 1) row = appendTraceEvent(row, { stage: "parsing", decision: "passed", reasonCode: "PARSE_SUCCESS", evidenceStatus: "present" })
    expect(row.metadata.stage_history).toHaveLength(20)
  })

  test("cap preserves terminal rejection outcomes before accepted rows", () => {
    const accepted = createCandidateTrace(candidate({ sourceJobId: "accepted" }), "portal-a", 2)
    const rejected = appendTraceEvent(createCandidateTrace(candidate({ sourceJobId: "rejected" }), "portal-a", 2), { stage: "role_screen", decision: "rejected", reasonCode: "ROLE_UNRELATED", evidenceStatus: "present" })
    const capped = capCandidateTraces([accepted, rejected], 1)
    expect(capped.records[0].candidate_identity).toBe(rejected.candidate_identity)
    expect(capped.omitted).toBe(1)
  })

  test("cap is stable for values below the configured limit", () => {
    const rows = [candidate({ sourceJobId: "one" }), candidate({ sourceJobId: "two" })].map((row) => createCandidateTrace(row, "portal-a", 2))
    expect(capCandidateTraces(rows, 10)).toEqual({ records: rows, omitted: 0 })
  })

  test("summary distinguishes observations, source candidates, source and reason", () => {
    const first = createCandidateTrace(candidate({ sourceJobId: "one" }), "portal-a", 2)
    const second = appendTraceEvent(createCandidateTrace(candidate({ sourceJobId: "two", source: "portal-b" }), "portal-b", 2), { stage: "role_screen", decision: "rejected", reasonCode: "ROLE_UNRELATED", evidenceStatus: "present" })
    expect(traceSummary([first, second])).toMatchObject({ source_observations: 2, unique_source_candidates: 2, rejected: 1, by_source: { "portal-a": 1, "portal-b": 1 }, by_reason: { SOURCE_OBSERVED: 1, ROLE_UNRELATED: 1 } })
  })

  test("tracing is opt-in and disabled by default", () => {
    expect(candidateTracingEnabled({})).toBe(false)
    expect(candidateTracingEnabled({ AI_JOB_SEARCH_TRACING_ENABLED: "true" })).toBe(true)
    expect(candidateTracingEnabled({ AI_JOB_SEARCH_TRACING_ENABLED: "1" })).toBe(false)
  })

  test("trace retention defaults to 30 days and validates configuration", () => {
    expect(traceRetentionDays({})).toBe(30)
    expect(traceRetentionDays({ AI_JOB_SEARCH_TRACE_RETENTION_DAYS: "45" })).toBe(45)
    expect(traceRetentionDays({ AI_JOB_SEARCH_TRACE_RETENTION_DAYS: "0" })).toBe(30)
    expect(traceRetentionDays({ AI_JOB_SEARCH_TRACE_RETENTION_DAYS: "366" })).toBe(30)
  })

  test("candidate caps and cleanup batch size are configurable within hard bounds", () => {
    expect(traceCandidateLimit({ AI_JOB_SEARCH_TRACE_MAX_CANDIDATES: "750" })).toBe(750)
    expect(traceCandidateLimit({ AI_JOB_SEARCH_TRACE_MAX_CANDIDATES: "999999" })).toBe(5000)
    expect(traceCleanupBatchSize({ AI_JOB_SEARCH_TRACE_CLEANUP_BATCH: "120" })).toBe(120)
    expect(traceCleanupBatchSize({ AI_JOB_SEARCH_TRACE_CLEANUP_BATCH: "9000" })).toBe(5000)
  })
})
