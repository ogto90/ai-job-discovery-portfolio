import { describe, expect, test } from "bun:test"
import {
  mergePersistedJobPayload,
  normalizeDiscoveredJob,
  runGenericDiscovery,
  verifyAndHydrateDiscoveredJobs,
  type DiscoveryStore,
  type SearchProfileRecord,
} from "../tools/generic_discovery"
import type { CandidateTraceRecord } from "../tools/discovery_candidate_tracing"
import { createCandidateTrace } from "../tools/discovery_candidate_tracing"
import { SupabaseDiscoveryStore } from "../tools/generic_discovery"
import type { NormalizedJob } from "../tools/company_registry"
import type { SourceRunResult } from "../tools/job_pipeline"

const profile: SearchProfileRecord = {
  id: 1,
  user_id: "user-test",
  name: "Security roles",
  definition: { target_titles: ["Security Engineer"], accepted_languages: ["English"], allowed_countries: ["Germany"] },
  min_fit_score: 50,
  is_active: true,
}

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    source: "mock-source",
    sourceType: "aggregator",
    sourceJobId: "source-1",
    title: "Security Engineer",
    company: "Example Company",
    url: "https://jobs.example.test/security-engineer?secret=hidden",
    location: "Berlin, Germany",
    description: "Responsibilities: design and implement secure systems, assess risks, support engineering teams, remediate issues, and communicate outcomes. English is required. ".repeat(3),
    ...overrides,
  }
}

function sourceResult(jobs: NormalizedJob[], status: SourceRunResult["detail"]["status"] = "success"): SourceRunResult {
  return {
    detail: {
      name: "mock-source",
      attempted: true,
      success: status === "success",
      status,
      jobsReturned: jobs.length,
      normalizedJobs: jobs.length,
      expiredJobs: 0,
      validationFailures: 0,
      uniqueJobs: jobs.length,
      duplicateJobs: 0,
      finalActionableJobs: 0,
      queriesAttempted: 1,
      pagesAttempted: 1,
    },
    jobs,
  }
}

class TraceStore implements DiscoveryStore {
  rows: Array<Record<string, unknown>> = []
  traceRows: CandidateTraceRecord[] = []
  associations: unknown[] = []
  pruneCalls = 0
  finished?: any
  persistTraceFailures = false
  failTracePrune = false
  failUpsert = false
  failLoad = false
  failAssociation = false
  failSuppressionFor?: string
  suppressedSourceIds = new Set<string>()
  private nextId = 1
  async getActiveSearchProfile() { return profile }
  async createSearchRun() { return 47 }
  async loadJobs() {
    if (this.failLoad) throw new Error("database read failed")
    return this.rows
  }
  async isSuppressed({ job: candidate }: any) {
    if (candidate.sourceJobId === this.failSuppressionFor) throw new Error("suppression lookup failed")
    return this.suppressedSourceIds.has(candidate.sourceJobId)
  }
  async upsertJob({ job: candidate, existing, now }: any) {
    if (this.failUpsert) throw new Error("database write failed")
    if (existing) {
      Object.assign(existing, mergePersistedJobPayload(candidate, existing, now))
      return { id: existing.id as number, created: false }
    }
    const row = { id: this.nextId++, source: candidate.source, source_job_id: candidate.sourceJobId, source_url: candidate.sourceUrl, application_url: candidate.applicationUrl, title: candidate.title, company: candidate.company, availability_status: "active" }
    this.rows.push(row)
    return { id: row.id, created: true }
  }
  async associateRunJob() {}
  async associateRunJobs(inputs: unknown[]) {
    if (this.failAssociation) throw new Error("run association write failed")
    this.associations.push(...inputs)
  }
  async persistCandidateTraces(records: CandidateTraceRecord[]) {
    if (this.persistTraceFailures) return { persisted: 0, failures: records.length }
    this.traceRows.push(...records)
    return { persisted: records.length, failures: 0 }
  }
  async pruneCandidateTraces() {
    this.pruneCalls += 1
    if (this.failTracePrune) throw new Error("trace cleanup unavailable")
    return 0
  }
  async finishSearchRun(input: any) { this.finished = input }
}

async function run(jobs: NormalizedJob[], store = new TraceStore(), detail = sourceResult(jobs), traceLimit?: number, candidateTracing = true) {
  const result = await runGenericDiscovery({
    mode: "broad",
    profile,
    store,
    sourceNames: ["mock-source"],
    sourceRunners: [async () => detail],
    candidateTracing,
    candidateTraceLimit: traceLimit,
    validator: async (items) => ({
      all: items.map((item) => ({ ...item, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-19T00:00:00.000Z" } })),
      results: items,
    }),
  })
  return { result, store }
}

describe("candidate tracing integration", () => {
  test("records a returned candidate through verification, identity, and persistence", async () => {
    const { result, store } = await run([job()])
    expect(store.traceRows).toHaveLength(1)
    expect(store.traceRows[0]).toMatchObject({ source: "mock-source", source_job_id: "source-1", physical_job_id: 1, final_outcome: "created", reason_code: "CREATED" })
    const history = store.traceRows[0].metadata.stage_history as Array<{ reasonCode: string }>
    expect(history.map((event) => event.reasonCode)).toContain("LISTING_ACTIVE")
    expect(result.stats.candidate_traces).toMatchObject({ enabled: true, attempted: 1, persisted: 1, persistence_failures: 0 })
  })

  test("known-incompatible geography is recorded and not sent to liveness verification", async () => {
    let validations = 0
    const store = new TraceStore()
    const result = await run([job({ sourceJobId: "us-role", location: "United States" })], store)
    validations = result.result.stats.validation_network_checks
    expect(validations).toBe(0)
    expect(store.traceRows[0].final_outcome).toBe("created")
    const history = store.traceRows[0].metadata.stage_history as Array<{ reasonCode: string; decision: string }>
    expect(history).toContainEqual(expect.objectContaining({ reasonCode: "LOCATION_INCOMPATIBLE", decision: "rejected" }))
    expect(history).toContainEqual(expect.objectContaining({ reasonCode: "VALIDATION_NOT_ATTEMPTED", decision: "not_attempted" }))
  })

  test("title-excluded candidate is traced despite never being persisted", async () => {
    const { store } = await run([job({ sourceJobId: "analyst", title: "Security Analyst" })])
    expect(store.rows).toHaveLength(0)
    expect(store.traceRows).toHaveLength(1)
    expect(store.traceRows[0]).toMatchObject({ final_outcome: "rejected_unrelated_role", reason_code: "ROLE_UNRELATED" })
  })

  test("unknown location remains distinct from known incompatibility", async () => {
    const { store } = await run([job({ sourceJobId: "unknown-location", location: null })])
    const history = store.traceRows[0].metadata.stage_history as Array<{ reasonCode: string; decision: string }>
    expect(history).toContainEqual(expect.objectContaining({ reasonCode: "LOCATION_UNRESOLVED", decision: "unknown" }))
    expect(history).not.toContainEqual(expect.objectContaining({ reasonCode: "LOCATION_INCOMPATIBLE" }))
  })

  test("source-level rate limits are retained without claiming candidate rejection", async () => {
    const { store } = await run([job()], new TraceStore(), sourceResult([job()], "rate_limited"))
    const history = store.traceRows[0].metadata.stage_history as Array<{ reasonCode: string; decision: string }>
    expect(history).toContainEqual(expect.objectContaining({ reasonCode: "SOURCE_RATE_LIMITED", decision: "unknown" }))
  })

  test("tracing remains disabled by default and does not require trace storage", async () => {
    const store = new TraceStore()
    const result = await runGenericDiscovery({ mode: "broad", profile, store, sourceRunners: [async () => sourceResult([job()])] })
    expect(store.rows).toHaveLength(1)
    expect(store.traceRows).toHaveLength(0)
    expect(store.pruneCalls).toBe(0)
    expect(result.stats.candidate_traces).toMatchObject({ enabled: false, attempted: 0, persisted: 0 })
  })

  test("disabled tracing skips per-candidate event and evidence maps", async () => {
    const normalized = normalizeDiscoveredJob(job(), "mock-source")!
    const result = await verifyAndHydrateDiscoveredJobs([normalized], profile, {
      now: new Date("2026-10-19T00:00:00.000Z"),
      validator: async (items) => ({
        all: items.map((item) => ({ ...item, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-19T00:00:00.000Z" } })),
        results: items,
      }),
    })
    expect(result.candidateEvents.size).toBe(0)
    expect(result.candidateFacts.size).toBe(0)
  })

  test("enabling tracing preserves business rows, run associations, and discovery outcomes", async () => {
    const candidates = [job(), job({ sourceJobId: "mismatch", location: "United States" }), job({ sourceJobId: "already-applied" })]
    const disabledStore = new TraceStore()
    disabledStore.suppressedSourceIds.add("already-applied")
    const enabledStore = new TraceStore()
    enabledStore.suppressedSourceIds.add("already-applied")
    const failedTraceStore = new TraceStore()
    failedTraceStore.persistTraceFailures = true
    failedTraceStore.suppressedSourceIds.add("already-applied")
    const disabled = await run(candidates, disabledStore, undefined, undefined, false)
    const enabled = await run(candidates, enabledStore)
    const traceFailed = await run(candidates, failedTraceStore)
    expect(enabled.store.rows).toEqual(disabled.store.rows)
    expect(enabled.store.associations).toEqual(disabled.store.associations)
    expect(enabled.store.finished?.status).toBe(disabled.store.finished?.status)
    expect(traceFailed.store.rows).toEqual(disabled.store.rows)
    expect(traceFailed.store.associations).toEqual(disabled.store.associations)
    expect(traceFailed.store.finished?.status).toBe(disabled.store.finished?.status)
    expect(traceFailed.store.pruneCalls).toBe(1)
    expect(enabled.result.stats).toMatchObject({
      raw_discovered: disabled.result.stats.raw_discovered,
      normalized: disabled.result.stats.normalized,
      new_jobs: disabled.result.stats.new_jobs,
      active_actionable: disabled.result.stats.active_actionable,
      fit_ready: disabled.result.stats.fit_ready,
      suppressed: disabled.result.stats.suppressed,
      preference_mismatches_retained: disabled.result.stats.preference_mismatches_retained,
    })
    expect(traceFailed.result.stats).toMatchObject({
      raw_discovered: disabled.result.stats.raw_discovered,
      normalized: disabled.result.stats.normalized,
      new_jobs: disabled.result.stats.new_jobs,
      active_actionable: disabled.result.stats.active_actionable,
      fit_ready: disabled.result.stats.fit_ready,
      suppressed: disabled.result.stats.suppressed,
      preference_mismatches_retained: disabled.result.stats.preference_mismatches_retained,
    })
  })

  test("trace storage failure is fail-open and does not alter discovery completion", async () => {
    const store = new TraceStore()
    store.persistTraceFailures = true
    const candidates = Array.from({ length: 500 }, (_, index) => job({ sourceJobId: `trace-failure-${index}` }))
    const { result } = await run(candidates, store)
    expect(store.rows).toHaveLength(500)
    expect(store.finished?.status).toBe("completed")
    expect(result.stats.candidate_traces).toMatchObject({
      attempted: 500,
      persistence_failures: 500,
      persisted: 0,
      write: { selected_for_persistence: 500, records_outcome_unknown: 500, write_failure_kind: "store_error" },
    })
  })

  test("retention cleanup failure is reported while discovery completes", async () => {
    const store = new TraceStore()
    store.failTracePrune = true
    const { result } = await run([job()], store)
    expect(store.rows).toHaveLength(1)
    expect(store.finished?.status).toBe("completed")
    expect(result.stats.candidate_traces).toMatchObject({ retention_failures: 1 })
  })

  test("retention cleanup runs on an enabled zero-candidate run", async () => {
    const store = new TraceStore()
    const { result } = await run([], store)
    expect(store.traceRows).toHaveLength(0)
    expect(store.pruneCalls).toBe(1)
    expect(result.stats.candidate_traces?.retention_pruned).toBe(0)
  })

  test("retention cleanup still runs when trace writes are unsupported", async () => {
    const store = new TraceStore()
    store.persistCandidateTraces = undefined as any
    const { result } = await run([job()], store)
    expect(store.rows).toHaveLength(1)
    expect(store.pruneCalls).toBe(1)
    expect(result.stats.candidate_traces).toMatchObject({
      persistence_failures: 1,
      retention_failures: 0,
      write: { selected_for_persistence: 1, records_not_attempted: 1, write_failure_kind: "unsupported_store" },
    })
  })

  test("business persistence failures are traced best-effort and still fail the discovery run", async () => {
    const store = new TraceStore()
    store.failUpsert = true
    await expect(run([job()], store)).rejects.toThrow("Discovery persistence failed during upserting job from mock-source")
    expect(store.finished?.status).toBe("failed")
    expect(store.traceRows[0].final_outcome).toBe("persistence_failed")
    expect(store.traceRows[0].reason_code).toBe("PERSISTENCE_FAILED")
  })

  test("diagnostic write failures remain in failed run-level stats", async () => {
    const store = new TraceStore()
    store.failUpsert = true
    store.persistTraceFailures = true
    await expect(run([job()], store)).rejects.toThrow("Discovery persistence failed during upserting job from mock-source")
    expect(store.finished?.status).toBe("failed")
    expect(store.finished?.stats.candidate_traces).toMatchObject({ persistence_failures: 1 })
  })

  test("candidate traces are flushed when loading existing jobs fails", async () => {
    const store = new TraceStore()
    store.failLoad = true
    await expect(run([job()], store)).rejects.toThrow("Discovery persistence failed during loading existing jobs")
    expect(store.finished?.status).toBe("failed")
    expect(store.traceRows[0]).toMatchObject({ final_outcome: "persistence_failed", reason_code: "PERSISTENCE_FAILED" })
    expect(store.finished?.stats.candidate_traces).toMatchObject({ persisted: 1, persistence_failures: 0 })
  })

  test("candidate traces identify run-association failures after job persistence", async () => {
    const store = new TraceStore()
    store.failAssociation = true
    await expect(run([job()], store)).rejects.toThrow("Discovery persistence failed during associating discovered jobs with search run")
    expect(store.rows).toHaveLength(1)
    expect(store.finished?.status).toBe("failed")
    expect(store.traceRows[0]).toMatchObject({ physical_job_id: 1, final_outcome: "run_association_failed", reason_code: "RUN_ASSOCIATION_FAILED" })
    expect(store.finished?.stats.candidate_traces).toMatchObject({ persisted: 1, persistence_failures: 0 })
  })

  test("a suppression lookup failure is attributed only to its candidate", async () => {
    const store = new TraceStore()
    store.failSuppressionFor = "suppression-error"
    await expect(run([job({ sourceJobId: "suppression-error" }), job({ sourceJobId: "suppression-ok" })], store))
      .rejects.toThrow("Discovery persistence failed during checking application suppression for ")
    expect(store.finished?.status).toBe("failed")
    expect(store.traceRows).toHaveLength(2)
    expect(store.traceRows.find((trace) => trace.source_job_id === "suppression-error")).toMatchObject({
      final_outcome: "suppression_check_failed",
      reason_code: "SUPPRESSION_CHECK_FAILED",
    })
    expect(store.traceRows.find((trace) => trace.source_job_id === "suppression-ok")?.final_outcome).toBe("created")
  })

  test("source observations for same physical listing stay separate across providers", async () => {
    const one = job({ source: "portal-a", sourceJobId: "provider-a" })
    const two = job({ source: "portal-b", sourceJobId: "provider-b" })
    const a = await run([one])
    const b = await run([two])
    expect(a.store.traceRows[0].candidate_identity).not.toBe(b.store.traceRows[0].candidate_identity)
  })

  test("trace cap reports omitted records and keeps rejected cases", async () => {
    const store = new TraceStore()
    const { result } = await run([
      job({ sourceJobId: "good" }),
      job({ sourceJobId: "unrelated", title: "Office Manager" }),
    ], store, undefined, 1)
    expect(result.stats.candidate_traces?.attempted).toBe(2)
    expect(result.stats.candidate_traces?.omitted_by_cap).toBe(1)
    expect(store.traceRows).toHaveLength(1)
    expect(store.traceRows[0].final_outcome).toBe("rejected_unrelated_role")
  })

  test("trace collection stays bounded and late early-screen rejections displace accepted records", async () => {
    const candidates = Array.from({ length: 300 }, (_, index) => job({
      sourceJobId: `bounded-${index}`,
      title: index === 299 ? "Office Manager" : "Security Engineer",
    }))
    const store = new TraceStore()
    const { result } = await run(candidates, store, undefined, 2)
    expect(store.traceRows).toHaveLength(2)
    expect(result.stats.candidate_traces).toMatchObject({ attempted: 300, omitted_by_cap: 298, persisted: 2 })
    expect(store.traceRows.some((record) => record.final_outcome === "rejected_unrelated_role")).toBe(true)
  })

  test("a 500-record diagnostic cap does not truncate normal discovery", async () => {
    const candidates = Array.from({ length: 502 }, (_, index) => job({
      sourceJobId: `pilot-cap-${index}`,
      url: `https://jobs.example.test/security-engineer/${index}`,
    }))
    const store = new TraceStore()
    const { result } = await run(candidates, store, undefined, 500)

    expect(store.rows).toHaveLength(502)
    expect(result.stats.raw_discovered).toBe(502)
    expect(result.stats.new_jobs).toBe(502)
    expect(store.traceRows).toHaveLength(500)
    expect(result.stats.candidate_traces).toMatchObject({ attempted: 502, omitted_by_cap: 2, persisted: 500 })
  })

  test("partial ATS board context is diagnostic and does not change lifecycle behavior", async () => {
    const candidate = job({
      source: "greenhouse",
      sourceType: "ats",
      sourceJobId: "req-partial",
      ats: { provider: "greenhouse", companyIdentifier: "board-x", requisitionId: "req-partial" },
    })
    const store = new TraceStore()
    const result = await runGenericDiscovery({
      mode: "broad", profile, store, sourceRunners: [], candidateTracing: true,
      atsRunner: async () => ({
        stats: { verifiedCompanies: 1, boardsConsidered: 1, boardsCrawled: 1, boardsSkippedFresh: 0, boardsDeferredBudget: 0, companiesAttempted: 1, successfulBoards: 0, failedBoards: 0, rateLimitedBoards: 0, partialBoards: 1, emptyBoards: 0, invalidMappings: 0, totalJobsFetched: 1, jobsNormalized: 1, historicalJobsCreated: 0, historicalJobsUpdated: 0, historicalJobsClosed: 0, historicalJobsReappeared: 0, duplicatesDetected: 0, potentialReposts: 0, providerDistribution: { greenhouse: 1 }, errors: [] },
        results: [{ companyId: "company", provider: "greenhouse", identifier: "board-x", fetchedAt: "2026-10-19T00:00:00.000Z", jobs: [candidate], allJobs: [candidate], success: true, boardStatus: "partial", snapshotComplete: false }],
        jobs: [candidate], registrySource: "supabase",
      }),
    })
    expect(store.traceRows[0].metadata.ats).toMatchObject({ provider: "greenhouse", board_identifier: "board-x", snapshot_complete: false, board_status: "partial" })
    expect(result.stats.ats_job_rows_closed).toBe(0)
  })

  test("trace writes use idempotent conflict handling in bounded batches", async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
      const records = Array.from({ length: 500 }, (_, index) => createCandidateTrace(job({ sourceJobId: `row-${index}` }), "mock-source", 47))
      const result = await store.persistCandidateTraces(records)
      expect(result).toMatchObject({ persisted: 500, failures: 0 })
      expect(result.diagnostics).toMatchObject({
        selected_for_persistence: 500,
        batches_prepared: 3,
        batches_attempted: 3,
        batches_succeeded: 3,
        records_persisted: 500,
      })
      expect(calls).toHaveLength(3)
      expect(JSON.stringify(result)).not.toMatch(/secret|authorization|token/i)
      expect(calls[0].url).toContain("on_conflict=search_run_id,candidate_identity")
      expect(calls[0].init?.headers).toMatchObject({ Prefer: "resolution=merge-duplicates,return=minimal" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("three delayed trace batches can complete beyond the former three-second budget", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      const signal = init?.signal as AbortSignal
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal.removeEventListener("abort", abort)
          resolve()
        }
        const timer = setTimeout(finish, 1_100)
        const abort = () => {
          clearTimeout(timer)
          reject(signal.reason)
        }
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
      })
      return new Response(null, { status: 204 })
    }) as typeof fetch
    const startedAt = performance.now()
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
      const records = Array.from({ length: 500 }, (_, index) => createCandidateTrace(job({ sourceJobId: `slow-${index}` }), "mock-source", 47))
      const result = await store.persistCandidateTraces(records)
      const elapsedMs = performance.now() - startedAt
      expect(result).toMatchObject({ persisted: 500, failures: 0 })
      expect(result.diagnostics).toMatchObject({ batches_attempted: 3, batches_succeeded: 3, records_persisted: 500 })
      expect(calls).toBe(3)
      expect(elapsedMs).toBeGreaterThan(3_000)
      expect(elapsedMs).toBeLessThan(15_000)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("each request timeout is capped by the remaining global budget", async () => {
    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    let now = 1_000
    const timeouts: number[] = []
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (milliseconds: number) => {
        timeouts.push(milliseconds)
        return new AbortController().signal
      },
    })
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) now = 12_500
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret", () => now)
      const records = Array.from({ length: 400 }, (_, index) => createCandidateTrace(job({ sourceJobId: `remaining-${index}` }), "mock-source", 47))
      const result = await store.persistCandidateTraces(records)
      expect(result).toMatchObject({ persisted: 400, failures: 0 })
      expect(timeouts).toEqual([8_000, 3_500])
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: originalTimeout })
    }
  })

  test("trace write failure is bounded by a request timeout", async () => {
    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    let requestedTimeoutMs = 0
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (milliseconds: number) => {
        requestedTimeoutMs = milliseconds
        const controller = new AbortController()
        setTimeout(() => controller.abort(new DOMException("request timed out", "TimeoutError")), 5)
        return controller.signal
      },
    })
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    })) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
      const record = createCandidateTrace(job(), "mock-source", 47)
      const result = await store.persistCandidateTraces([record])
      expect(result).toMatchObject({ persisted: 0, failures: 1 })
      expect(result.diagnostics).toMatchObject({
        batches_attempted: 1,
        batches_failed: 1,
        records_outcome_unknown: 1,
        write_budget_exhausted: false,
        write_failure_kind: "request_timeout",
      })
      expect(requestedTimeoutMs).toBe(8_000)
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: originalTimeout })
    }
  })

  test("an exhausted global write budget classifies remaining batches separately", async () => {
    const originalFetch = globalThis.fetch
    let now = 1_000
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      now += 15_001
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret", () => now)
      const records = Array.from({ length: 500 }, (_, index) => createCandidateTrace(job({ sourceJobId: `budget-${index}` }), "mock-source", 47))
      const result = await store.persistCandidateTraces(records)
      expect(result).toMatchObject({ persisted: 200, failures: 300 })
      expect(result.diagnostics).toMatchObject({
        batches_prepared: 3,
        batches_attempted: 1,
        batches_succeeded: 1,
        batches_failed: 0,
        batches_not_attempted: 2,
        records_persisted: 200,
        records_failed_write: 0,
        records_outcome_unknown: 0,
        records_not_attempted: 300,
        records_skipped_after_failure: 0,
        records_skipped_due_budget: 300,
        write_budget_exhausted: true,
        write_failure_kind: "budget_exhausted",
      })
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("a failed second batch separates rejected rows from batches never attempted", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return calls === 1
        ? new Response(null, { status: 204 })
        : Response.json({ code: "42501", message: "permission denied" }, { status: 403 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
      const records = Array.from({ length: 500 }, (_, index) => createCandidateTrace(job({ sourceJobId: `partial-${index}` }), "mock-source", 47))
      const result = await store.persistCandidateTraces(records)
      expect(result).toMatchObject({ persisted: 200, failures: 300 })
      expect(result.diagnostics).toMatchObject({
        selected_for_persistence: 500,
        batches_prepared: 3,
        batches_attempted: 2,
        batches_succeeded: 1,
        batches_failed: 1,
        batches_not_attempted: 1,
        records_persisted: 200,
        records_failed_write: 200,
        records_outcome_unknown: 0,
        records_not_attempted: 100,
        records_skipped_after_failure: 100,
        records_skipped_due_budget: 0,
        write_budget_exhausted: false,
        write_failure_kind: "http_4xx",
        write_http_status: 403,
        write_error_code: "42501",
      })
      const d = result.diagnostics!
      expect(d.selected_for_persistence).toBe(d.records_persisted + d.records_failed_write + d.records_outcome_unknown + d.records_not_attempted)
      expect(d.records_not_attempted).toBe(d.records_skipped_after_failure + d.records_skipped_due_budget)
      expect(calls).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("first and final batch rejections stop without retry or counter overlap", async () => {
    const originalFetch = globalThis.fetch
    for (const failedBatch of [1, 3]) {
      let calls = 0
      globalThis.fetch = (async () => {
        calls += 1
        return calls === failedBatch
          ? Response.json({ code: "42501", message: "permission denied" }, { status: 403 })
          : new Response(null, { status: 204 })
      }) as typeof fetch
      try {
        const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
        const records = Array.from({ length: 500 }, (_, index) => createCandidateTrace(job({ sourceJobId: `batch-${failedBatch}-${index}` }), "mock-source", 47))
        const result = await store.persistCandidateTraces(records)
        const diagnostics = result.diagnostics!
        const recordsInFailedBatch = Math.min(200, 500 - (failedBatch - 1) * 200)
        const recordsAfterFailedBatch = Math.max(0, 500 - failedBatch * 200)
        expect(diagnostics).toMatchObject({
          batches_attempted: failedBatch,
          batches_succeeded: failedBatch - 1,
          batches_failed: 1,
          batches_not_attempted: 3 - failedBatch,
          records_persisted: (failedBatch - 1) * 200,
          records_failed_write: recordsInFailedBatch,
          records_outcome_unknown: 0,
          records_not_attempted: recordsAfterFailedBatch,
          write_budget_exhausted: false,
          write_failure_kind: "http_4xx",
        })
        expect(diagnostics.selected_for_persistence).toBe(
          diagnostics.records_persisted + diagnostics.records_failed_write
            + diagnostics.records_outcome_unknown + diagnostics.records_not_attempted,
        )
        expect(diagnostics.records_not_attempted).toBe(
          diagnostics.records_skipped_after_failure + diagnostics.records_skipped_due_budget,
        )
        expect(calls).toBe(failedBatch)
      } finally {
        globalThis.fetch = originalFetch
      }
    }
  })

  test("timeout during a batch marks that batch outcome unknown and later batches unattempted", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 2) throw new DOMException("request timed out", "TimeoutError")
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
      const records = Array.from({ length: 500 }, (_, index) => createCandidateTrace(job({ sourceJobId: `timeout-${index}` }), "mock-source", 47))
      const result = await store.persistCandidateTraces(records)
      expect(result).toMatchObject({ persisted: 200, failures: 300 })
      expect(result.diagnostics).toMatchObject({
        batches_attempted: 2,
        batches_succeeded: 1,
        batches_failed: 1,
        batches_not_attempted: 1,
        records_persisted: 200,
        records_failed_write: 0,
        records_outcome_unknown: 200,
        records_not_attempted: 100,
        records_skipped_after_failure: 100,
        records_skipped_due_budget: 0,
        write_budget_exhausted: false,
        write_failure_kind: "request_timeout",
      })
      expect(calls).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("final batch timeout remains ambiguous without false rejection or success", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 3) throw new DOMException("request timed out", "TimeoutError")
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
      const records = Array.from({ length: 500 }, (_, index) => createCandidateTrace(job({ sourceJobId: `final-timeout-${index}` }), "mock-source", 47))
      const result = await store.persistCandidateTraces(records)
      const diagnostics = result.diagnostics!
      expect(result).toMatchObject({ persisted: 400, failures: 100 })
      expect(diagnostics).toMatchObject({
        batches_prepared: 3,
        batches_attempted: 3,
        batches_succeeded: 2,
        batches_failed: 1,
        batches_not_attempted: 0,
        records_persisted: 400,
        records_failed_write: 0,
        records_outcome_unknown: 100,
        records_not_attempted: 0,
        records_skipped_after_failure: 0,
        records_skipped_due_budget: 0,
        write_budget_exhausted: false,
        write_failure_kind: "request_timeout",
      })
      expect(diagnostics.selected_for_persistence).toBe(500)
      expect(calls).toBe(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("server and network failures preserve uncertain-commit status without retrying", async () => {
    const originalFetch = globalThis.fetch
    for (const [failure, expected] of [
      [() => Promise.resolve(Response.json({ message: "temporary" }, { status: 503 })), { write_failure_kind: "http_5xx", write_http_status: 503 }],
      [() => Promise.resolve(Response.json([{ inserted: 1 }], { status: 207 })), { write_failure_kind: "http_unexpected", write_http_status: 207 }],
      [() => Promise.reject(new TypeError("network unavailable")), { write_failure_kind: "network_error" }],
    ] as const) {
      let calls = 0
      globalThis.fetch = (async () => {
        calls += 1
        return failure()
      }) as typeof fetch
      try {
        const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
        const result = await store.persistCandidateTraces([createCandidateTrace(job(), "mock-source", 47)])
        expect(result).toMatchObject({ persisted: 0, failures: 1 })
        expect(result.diagnostics).toMatchObject({
          records_outcome_unknown: 1,
          records_failed_write: 0,
          records_not_attempted: 0,
          ...expected,
        })
        expect(calls).toBe(1)
      } finally {
        globalThis.fetch = originalFetch
      }
    }
  })

  test("trace write duration includes bounded network wait", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
      const result = await store.persistCandidateTraces([createCandidateTrace(job(), "mock-source", 47)])
      expect(result.diagnostics?.write_duration_ms).toBeGreaterThanOrEqual(15)
      expect(result.diagnostics?.write_duration_ms).toBeLessThan(1_000)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("an oversized trace request fails diagnostically without retry", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return Response.json({ message: "payload too large" }, { status: 413 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
      const records = [createCandidateTrace(job(), "mock-source", 47)]
      expect(await store.persistCandidateTraces(records)).toMatchObject({ persisted: 0, failures: 1 })
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("an invalid trace payload is reported without throwing into discovery", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return Response.json({ message: "constraint violation" }, { status: 400 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
      expect(await store.persistCandidateTraces([createCandidateTrace(job(), "mock-source", 47)]))
        .toMatchObject({ persisted: 0, failures: 1 })
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("retention cleanup deletes only selected expired trace rows", async () => {
    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const timeouts: number[] = []
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (milliseconds: number) => {
        timeouts.push(milliseconds)
        return new AbortController().signal
      },
    })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return init?.method === "DELETE"
        ? Response.json([{ id: 11 }, { id: 12 }])
        : Response.json([{ id: 11 }, { id: 12 }])
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.test", "secret")
      expect(await store.pruneCandidateTraces(30, 5000)).toBe(2)
      expect(calls).toHaveLength(2)
      expect(calls[0].url).toContain("limit=5000")
      expect(calls[1].init?.method).toBe("DELETE")
      expect(calls[1].url).toContain("observed_at=lt.")
      expect(timeouts.length).toBe(2)
      expect(timeouts.every((timeout) => timeout > 0 && timeout <= 3_000)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: originalTimeout })
    }
  })
})
