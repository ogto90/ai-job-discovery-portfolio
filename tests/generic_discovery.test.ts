import { describe, expect, test } from "bun:test"
import {
  buildSearchQueries,
  configuredDashboardAtsBoardBudget,
  configuredJdEnrichmentBudget,
  DEFAULT_DASHBOARD_ATS_BOARD_BUDGET,
  DEFAULT_JD_ENRICHMENT_BUDGET,
  classifyEmploymentType,
  classifyLanguageEligibility,
  classifyLocationEligibility,
  classifyTargetRoleAfterDescription,
  classifyTargetRole,
  consolidateRunJobObservationContexts,
  discoveryKey,
  evaluateFinalJobEligibility,
  evidenceValidationOptions,
  mergeDiscoveredJobs,
  mergePersistedJobPayload,
  normalizeDiscoveredJob,
  passesSearchProfile,
  queryGroupsForMatches,
  runGenericDiscovery,
  SupabaseDiscoveryStore,
  verifyAndHydrateDiscoveredJobs,
  type DiscoveryStore,
  type SearchProfileRecord,
} from "../tools/generic_discovery"
import type { NormalizedJob } from "../tools/job_availability_validator"
import type { AtsFetchResult, AtsIngestionStats } from "../tools/ats_job_ingestor"
import { JsonJobHistoryStore, type HistoricalJob } from "../tools/job_history"
import { discoveredMetadataIsSane, resolveJobMetadata } from "../tools/job_metadata"

const profiles: Record<string, SearchProfileRecord> = {
  security: { id: 1, user_id: "u1", name: "Security", definition: { target_titles: ["Security Engineer"], role_families: ["Application Security", "Product Security"], positive_concepts: ["secure SDLC"], target_adjacent_terms: ["DevOps Engineer", "SOAR Developer", "PAM", "Security Enhancements"], excluded_title_patterns: ["Analyst", "SOC"], accepted_languages: ["English"] }, min_fit_score: 60, is_active: true },
  accounting: { id: 2, user_id: "u1", name: "Accounting", definition: { target_titles: ["Accountant"], role_families: ["Financial Controller"], industries_or_domains: ["SaaS"], excluded_concepts: ["payroll"] }, min_fit_score: 0, is_active: true },
  software: { id: 3, user_id: "u1", name: "Software", definition: { target_titles: ["Software Engineer", "Backend Engineer", "Backend Developer", "Python Developer"], role_families: ["Backend Engineering"], positive_concepts: ["Python"] }, min_fit_score: 0, is_active: true },
  product: { id: 4, user_id: "u1", name: "Product", definition: { target_titles: ["Product Manager", "Senior Product Manager", "Technical Product Manager"], role_families: ["Product Management"] }, min_fit_score: 0, is_active: true },
}

const emptyAtsStats: AtsIngestionStats = {
  verifiedCompanies: 1, boardsConsidered: 1, boardsCrawled: 1, boardsSkippedFresh: 0, boardsDeferredBudget: 0,
  companiesAttempted: 1, successfulBoards: 1, failedBoards: 0, rateLimitedBoards: 0, partialBoards: 0,
  emptyBoards: 0, invalidMappings: 0, totalJobsFetched: 0, jobsNormalized: 0,
  historicalJobsCreated: 0, historicalJobsUpdated: 0, historicalJobsClosed: 0, historicalJobsReappeared: 0,
  duplicatesDetected: 0, potentialReposts: 0, providerDistribution: { greenhouse: 1 }, errors: [],
}

function atsJob(id: string, title: string, company = "Acme", provider = "greenhouse"): NormalizedJob {
  return {
    source: provider, sourceType: "ats", id, title, company,
    url: provider === "lever" ? `https://jobs.lever.co/acme/${id}` : provider === "ashby" ? `https://jobs.ashbyhq.com/acme/${id}` : `https://boards.greenhouse.io/acme/jobs/${id}`,
    applicationUrl: provider === "lever" ? `https://jobs.lever.co/acme/${id}` : provider === "ashby" ? `https://jobs.ashbyhq.com/acme/${id}` : `https://boards.greenhouse.io/acme/jobs/${id}`,
    location: "Remote Europe", workplaceType: "remote", employmentType: "full-time",
    description: "Responsibilities: build and operate the team's services, work with stakeholders, and deliver reliable outcomes. English is required. ".repeat(3),
    ats: { provider, companyIdentifier: "acme", requisitionId: id },
    validation: { status: "active", method: "ats_api", confidence: 100, checkedAt: "2026-10-07T10:00:00Z" },
  }
}

function atsRunner(jobs: NormalizedJob[]) {
  const result: AtsFetchResult = {
    companyId: "company_acme", provider: "greenhouse", identifier: "acme", fetchedAt: "2026-10-07T10:00:00Z",
    jobs, allJobs: jobs, success: true, boardStatus: jobs.length ? "success" : "empty", snapshotComplete: true,
  }
  return async () => ({ stats: { ...emptyAtsStats, totalJobsFetched: jobs.length, jobsNormalized: jobs.length }, results: [result], jobs })
}

function raw(input: Partial<NormalizedJob> & { id: string; title: string; company: string; url: string }): NormalizedJob {
  return { source: "mock", sourceType: "aggregator", description: `Responsibilities: Lead security reviews, design practical controls, implement improvements, support product teams, assess risks, respond to incidents, build sustainable processes, and maintain clear documentation. Qualifications: Bring relevant experience, communicate effectively, collaborate across engineering and product groups, prioritize work independently, and deliver measurable outcomes for customers. English is required for daily collaboration with our international teams.`, ...input }
}

function runner(name: string, jobs: NormalizedJob[], success = true) {
  return async () => ({
    detail: { name, attempted: true, success, status: success ? "success" as const : "provider_error" as const, jobsReturned: jobs.length, normalizedJobs: jobs.length, expiredJobs: 0, validationFailures: 0, uniqueJobs: jobs.length, duplicateJobs: 0, finalActionableJobs: 0 },
    jobs,
  })
}

class MemoryStore implements DiscoveryStore {
  rows: Record<string, unknown>[] = []
  associations: Array<Record<string, unknown>> = []
  finished: any
  upsertCalls = 0
  suppressedTitles = new Set<string>()
  failUpsert = false
  async getActiveSearchProfile() { return profiles.security }
  async createSearchRun() { return 10 }
  async loadJobs() { return this.rows }
  async isSuppressed({ job }: any) { return this.suppressedTitles.has(job.title) }
  async upsertJob({ job, existing, now }: any) {
    this.upsertCalls += 1
    if (this.failUpsert) throw new Error("simulated database failure")
    if (existing) {
      Object.assign(existing, mergePersistedJobPayload(job, existing, now))
      return { id: existing.id as number, created: false }
    }
    const row = { id: this.rows.length + 1, source: job.source, source_job_id: job.sourceJobId, source_url: job.sourceUrl, application_url: job.applicationUrl, company: job.company, title: job.title, description: job.description, description_kind: job.descriptionKind, first_seen_at: now, last_seen_at: now }
    this.rows.push(row)
    return { id: row.id, created: true }
  }
  async associateRunJob(input: any) { this.associations.push(input) }
  async finishSearchRun(input: any) { this.finished = input }
}

function suppressionRetryDependencies(initialTime = 0) {
  let time = initialTime
  const delays: number[] = []
  return {
    delays,
    dependencies: {
      now: () => time,
      sleep: async (durationMs: number) => { delays.push(durationMs); time += durationMs },
      random: () => 0.5,
      timeoutSignal: () => new AbortController().signal,
    },
    advance: (durationMs: number) => { time += durationMs },
  }
}

function suppressionTestJob() {
  return normalizeDiscoveredJob(raw({ id: "suppression-1", title: "Security Engineer", company: "Acme", url: "https://jobs.example/suppression-1" }), "mock")!
}

describe("generic discovery", () => {
  test("JD enrichment budget accepts only the default or explicit pilot cap", () => {
    expect(DEFAULT_JD_ENRICHMENT_BUDGET).toBe(30)
    expect(configuredJdEnrichmentBudget(undefined)).toBe(30)
    expect(configuredJdEnrichmentBudget("")).toBe(30)
    expect(configuredJdEnrichmentBudget("30")).toBe(30)
    expect(configuredJdEnrichmentBudget(" 60 ")).toBe(60)
    for (const invalid of ["0", "-1", "29", "31", "61", "150", "438", "garbage", "60.0", "Infinity"]) {
      expect(() => configuredJdEnrichmentBudget(invalid)).toThrow("must be 30 or 60")
    }
  })

  test("effective JD budget is present even when no candidate needs hydration", async () => {
    const original = process.env.AI_JOB_SEARCH_JD_ENRICHMENT_MAX_ATTEMPTS
    try {
      process.env.AI_JOB_SEARCH_JD_ENRICHMENT_MAX_ATTEMPTS = "60"
      const result = await runGenericDiscovery({ mode: "broad", profile: profiles.security,
        store: new MemoryStore(), sourceRunners: [], atsRunner: atsRunner([]) })
      expect(result.stats.jd_hydration?.budget).toBe(60)
      expect(result.stats.jd_hydration_summary).toContain("budget=60")
      expect(result.stats.jd_hydration?.attempted).toBe(0)
    } finally {
      if (original === undefined) delete process.env.AI_JOB_SEARCH_JD_ENRICHMENT_MAX_ATTEMPTS
      else process.env.AI_JOB_SEARCH_JD_ENRICHMENT_MAX_ATTEMPTS = original
    }
  })

  test("disabled Jobnet is reported but cannot create results or mutate historical listing state", async () => {
    const store = new MemoryStore()
    store.rows = [
      { id: 70, source: "jobnet-search", source_job_id: "historic-active", title: "Security Engineer", lifecycle_status: "active" },
      { id: 71, source: "jobnet-search", source_job_id: "historic-applied", title: "Security Engineer", application_status: "applied" },
      { id: 72, source: "jobnet-search", source_job_id: "historic-rejected", title: "Security Engineer", application_status: "rejected" },
    ]
    const originalRows = structuredClone(store.rows)

    const result = await runGenericDiscovery({
      mode: "broad",
      profile: profiles.security,
      sourceNames: ["jobnet-search"],
      store,
      atsRunner: async () => ({ stats: { ...emptyAtsStats, boardsConsidered: 0, boardsCrawled: 0, successfulBoards: 0, providerDistribution: {} }, results: [], jobs: [] }),
    })

    expect(result.sourceSelection.find((item) => item.provider === "jobnet-search")).toMatchObject({
      enabledByConfig: false,
      selected: false,
      reason: "disabled_by_config",
    })
    expect(result.sourceDetails).toEqual([])
    expect(result.stats.source_count).toBe(0)
    expect(result.stats.errors).toEqual([])
    expect(result.stats.provider_selection?.find((item) => item.provider === "jobnet-search")?.reason).toBe("disabled_by_config")
    expect(store.finished.status).toBe("completed")
    expect(store.upsertCalls).toBe(0)
    expect(store.rows).toEqual(originalRows)
  })

  test("disabled InfoSecJobs is not invoked and leaves historical jobs and application states untouched", async () => {
    const store = new MemoryStore()
    store.rows = [
      { id: 80, source: "infosecjobs-search", source_job_id: "historic-active", title: "Security Engineer", lifecycle_status: "active" },
      { id: 81, source: "infosecjobs-search", source_job_id: "historic-applied", title: "Security Engineer", application_status: "applied" },
      { id: 82, source: "infosecjobs-search", source_job_id: "historic-rejected", title: "Security Engineer", application_status: "rejected" },
    ]
    const originalRows = structuredClone(store.rows)

    const result = await runGenericDiscovery({
      mode: "broad",
      profile: profiles.security,
      sourceNames: ["infosecjobs-search"],
      store,
      atsRunner: async () => ({ stats: { ...emptyAtsStats, boardsConsidered: 0, boardsCrawled: 0, successfulBoards: 0, providerDistribution: {} }, results: [], jobs: [] }),
    })

    expect(result.sourceSelection.find((item) => item.provider === "infosecjobs-search")).toMatchObject({
      enabledByConfig: false,
      selected: false,
      reason: "disabled_by_config",
    })
    expect(result.sourceDetails).toEqual([])
    expect(result.stats.source_count).toBe(0)
    expect(result.stats.errors).toEqual([])
    expect(result.stats.provider_selection?.find((item) => item.provider === "infosecjobs-search")?.reason).toBe("disabled_by_config")
    expect(store.finished.status).toBe("completed")
    expect(store.upsertCalls).toBe(0)
    expect(store.rows).toEqual(originalRows)
  })

  test("dashboard ATS board budget defaults to eight and supports a positive integer override", async () => {
    expect(DEFAULT_DASHBOARD_ATS_BOARD_BUDGET).toBe(8)
    expect(configuredDashboardAtsBoardBudget("")).toBe(8)
    expect(configuredDashboardAtsBoardBudget("12")).toBe(12)
    expect(() => configuredDashboardAtsBoardBudget("0")).toThrow("positive integer")
    let received: any
    await runGenericDiscovery({
      mode: "broad", profile: profiles.security, store: new MemoryStore(), sourceRunners: [], atsRegistrySource: "supabase",
      atsRotationSlot: 33,
      atsRunner: async (options) => {
        received = options
        return { stats: { ...emptyAtsStats, boardsCrawled: 0, rotationSlot: 33, selectedBoardIds: ["ashby/default/acme"] }, results: [], jobs: [] }
      },
    })
    expect(received).toMatchObject({ boardBudget: 8, deferSuccessfulFreshness: true, registrySource: "supabase", rotationSlot: 33 })
  })

  test("a durable registry failure is reported while portal discovery continues", async () => {
    const result = await runGenericDiscovery({
      mode: "broad",
      profile: profiles.security,
      sourceNames: ["mock-portal"],
      sourceRunners: [runner("mock-portal", [])],
      atsRunner: async () => { throw new Error("durable ATS registry unavailable") },
    })
    expect(result.sourceDetails[0]).toMatchObject({ name: "mock-portal", status: "success", success: true })
    expect(result.stats.errors).toContainEqual({ source: "ats-registry", message: "durable ATS registry unavailable" })
    expect(result.stats.ats_boards_considered).toBe(0)
    expect(result.stats.ats_registry_source).toBe("unavailable")
    expect(result.stats.ats_historical_jobs_closed).toBe(0)
    expect(result.stats.ats_job_rows_closed).toBe(0)
  })

  test("source authorization failures keep a typed run-level summary", async () => {
    const store = new MemoryStore()
    const result = await runGenericDiscovery({
      mode: "broad",
      profile: profiles.security,
      sourceNames: ["jobnet-search"],
      store,
      sourceRunners: [async () => ({
        detail: {
          name: "jobnet-search",
          attempted: true,
          success: false,
          status: "authorization_failed",
          errorCategory: "authorization_failed",
          error: "API request failed: 401 Unauthorized",
          runtimeMs: 4,
          jobsReturned: 0,
          queriesAttempted: 1,
          pagesAttempted: 1,
          normalizedJobs: 0,
          expiredJobs: 0,
          validationFailures: 0,
          uniqueJobs: 0,
          duplicateJobs: 0,
          finalActionableJobs: 0,
        },
        jobs: [],
      })],
      atsRunner: async () => ({ stats: emptyAtsStats, results: [], jobs: [] }),
      candidateTracing: false,
    })

    expect(result.sourceDetails[0]).toMatchObject({
      name: "jobnet-search",
      status: "authorization_failed",
      success: false,
      jobsReturned: 0,
    })
    expect(result.stats.errors).toContainEqual({
      source: "jobnet-search",
      message: "API request failed: 401 Unauthorized",
      category: "authorization_failed",
    })
    expect(store.finished?.stats.errors).toEqual(result.stats.errors)
    expect(store.finished?.status).toBe("partial")
  })

  test("successful ATS freshness is committed only after job persistence and run association", async () => {
    const historyPath = `/tmp/generic-discovery-history-${Date.now()}-${Math.random()}.json`
    const history = await JsonJobHistoryStore.load(historyPath)
    const job = atsJob("fresh-after-persist", "Security Engineer")
    const atsResult: AtsFetchResult = {
      companyId: "company_acme", provider: "greenhouse", identifier: "acme", fetchedAt: "2026-10-07T10:00:00Z",
      jobs: [job], allJobs: [job], success: true, boardStatus: "success", snapshotComplete: true,
    }
    history.recordFetchState({ companyId: "company_acme", provider: "greenhouse", identifier: "acme", lastAttemptedAt: atsResult.fetchedAt, lastSuccessfulAt: null, snapshotComplete: true, persistencePending: true, updatedAt: atsResult.fetchedAt })
    await history.save()
    const store = new MemoryStore()
    await runGenericDiscovery({
      mode: "broad", profile: profiles.security, store, sourceRunners: [],
      atsRunner: async () => ({ stats: { ...emptyAtsStats, totalJobsFetched: 1, jobsNormalized: 1 }, results: [atsResult], jobs: [job], history }),
    })
    expect(store.associations).toHaveLength(1)
    expect((await JsonJobHistoryStore.load(historyPath)).getFetchState("company_acme", "greenhouse", "acme")).toMatchObject({ lastSuccessfulAt: atsResult.fetchedAt, persistencePending: false })
  })

  test("successful ATS acquisition remains retryable when later DB persistence fails", async () => {
    const historyPath = `/tmp/generic-discovery-history-fail-${Date.now()}-${Math.random()}.json`
    const history = await JsonJobHistoryStore.load(historyPath)
    const job = atsJob("failed-persist", "Security Engineer")
    const atsResult: AtsFetchResult = {
      companyId: "company_acme", provider: "greenhouse", identifier: "acme", fetchedAt: "2026-10-07T10:00:00Z",
      jobs: [job], allJobs: [job], success: true, boardStatus: "success", snapshotComplete: true,
    }
    history.recordFetchState({ companyId: "company_acme", provider: "greenhouse", identifier: "acme", lastAttemptedAt: atsResult.fetchedAt, lastSuccessfulAt: null, snapshotComplete: true, persistencePending: true, updatedAt: atsResult.fetchedAt })
    await history.save()
    const store = new MemoryStore()
    store.failUpsert = true
    await expect(runGenericDiscovery({
      mode: "broad", profile: profiles.security, store, sourceRunners: [],
      atsRunner: async () => ({ stats: { ...emptyAtsStats, totalJobsFetched: 1, jobsNormalized: 1 }, results: [atsResult], jobs: [job], history }),
    })).rejects.toThrow("Discovery persistence failed during upserting job from greenhouse")
    expect(store.finished).toMatchObject({ status: "failed" })
    expect((await JsonJobHistoryStore.load(historyPath)).getFetchState("company_acme", "greenhouse", "acme")).toMatchObject({ lastSuccessfulAt: null, persistencePending: true })
  })

  test("suppression RPC checks use bounded concurrency and preserve job outcomes", async () => {
    const store = new MemoryStore()
    let active = 0
    let maxActive = 0
    store.isSuppressed = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return false
    }
    const jobs = Array.from({ length: 16 }, (_, index) => raw({
      id: `suppression-${index}`,
      title: "Security Engineer",
      company: `Company ${index}`,
      url: `https://jobs.example/suppression-${index}`,
    }))
    const result = await runGenericDiscovery({
      mode: "broad", profile: profiles.security, store, sourceRunners: [runner("mock", jobs)],
      atsRunner: async () => ({ stats: { ...emptyAtsStats, boardsCrawled: 0 }, results: [], jobs: [] }),
      validator: async (items) => ({ all: items.map((item) => ({ ...item, validation: { status: "active" as const, method: "source_detail" as const, confidence: 95, checkedAt: "2026-10-07T10:00:00Z" } })), results: items }),
      enricher: async (items) => ({ jobs: items, stats: { considered: items.length, attempted: 0, success: 0, cacheHits: 0, notNeeded: items.length, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }),
    })

    expect(maxActive).toBeGreaterThan(1)
    expect(maxActive).toBeLessThanOrEqual(8)
    expect(store.associations).toHaveLength(jobs.length)
    expect(result.stats.existing_jobs + result.stats.new_jobs).toBe(jobs.length)
    expect(result.stats.jd_hydration?.considered).toBe(0)
    expect(result.stats.jd_hydration_summary).toContain("entered=0")
    expect(result.stats.jd_hydration_summary).toContain("need_detail=0")
  })

  test("the six historical role patterns distinguish supported ATS paths from deliberate provider gaps", async () => {
    const supported = [
      atsJob("swapcard-1", "Security Engineer", "Swapcard", "lever"),
      atsJob("auros-1", "Principal Security Engineer", "Auros", "greenhouse"),
      atsJob("elevenlabs-1", "Infrastructure Security Engineer", "ElevenLabs", "ashby"),
    ]
    const result = await runGenericDiscovery({ mode: "broad", profile: profiles.security, sourceRunners: [], atsRunner: atsRunner(supported) })
    expect(result.jobs.map((job) => `${job.company}:${job.title}`)).toEqual([
      "Swapcard:Security Engineer", "Auros:Principal Security Engineer", "ElevenLabs:Infrastructure Security Engineer",
    ])
    for (const fixture of supported) expect(["greenhouse", "lever", "ashby", "smartrecruiters", "personio"]).toContain(fixture.source)
    const unsupported = [
      { company: "XTEL", provider: "teamtailor", title: "Cybersecurity Engineer" },
      { company: "Coverflex", provider: "teamtailor", title: "Cybersecurity Lead" },
      { company: "PostHog", provider: "direct_employer", title: "Security Engineer" },
    ]
    expect(unsupported.map((item) => item.provider)).toEqual(["teamtailor", "teamtailor", "direct_employer"])
    expect(classifyTargetRole(unsupported[0].title, profiles.security)).toBe("target_match")
    const leadershipSecurityProfile = {
      ...profiles.security,
      definition: { ...profiles.security.definition, target_titles: [...(profiles.security.definition.target_titles ?? []), "Security Lead", "Cybersecurity Engineer"] },
    }
    expect(classifyTargetRole(unsupported[1].title, leadershipSecurityProfile)).toBe("target_match")
    expect(classifyTargetRole(unsupported[2].title, profiles.security)).toBe("target_match")
  })

  test("ATS acquisition is domain-neutral and SearchProfile relevance is applied downstream", async () => {
    const board = [
      atsJob("sec-1", "Security Engineer"),
      atsJob("back-1", "Backend Engineer"),
      atsJob("sales-1", "Sales Manager"),
      atsJob("pm-1", "Product Manager"),
    ]
    const run = async (profile: SearchProfileRecord) => runGenericDiscovery({
      mode: "broad", profile, sourceRunners: [], atsRunner: atsRunner(board),
      validator: async (jobs) => ({ all: jobs, results: jobs }),
      enricher: async (jobs) => ({ jobs, stats: { considered: jobs.length, attempted: 0, success: 0, cacheHits: 0, notNeeded: jobs.length, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }),
    })
    const security = await run(profiles.security)
    const backend = await run(profiles.software)
    const product = await run(profiles.product)
    expect(security.jobs.map((job) => job.title)).toEqual(["Security Engineer"])
    expect(backend.jobs.map((job) => job.title)).toEqual(["Backend Engineer"])
    expect(product.jobs.map((job) => job.title)).toEqual(["Product Manager"])
    expect(security.stats.ats_jobs_raw).toBe(4)
    expect(security.stats.ats_jobs_relevant).toBe(1)
    expect(security.stats.ats_provider_counts).toEqual({ greenhouse: 1 })
  })

  test("ATS board liveness is retained and relevant preference mismatches remain in the candidate pool", async () => {
    const profile: SearchProfileRecord = {
      ...profiles.security,
      definition: { ...profiles.security.definition, accepted_employment_types: ["contract"], remote_only: true },
    }
    let listingChecks = 0
    const result = await runGenericDiscovery({
      mode: "broad", profile, store: new MemoryStore(), sourceRunners: [], atsRunner: atsRunner([atsJob("sec-2", "Security Engineer")]),
      validator: async (jobs) => { listingChecks += jobs.length; return { all: jobs, results: jobs } },
      enricher: async (jobs) => ({ jobs, stats: { considered: jobs.length, attempted: 0, success: 0, cacheHits: 0, notNeeded: jobs.length, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }),
    })
    expect(listingChecks).toBe(0)
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0].validation?.method).toBe("ats_api")
    expect(result.stats.ats_jobs_preference_mismatch).toBe(1)
    expect(result.stats.preference_mismatches_retained).toBe(1)
  })

  test("legacy cross-source mode permits an ATS/portal duplicate instead of weakly merging it", async () => {
    const direct = atsJob("duplicate-1", "Security Engineer")
    const portal: NormalizedJob = {
      ...direct,
      id: "portal-1", source: "jobgether", sourceType: "aggregator",
      sourceJobId: "portal-1", sourceUrl: "https://www.jobgether.com/jobs/security-engineer",
      url: "https://www.jobgether.com/jobs/security-engineer",
    }
    const result = await runGenericDiscovery({
      mode: "broad", profile: profiles.security, store: new MemoryStore(),
      sourceRunners: [runner("jobgether-search", [portal])], atsRunner: atsRunner([direct]),
      validator: async (jobs) => ({ all: jobs.map((job) => ({ ...job, validation: { status: "active" as const, method: "source_detail" as const, confidence: 95, checkedAt: "2026-10-07T10:00:00Z" } })), results: jobs }),
      enricher: async (jobs) => ({ jobs, stats: { considered: jobs.length, attempted: 0, success: 0, cacheHits: 0, notNeeded: jobs.length, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }),
    })
    expect(result.jobs).toHaveLength(2)
    expect(result.stats.physical_identity_mode).toBe("unknown")
  })

  test("registry/ATS acquisition failure is isolated from successful portal discovery", async () => {
    const portal = raw({ id: "portal-survives", title: "Security Engineer", company: "Acme", url: "https://jobgether.com/jobs/portal-survives" })
    const result = await runGenericDiscovery({
      mode: "broad", profile: profiles.security, sourceRunners: [runner("jobgether-search", [portal])],
      atsRunner: async () => { throw new Error("registry file unavailable") },
      validator: async (jobs) => ({ all: jobs.map((job) => ({ ...job, validation: { status: "active" as const, method: "source_detail" as const, confidence: 90, checkedAt: "2026-10-07T10:00:00Z" } })), results: jobs }),
      enricher: async (jobs) => ({ jobs, stats: { considered: jobs.length, attempted: 0, success: 0, cacheHits: 0, notNeeded: jobs.length, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }),
    })
    expect(result.jobs.map((job) => job.title)).toEqual(["Security Engineer"])
    expect(result.stats.errors).toContainEqual({ source: "ats-registry", message: "registry file unavailable" })
  })

  test("physical identity capability probe distinguishes only known absent Phase 1E schema from real failures", async () => {
    const originalFetch = globalThis.fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      globalThis.fetch = (async () => new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 })) as typeof fetch
      expect(await store.detectPhysicalIdentityMode("u1")).toBe("legacy_compatibility")
      globalThis.fetch = (async () => new Response("true", { status: 200 })) as typeof fetch
      expect(await store.detectPhysicalIdentityMode("u1")).toBe("canonical")
      globalThis.fetch = (async () => new Response(JSON.stringify({ code: "42501" }), { status: 403 })) as typeof fetch
      await expect(store.detectPhysicalIdentityMode("u1")).rejects.toThrow("Supabase POST jobs via rpc/is_suppressed_job failed (HTTP 403, SQLSTATE 42501)")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("complete-board closures only patch the exact direct ATS row", async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const oldUrl = "https://boards.greenhouse.io/acme/jobs/closed-1"
    const closed: HistoricalJob = {
      id: "history-1", companyId: "acme", companyName: "Acme", sourceType: "ats", source: "greenhouse",
      ats: { provider: "greenhouse", companyIdentifier: "acme", requisitionId: "closed-1" }, title: "Security Engineer",
      canonicalUrl: oldUrl, applicationUrl: oldUrl, firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-06T00:00:00Z",
      status: "closed", timesObserved: 1, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z",
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url, method, body })
      if (method === "GET") return new Response(JSON.stringify([
        { id: 11, source_url: oldUrl, application_url: oldUrl },
        { id: 12, source_url: "https://boards.greenhouse.io/acme/jobs/other", application_url: "https://boards.greenhouse.io/acme/jobs/other" },
      ]), { status: 200 })
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      expect(await store.closeAtsJobs([closed])).toEqual({ closed: 1, errors: [] })
      expect(calls).toHaveLength(2)
      expect(calls[1]).toMatchObject({ url: expect.stringContaining("id=eq.11"), method: "PATCH", body: { availability_status: "expired" } })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("falls back to legacy suppression when the Phase 1E RPC is absent", async () => {
    const originalFetch = globalThis.fetch
    const paths: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input)
      paths.push(path)
      if (path.includes("is_suppressed_job")) return new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 })
      return new Response("true", { status: 200 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      const job = normalizeDiscoveredJob(raw({ id: "sup-1", title: "Security Engineer", company: "Co", url: "https://jobs.example/1" }), "mock")!
      expect(await store.isSuppressed({ userId: "u1", job, jobId: 7 })).toBe(true)
      expect(paths).toHaveLength(2)
      expect(paths[1]).toContain("is_suppressed_role")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("suppression RPC accepts true and false only", async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const expected of [true, false]) {
        globalThis.fetch = (async () => new Response(JSON.stringify(expected), { status: 200 })) as typeof fetch
        const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
        expect(await store.isSuppressed({ userId: "u1", job: suppressionTestJob() })).toBe(expected)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("legacy role suppression retries a 502 and preserves a true result", async () => {
    const originalFetch = globalThis.fetch
    const retry = suppressionRetryDependencies()
    const statuses: number[] = []
    try {
      globalThis.fetch = (async () => {
        statuses.push(statuses.length ? 200 : 502)
        return new Response(statuses.length === 1 ? "temporary gateway failure" : "true", { status: statuses.at(-1) })
      }) as typeof fetch
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret", undefined, retry.dependencies)
      expect(await store.isSuppressed({ userId: "u1", job: suppressionTestJob() })).toBe(true)
      expect(statuses).toEqual([502, 200])
      expect(retry.delays).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("suppression retries 503/504 responses and preserves false results", async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const status of [503, 504]) {
        let calls = 0
        globalThis.fetch = (async () => {
          calls += 1
          return calls === 1 ? new Response("temporary service error", { status }) : new Response("false", { status: 200 })
        }) as typeof fetch
        const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret", undefined, suppressionRetryDependencies().dependencies)
        expect(await store.isSuppressed({ userId: "u1", job: suppressionTestJob() })).toBe(false)
        expect(calls).toBe(2)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("two transient suppression errors recover on the third attempt with bounded backoff", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    const retry = suppressionRetryDependencies()
    try {
      globalThis.fetch = (async () => {
        calls += 1
        return calls < 3 ? new Response("temporary", { status: calls === 1 ? 502 : 503 }) : new Response("true", { status: 200 })
      }) as typeof fetch
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret", undefined, retry.dependencies)
      expect(await store.isSuppressed({ userId: "u1", job: suppressionTestJob() })).toBe(true)
      expect(calls).toBe(3)
      expect(retry.delays).toEqual([125, 225])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("exhausted 502 retries reject instead of treating the job as unsuppressed", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    const retry = suppressionRetryDependencies()
    try {
      globalThis.fetch = (async () => {
        calls += 1
        return new Response(JSON.stringify({ message: "gateway failure" }), { status: 502 })
      }) as typeof fetch
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret", undefined, retry.dependencies)
      await expect(store.isSuppressed({ userId: "u1", job: suppressionTestJob() })).rejects.toThrow("HTTP 502")
      expect(calls).toBe(3)
      expect(retry.delays).toEqual([125, 225])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("suppression diagnostics are structured and exclude listing/profile arguments", async () => {
    const originalFetch = globalThis.fetch
    const originalWrite = process.stderr.write
    const output: string[] = []
    try {
      process.stderr.write = ((chunk: string | Uint8Array) => { output.push(String(chunk)); return true }) as typeof process.stderr.write
      let calls = 0
      globalThis.fetch = (async () => {
        calls += 1
        return calls === 1 ? new Response("temporary", { status: 502 }) : new Response("true", { status: 200 })
      }) as typeof fetch
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret", undefined, suppressionRetryDependencies().dependencies)
      expect(await store.isSuppressed({ userId: "private-user", job: suppressionTestJob() })).toBe(true)
      const diagnostics = output.map((line) => JSON.parse(line)).filter((item) => item.event === "application_suppression_rpc")
      expect(diagnostics.map((item) => item.outcome)).toEqual(["retrying", "transient_error_recovered"])
      expect(diagnostics[0]).toMatchObject({
        operation_name: "application_suppression_check", attempt_number: 1, max_attempts: 3,
        safe_http_status: 502, retryable: true, retry_delay_ms: 125, retries_exhausted: false,
      })
      expect(output.join(" ")).not.toContain("private-user")
      expect(output.join(" ")).not.toContain("suppression-1")
      expect(output.join(" ")).not.toContain("Acme")
    } finally {
      globalThis.fetch = originalFetch
      process.stderr.write = originalWrite
    }
  })

  test("unresolved suppression errors fail the run before associations are written", async () => {
    const store = new MemoryStore()
    store.isSuppressed = async () => { throw new Error("suppression unavailable") }
    const job = raw({ id: "unresolved-suppression", title: "Security Engineer", company: "Acme", url: "https://jobs.example/unresolved-suppression" })
    await expect(runGenericDiscovery({
      mode: "broad", profile: profiles.security, store,
      sourceRunners: [runner("jobgether-search", [job])],
      validator: async (jobs) => ({ all: jobs.map((item) => ({ ...item, validation: { status: "active" as const, method: "source_detail" as const, confidence: 95, checkedAt: "2026-10-07T10:00:00Z" } })), results: jobs }),
      enricher: async (jobs) => ({ jobs, stats: { considered: jobs.length, attempted: 0, success: 0, cacheHits: 0, notNeeded: jobs.length, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }),
    })).rejects.toThrow("checking application suppression")
    expect(store.rows).toHaveLength(1)
    expect(store.associations).toHaveLength(0)
    expect(store.finished).toMatchObject({ status: "failed" })
  })

  test("timeout and temporary network errors are retried", async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const failure of [new DOMException("request timed out", "TimeoutError"), new TypeError("network unavailable")]) {
        let calls = 0
        globalThis.fetch = (async () => {
          calls += 1
          if (calls === 1) throw failure
          return new Response("true", { status: 200 })
        }) as typeof fetch
        const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret", undefined, suppressionRetryDependencies().dependencies)
        expect(await store.isSuppressed({ userId: "u1", job: suppressionTestJob() })).toBe(true)
        expect(calls).toBe(2)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("400, 401, 403 and missing RPC errors are not retried", async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const response of [
        new Response("bad request", { status: 400 }),
        new Response("function error", { status: 500 }),
        new Response("unauthorized", { status: 401 }),
        new Response(JSON.stringify({ code: "42501" }), { status: 403 }),
        new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 }),
      ]) {
        let calls = 0
        globalThis.fetch = (async () => { calls += 1; return response.clone() }) as typeof fetch
        const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret", undefined, suppressionRetryDependencies().dependencies)
        await expect(store.isSuppressed({ userId: "u1", job: suppressionTestJob() })).rejects.toThrow()
        expect(calls).toBe(1)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("null and malformed successful responses fail closed without retry", async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const body of ["null", '"true"', "not-json"]) {
        let calls = 0
        globalThis.fetch = (async () => { calls += 1; return new Response(body, { status: 200 }) }) as typeof fetch
        const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret", undefined, suppressionRetryDependencies().dependencies)
        await expect(store.isSuppressed({ userId: "u1", job: suppressionTestJob() })).rejects.toThrow()
        expect(calls).toBe(1)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("suppression retry deadline and exponential delay stay bounded", async () => {
    const originalFetch = globalThis.fetch
    const retry = suppressionRetryDependencies()
    let calls = 0
    try {
      globalThis.fetch = (async () => {
        calls += 1
        retry.advance(7_900)
        throw new TypeError("connection reset")
      }) as typeof fetch
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret", undefined, retry.dependencies)
      await expect(store.isSuppressed({ userId: "u1", job: suppressionTestJob() })).rejects.toThrow()
      expect(calls).toBe(1)
      expect(retry.delays).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("parallel suppression retries stay bounded and make no business writes", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1
        expect(init?.method).toBe("POST")
        expect(String(_input)).toContain("/rpc/is_suppressed_role")
        return calls <= 8 ? new Response("temporary", { status: 503 }) : new Response("false", { status: 200 })
      }) as typeof fetch
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret", undefined, suppressionRetryDependencies().dependencies)
      const results = await Promise.all(Array.from({ length: 8 }, () => store.isSuppressed({ userId: "u1", job: suppressionTestJob() })))
      expect(results).toEqual(Array(8).fill(false))
      expect(calls).toBe(16)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("bulk run associations preserve every consolidated job context in bounded chunks", async () => {
    const originalFetch = globalThis.fetch
    const batches: any[][] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      batches.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      const associations = Array.from({ length: 111 }, (_, index) => ({
        runId: 77,
        jobId: index + 1,
        outcome: "rediscovered" as const,
        context: { source: `source-${index}`, identity_observation: { index } },
      }))
      await store.associateRunJobs(associations)

      expect(batches.map((batch) => batch.length)).toEqual([50, 50, 11])
      expect(batches.flat()).toHaveLength(associations.length)
      expect(batches[0][0]).toMatchObject({
        search_run_id: 77,
        job_id: 1,
        discovery_context: { outcome: "rediscovered", source: "source-0", identity_observation: { index: 0 } },
      })
      expect(batches[2][10].job_id).toBe(111)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("falls back to legacy jobs REST persistence only when the Phase 1E resolver RPC is absent", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; method: string; body: any }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : null
      requests.push({ url, method, body })
      if (url.includes("resolve_job_source_observation")) {
        return new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 })
      }
      if (url.endsWith("/rest/v1/jobs")) return new Response(JSON.stringify([{ id: 42 }]), { status: 201 })
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      const job = normalizeDiscoveredJob(raw({ id: "backend-1", title: "Backend Engineer", company: "Acme", url: "https://jobs.example/1" }), "mock")!
      expect(await store.upsertJob({ job, existing: undefined, now: "2026-10-07T10:00:00Z" })).toEqual({ id: 42, created: true, physicalIdentityMode: "legacy_compatibility" })
      expect(requests.map(({ method }) => method)).toEqual(["POST", "POST"])
      expect(requests[1].body).toMatchObject({ title: "Backend Engineer", company: "Acme" })
      expect(requests[1].body).not.toHaveProperty("first_seen_at")
      expect(requests[1].body).not.toHaveProperty("last_seen_at")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not mask resolver permission or validation failures with legacy persistence", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ code: "42501" }), { status: 403 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      const job = normalizeDiscoveredJob(raw({ id: "backend-2", title: "Backend Engineer", company: "Acme", url: "https://jobs.example/2" }), "mock")!
      await expect(store.upsertJob({ job, existing: undefined, now: "2026-10-07T10:00:00Z" })).rejects.toThrow("Supabase POST jobs via rpc/resolve_job_source_observation failed (HTTP 403, SQLSTATE 42501)")
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not treat an internal resolver operator error as missing Phase 1E schema", async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ code: "42883", message: "operator does not exist: text ->> unknown" }), { status: 400 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      const job = normalizeDiscoveredJob(raw({ id: "backend-operator", title: "Backend Engineer", company: "Acme", url: "https://jobs.example/operator" }), "mock")!
      await expect(store.upsertJob({ job, existing: undefined, now: "2026-10-07T10:00:00Z" })).rejects.toThrow("SQLSTATE 42883")
      expect(requests).toHaveLength(1)
      expect(requests[0]).toContain("resolve_job_source_observation")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("source URL uniqueness collision is isolated as an identity conflict", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({
        code: "23505",
        message: 'duplicate key value violates unique constraint "jobs_source_source_url_key"',
      }), { status: 409 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      const job = normalizeDiscoveredJob(raw({ id: "collision", title: "Security Engineer", company: "Acme", url: "https://jobs.example/collision" }), "mock")!
      expect(await store.upsertJob({ job, existing: undefined, now: "2026-10-08T10:00:00Z" })).toEqual({
        id: null, created: false, identityConflict: true, physicalIdentityMode: "canonical",
      })
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("legacy jobs write isolates a source URL collision after the resolver is unavailable", async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("resolve_job_source_observation")) {
        return new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 })
      }
      return new Response(JSON.stringify({
        code: "23505",
        message: 'duplicate key value violates unique constraint "jobs_source_source_url_key"',
      }), { status: 409 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      const job = normalizeDiscoveredJob(raw({ id: "legacy-collision", title: "Security Engineer", company: "Acme", url: "https://jobs.example/legacy" }), "mock")!
      expect(await store.upsertJob({ job, existing: undefined, now: "2026-10-08T10:00:00Z" })).toEqual({
        id: null, created: false, identityConflict: true, physicalIdentityMode: "legacy_compatibility",
      })
      expect(requests).toHaveLength(2)
      expect(requests[1].endsWith("/rest/v1/jobs")).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("unrelated unique violations still fail discovery persistence", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: "23505",
      message: 'duplicate key value violates unique constraint "unrelated_unique_key"',
    }), { status: 409 })) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      const job = normalizeDiscoveredJob(raw({ id: "other-collision", title: "Security Engineer", company: "Acme", url: "https://jobs.example/other" }), "mock")!
      await expect(store.upsertJob({ job, existing: undefined, now: "2026-10-08T10:00:00Z" })).rejects.toThrow("unrelated_unique_key")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("one identity collision does not abort the remaining listings", async () => {
    const store = new MemoryStore()
    const originalUpsert = store.upsertJob.bind(store)
    store.upsertJob = async (input: any) => input.job.sourceJobId === "collision"
      ? { id: null, created: false, identityConflict: true, physicalIdentityMode: "canonical" } as any
      : originalUpsert(input)
    const jobs = [
      raw({ id: "collision", title: "Security Engineer", company: "Acme", url: "https://jobs.example/collision" }),
      raw({ id: "valid", title: "Senior Security Engineer", company: "Acme", url: "https://jobs.example/valid" }),
    ]
    const result = await runGenericDiscovery({
      mode: "broad", profile: profiles.security, userId: "u1", store, sourceRunners: [runner("mock", jobs)],
      atsRunner: async () => ({ stats: { ...emptyAtsStats, boardsCrawled: 0 }, results: [], jobs: [] }),
      validator: async (items) => ({ all: items.map((item) => ({ ...item, validation: { status: "active" as const, method: "source_detail" as const, confidence: 95, checkedAt: "2026-10-08T10:00:00Z" } })), results: items }),
      enricher: async (items) => ({ jobs: items, stats: { considered: items.length, attempted: 0, success: 0, cacheHits: 0, notNeeded: items.length, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }),
    })
    expect(result.processedJobIds).toHaveLength(1)
    expect(store.finished).toMatchObject({ status: "partial" })
    expect(result.stats.errors).toContainEqual({ source: "mock", message: "Physical identity conflict or source URL collision; listing skipped for reconciliation." })
  })

  test("database diagnostics retain SQLSTATE and constraint without echoing row details", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: "23514",
      message: 'new row for relation "jobs" violates check constraint "jobs_check"',
      details: 'Rejected payload contains private JD text',
    }), { status: 400 })) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      await expect(store.loadJobs()).rejects.toThrow("Supabase GET jobs failed (HTTP 400, SQLSTATE 23514, constraint jobs_check)")
      await expect(store.loadJobs()).rejects.not.toThrow("private JD text")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("loadJobs paginates beyond the API's default row limit", async () => {
    const originalFetch = globalThis.fetch
    const requested: string[] = []
    const selected: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url.searchParams.get("id") ?? "")
      selected.push(url.searchParams.get("select") ?? "")
      const lastId = Number((url.searchParams.get("id") ?? "gt.0").slice(3))
      const rows = Array.from({ length: Math.min(500, 1002 - lastId) }, (_, index) => ({ id: lastId + index + 1 }))
      return new Response(JSON.stringify(rows), { status: 200 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      const rows = await store.loadJobs()
      expect(rows).toHaveLength(1002)
      expect(rows.at(-1)?.id).toBe(1002)
      expect(requested).toEqual(["gt.0", "gt.500", "gt.1000"])
      expect(selected.every((columns) => columns === "id,source,source_job_id,source_url,application_url,company,title,location,remote_scope,employment_type,description,description_kind,posted_at,availability_status")).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("selected evidence jobs are fetched by ID even beyond the first page", async () => {
    const originalFetch = globalThis.fetch
    let requested = ""
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested = url.searchParams.get("id") ?? ""
      return new Response(JSON.stringify([{ id: 1079 }, { id: 1246 }]), { status: 200 })
    }) as typeof fetch
    try {
      const rows = await new SupabaseDiscoveryStore("https://example.supabase.co", "secret").loadJobsByIds([1246, 1079])
      expect(requested).toBe("in.(1246,1079)")
      expect(rows.map((row) => row.id)).toEqual([1079, 1246])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("persistence failure records stage/constraint and marks the run failed without logging details", async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ path: string; method: string; body: any }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ path, method, body })
      if (path.includes("/rpc/is_suppressed_job")) return new Response("false", { status: 200 })
      if (path.endsWith("/search_runs") && method === "POST") return new Response(JSON.stringify([{ id: 77 }]), { status: 201 })
      if (path.includes("/rest/v1/jobs?") && method === "GET") return new Response("[]", { status: 200 })
      if (path.includes("/rpc/resolve_job_source_observation")) return new Response(JSON.stringify({
        code: "23514", message: 'new row for relation "jobs" violates check constraint "jobs_check"',
        details: "PRIVATE DESCRIPTION MUST NOT BE LOGGED",
      }), { status: 400 })
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const store = new SupabaseDiscoveryStore("https://example.supabase.co", "secret")
      const job = raw({ id: "diagnostic-job", title: "Security Engineer", company: "Acme", url: "https://example.test/diagnostic" })
      const failed = runGenericDiscovery({
        mode: "broad", profile: profiles.security, userId: "u1", store, sourceRunners: [runner("mock", [job])],
        atsRunner: async () => ({ stats: { ...emptyAtsStats, boardsCrawled: 0 }, results: [], jobs: [] }),
        validator: async (items) => ({ all: items.map((item) => ({ ...item, validation: { status: "active" as const, method: "source_detail" as const, confidence: 95, checkedAt: "2026-10-07T10:00:00Z" } })), results: items }),
        enricher: async (items) => ({ jobs: items, stats: { considered: items.length, attempted: 0, success: 0, cacheHits: 0, notNeeded: items.length, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }),
      })
      try { await failed; throw new Error("expected discovery persistence failure") } catch (error) {
        expect(String(error)).toContain("jobs_check")
        expect(String(error)).not.toContain("PRIVATE DESCRIPTION")
      }
      const failedRun = calls.find((call) => call.path.includes("/search_runs?id=eq.77") && call.method === "PATCH")
      expect(failedRun?.body.status).toBe("failed")
      expect(failedRun?.body.error_message).toContain("jobs_check")
      expect(JSON.stringify(failedRun?.body)).not.toContain("PRIVATE DESCRIPTION")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("an explicit evidence retry bypasses only the availability cache", () => {
    const now = new Date("2026-10-06T10:00:00Z")
    expect(evidenceValidationOptions(now)).toEqual({ includeUnvalidated: true, now, useCache: true })
    expect(evidenceValidationOptions(now, true)).toEqual({ includeUnvalidated: true, now, useCache: false })
  })

  test("an explicit evidence retry enriches a full JD whose remote scope is still missing", async () => {
    const longDescription = "Responsibilities: Lead application security reviews, design practical controls, implement improvements, support product teams, assess vulnerabilities, respond to incidents, and maintain risk registers. Qualifications: Collaborate with engineering teams, communicate clearly, own delivery, establish sustainable security practices, prioritize competing requests, document decisions, and help product groups reduce measurable risk. ".repeat(2)
    const input = normalizeDiscoveredJob(raw({
      id: "scope-gap",
      title: "Security Engineer",
      company: "Scope Gap Co",
      url: "https://example.test/scope-gap",
      location: "Remote",
      remoteScope: "Remote",
      description: longDescription,
      descriptionKind: "full",
    }), "test")!
    let enrichedCount = 0
    const result = await verifyAndHydrateDiscoveredJobs([input], profiles.security, {
      forceRevalidate: true,
      validator: async (jobs) => ({
        all: jobs.map((item) => ({ ...item, validation: { status: "active" as const, method: "page_content" as const, confidence: 90, checkedAt: "2026-10-06T00:00:00Z" } })),
        results: jobs,
      }),
      enricher: async (jobs) => {
        enrichedCount += jobs.length
        return { jobs: jobs.map((item) => ({ ...item, location: "Remote Europe", remoteScope: "Remote Europe" })), stats: { considered: jobs.length, attempted: jobs.length, success: jobs.length, cacheHits: 0, notNeeded: 0, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }
      },
    })
    expect(enrichedCount).toBe(1)
    expect(result.jobs[0].location).toBe("Remote Europe")
  })

  test("builds targeted and broad terms from any profession SearchProfile", () => {
    expect(buildSearchQueries(profiles.accounting, "targeted")).toEqual(["Accountant"])
    expect(buildSearchQueries(profiles.accounting, "broad")).toEqual(["Accountant", "Financial Controller", "SaaS"])
    expect(buildSearchQueries(profiles.software, "broad")).toEqual(["Software Engineer", "Backend Engineer", "Backend Developer", "Python Developer", "Python", "Backend Engineering"])
    expect(buildSearchQueries(profiles.security, "targeted")).not.toContain("DevOps Engineer")
    expect(buildSearchQueries(profiles.security, "broad")).toEqual(expect.arrayContaining(profiles.security.definition.target_adjacent_terms))
    expect(buildSearchQueries(profiles.security, "broad")).not.toContain("SOC")
  })

  test("attributes broad results to targeted and broad-only query groups", () => {
    expect(queryGroupsForMatches(
      ["Security Lead", "Cloud Security", "Security Lead"],
      ["Security Lead"],
    )).toEqual({
      queries: ["Security Lead", "Cloud Security"],
      groups: ["targeted", "broad_only"],
    })
  })

  test("search-run association consolidates source observations instead of overwriting provenance", () => {
    const contexts = [
      { source: "linkedin", identity_observation: { source: "linkedin", source_job_id: "li-1" }, eligibility_outcome: "actionable" },
      { source: "jobgether", identity_observation: { source: "jobgether", source_job_id: "jg-1" }, eligibility_outcome: "actionable" },
      { source: "ashby", identity_observation: { source: "ashby", source_job_id: "ashby-1" }, eligibility_outcome: "actionable" },
    ]
    expect(consolidateRunJobObservationContexts(contexts)).toMatchObject({
      source: "ashby",
      source_observations: contexts.map((item) => item.identity_observation),
      observations: contexts,
    })
  })

  test("uses stable source identity and distinguishes different requisitions", () => {
    const a = normalizeDiscoveredJob(raw({ id: "a", title: "Role", company: "Co", url: "https://x/jobs/a" }), "source")!
    const same = normalizeDiscoveredJob(raw({ id: "a", title: "Role", company: "Co", url: "https://x/jobs/a?utm_source=x" }), "source")!
    const different = normalizeDiscoveredJob(raw({ id: "b", title: "Role", company: "Co", url: "https://x/jobs/b" }), "source")!
    expect(discoveryKey(a)).toBe(discoveryKey(same))
    expect(discoveryKey(a)).not.toBe(discoveryKey(different))
  })

  test("structured source metadata wins over page headings and JSON-LD recovers malformed headings", () => {
    const source = resolveJobMetadata({
      sourceType: "ats", title: "Security Engineer", company: "Pliant", pageTitle: "ABOUT US",
      jsonLd: { title: "Wrong fallback", hiringOrganization: { name: "Wrong fallback" } },
    })
    expect(source).toMatchObject({ title: "Security Engineer", company: "Pliant", issues: [] })

    const jsonLd = normalizeDiscoveredJob(raw({
      id: "pliant", title: "ABOUT US", company: "US", url: "https://example.test/job",
      jsonLd: { "@type": "JobPosting", title: "Security Engineer", hiringOrganization: { name: "Pliant" } },
    }), "source")!
    expect(jsonLd).toMatchObject({ title: "Security Engineer", company: "Pliant", metadataIssues: [] })
    expect(discoveredMetadataIsSane(jsonLd.company, jsonLd.title)).toBe(true)

    const sectionHeading = normalizeDiscoveredJob(raw({
      id: "mission-heading", title: "Our Mission", company: "Swapcard", url: "https://example.test/mission",
      pageTitle: "Our Mission",
    }), "source")!
    expect(sectionHeading.metadataIssues).toContain("title_is_page_heading")

    expect(resolveJobMetadata({
      sourceType: "aggregator", title: "Our Mission", company: "Swapcard",
      jsonLd: { title: "Security Engineer - SecOps & Cloud", hiringOrganization: { name: "Swapcard" } },
    })).toMatchObject({ title: "Security Engineer - SecOps & Cloud", company: "Swapcard", issues: [] })
  })

  test("authoritative posting metadata outranks aggregator fields while ATS fields stay primary", () => {
    expect(resolveJobMetadata({
      sourceType: "aggregator", title: "ABOUT US", company: "US",
      jobPosting: { title: "Security Engineer", hiringOrganization: { name: "Pliant" } },
    })).toMatchObject({ title: "Security Engineer", company: "Pliant", issues: [] })
    expect(resolveJobMetadata({
      sourceType: "ats", title: "Security Engineer", company: "Pliant",
      jobPosting: { title: "Wrong title", hiringOrganization: { name: "Wrong employer" } },
    })).toMatchObject({ title: "Security Engineer", company: "Pliant", issues: [] })
  })

  test("generic headings and geography-only company values block actionability without changing lifecycle", () => {
    const malformed = normalizeDiscoveredJob(raw({
      id: "bad-meta", title: "ABOUT US", company: "US", url: "https://example.test/bad",
    }), "source")!
    malformed.validation = { status: "active", method: "source_detail", confidence: 100, checkedAt: "2026-10-05T00:00:00Z" }
    const result = evaluateFinalJobEligibility(malformed, profiles.security)
    expect(result.metadata_unresolved).toBe(true)
    expect(result.metadata_issues).toEqual(expect.arrayContaining([
      "company_is_geographic_or_navigation_token", "title_is_page_heading",
    ]))
    expect(result.actionable).toBe(false)
    expect(malformed.validation.status).toBe("active")

    const corrected = normalizeDiscoveredJob(raw({
      id: "good-meta", title: "Security Engineer", company: "Pliant", url: "https://example.test/good",
    }), "source")!
    corrected.validation = malformed.validation
    expect(evaluateFinalJobEligibility(corrected, profiles.security).actionable).toBe(true)
  })

  test("missing discovered metadata is retained with explicit placeholders and cannot become actionable", () => {
    const job = normalizeDiscoveredJob(raw({ id: "missing-meta", title: "", company: "", url: "https://example.test/missing" }), "source")!
    job.validation = { status: "active", method: "source_detail", confidence: 100, checkedAt: "2026-10-05T00:00:00Z" }
    expect(job).toMatchObject({ company: "Unknown company", title: "Untitled role" })
    const result = evaluateFinalJobEligibility(job, profiles.security)
    expect(result.metadata_unresolved).toBe(true)
    expect(result.metadata_issues).toEqual(expect.arrayContaining(["company_missing", "title_missing"]))
    expect(result.actionable).toBe(false)
    expect(job.validation.status).toBe("active")
  })

  test("short company names and legitimate titles containing generic words pass sanity", () => {
    expect(discoveredMetadataIsSane("AI", "Head of Careers")).toBe(true)
    expect(discoveredMetadataIsSane("US Foods", "Director, Who We Are")).toBe(true)
    expect(discoveredMetadataIsSane("Crown Holdings, Inc.", "Security Engineer")).toBe(true)
    expect(discoveredMetadataIsSane("OVS S.p.A.", "Security Engineer")).toBe(true)
  })

  test("same job across targeted/broad runs and repeated discovery deduplicates", () => {
    const job = normalizeDiscoveredJob(raw({ id: "1", title: "Accountant", company: "Co", url: "https://x/jobs/1" }), "source")!
    expect(mergeDiscoveredJobs([job, job])).toHaveLength(1)
  })

  test("full descriptions are never replaced by snippets and first_seen is preserved", () => {
    const full = normalizeDiscoveredJob(raw({ id: "1", title: "Role", company: "Co", url: "https://x/jobs/1" }), "source")!
    const snippet = normalizeDiscoveredJob(raw({ id: "1", title: "Role", company: "Co", url: "https://x/jobs/1", description: "short" }), "source")!
    const payload = mergePersistedJobPayload(snippet, { id: 1, description: full.description, description_kind: "full" }, "2026-10-04T10:00:00Z")
    expect(payload.description).toBeUndefined()
    expect(payload.last_seen_at).toBe("2026-10-04T10:00:00Z")
  })

  test("new inserts leave initial timestamps to the database; delayed existing refreshes advance last_seen", () => {
    const job = normalizeDiscoveredJob(raw({ id: "delayed", title: "Security Engineer", company: "Co", url: "https://x/delayed" }), "source")!
    const runStarted = "2026-10-07T10:00:00.000Z"
    const insertedAt = "2026-10-07T10:05:09.000Z"
    const insertPayload = mergePersistedJobPayload(job, {}, runStarted)
    expect(insertPayload).not.toHaveProperty("first_seen_at")
    expect(insertPayload).not.toHaveProperty("last_seen_at")
    // PostgreSQL applies both now() defaults in the insert statement, after processing.
    const insertedRow = { first_seen_at: insertedAt, last_seen_at: insertedAt }
    expect(Date.parse(insertedRow.last_seen_at)).toBeGreaterThanOrEqual(Date.parse(insertedRow.first_seen_at))

    const existingPayload = mergePersistedJobPayload(job, { id: 9 }, insertedAt)
    expect(existingPayload.last_seen_at).toBe(insertedAt)
    expect(existingPayload).not.toHaveProperty("first_seen_at")
  })

  test("source completeness is based on substantive content rather than the 400-character marker", () => {
    const compact = "Responsibilities: Lead security reviews, design controls, implement improvements, support teams, and assess risk. Qualifications: Communicate clearly, collaborate broadly, and own delivery. ".repeat(3)
    const valid = normalizeDiscoveredJob(raw({ id: "compact", title: "Security Engineer", company: "Co", url: "https://x/compact", description: compact, descriptionKind: "snippet" }), "source")!
    const teaser = normalizeDiscoveredJob(raw({ id: "teaser", title: "Security Engineer", company: "Co", url: "https://x/teaser", description: "Join our team to help build innovative products and improve security across the company. ".repeat(8), descriptionKind: "full" }), "source")!
    expect(valid.descriptionKind).toBe("full")
    expect(teaser.descriptionKind).toBe("snippet")
  })

  test("JD completeness does not change independently verified lifecycle state", () => {
    const liveWithoutDetails = normalizeDiscoveredJob(raw({ id: "1", title: "Role", company: "Co", url: "https://x/jobs/1", description: "", descriptionKind: "missing" }), "source")!
    liveWithoutDetails.validation = { status: "active", method: "ats_api", confidence: 100, checkedAt: "2026-10-04T10:00:00Z" }
    const payload = mergePersistedJobPayload(liveWithoutDetails, {}, "2026-10-04T10:00:00Z")
    expect(payload.description_kind).toBe("missing")
    expect(payload.availability_status).toBe("active")

    const verificationPending = { ...liveWithoutDetails, validation: { ...liveWithoutDetails.validation, status: "uncertain" as const } }
    const pendingPayload = mergePersistedJobPayload(verificationPending, {}, "2026-10-04T10:00:00Z")
    expect(pendingPayload.availability_status).toBe("unknown")
  })

  test("profile exclusions and remote constraints are generic", () => {
    const analyst = normalizeDiscoveredJob(raw({ id: "1", title: "Accountant Analyst", company: "Co", url: "https://x/1" }), "source")!
    expect(passesSearchProfile(analyst, profiles.security)).toBe(false)
    const remote = normalizeDiscoveredJob(raw({ id: "2", title: "Accountant", company: "Co", url: "https://x/2", location: "On-site" }), "source")!
    const remoteProfile = { ...profiles.accounting, definition: { ...profiles.accounting.definition, work_models: ["remote"] } }
    expect(passesSearchProfile(remote, remoteProfile)).toBe(false)
    const soc2Mention = normalizeDiscoveredJob(raw({ id: "3", title: "Security Engineer", company: "Co", url: "https://x/3", description: "Build secure controls aligned to SOC 2 and partner with engineering. " + "Responsibilities include secure system design and collaboration. ".repeat(8) }), "source")!
    expect(passesSearchProfile(soc2Mention, profiles.security)).toBe(true)
    const unrelated = normalizeDiscoveredJob(raw({ id: "unrelated", title: "Software Engineer", company: "Co", url: "https://x/unrelated" }), "source")!
    expect(passesSearchProfile(unrelated, profiles.security)).toBe(false)
  })

  test("role matching and exclusions are configured per SearchProfile", () => {
    expect(classifyTargetRole("Senior Security Engineer", profiles.security)).toBe("target_match")
    expect(classifyTargetRole("Lead Application Security Engineer", profiles.security)).toBe("target_match")
    expect(classifyTargetRole("Product Security Engineer", profiles.security)).toBe("target_match")
    expect(classifyTargetRole("DevOps & Security Engineer", profiles.security)).toBe("target_match")
    expect(classifyTargetRole("DevOps Engineer", profiles.security)).toBe("target_adjacent")
    expect(classifyTargetRole("Senior Software Engineer", profiles.security)).toBe("unrelated")
    expect(classifyTargetRole("Platform Engineer", profiles.security)).toBe("unrelated")
    expect(classifyTargetRole("Account Executive, Enterprise Expansion", profiles.security)).toBe("unrelated")
    expect(classifyTargetRole("SOAR Developer", profiles.security)).toBe("target_adjacent")
    expect(classifyTargetRole("Staff Software Engineer, PAM", profiles.security)).toBe("target_adjacent")
    expect(classifyTargetRole("Senior Software Engineer (Go) - AI Resilience & Security Enhancements", profiles.security)).toBe("target_adjacent")
    expect(classifyTargetRole("Security Analyst", profiles.security)).toBe("excluded")
    expect(classifyTargetRole("SOC Engineer", profiles.security)).toBe("excluded")
    expect(classifyTargetRole("Security Analyst", { ...profiles.security, definition: { target_titles: ["Security Analyst"] } })).toBe("target_match")
  })

  test("the same role and constraints resolve independently for different SearchProfiles", () => {
    const software = { ...profiles.software, definition: { target_titles: ["Software Engineer", "Backend Engineer", "Platform Engineer"] } }
    const sales = { ...profiles.accounting, definition: { target_titles: ["Account Executive", "Sales", "Business Development"] } }
    const analyst = { ...profiles.security, definition: { target_titles: ["Security Analyst", "Risk Analyst"] } }
    expect(classifyTargetRole("Platform Engineer", profiles.security)).toBe("unrelated")
    expect(classifyTargetRole("Platform Engineer", software)).toBe("target_match")
    expect(classifyTargetRole("Account Executive, Enterprise Expansion", sales)).toBe("target_match")
    expect(classifyTargetRole("Business Development Manager", sales)).toBe("target_match")
    expect(classifyTargetRole("Security Analyst", analyst)).toBe("target_match")

    const remoteUs = normalizeDiscoveredJob(raw({ id: "same-geo", title: "Platform Engineer", company: "Co", url: "https://x/geo", location: "Anywhere in the World", remoteScope: "Worldwide", description: "Remote within the United States only. " + "The role requires experience and you will work with our team. ".repeat(10) }), "source")!
    const europe = { ...software, definition: { ...software.definition, work_models: ["remote"], allowed_regions: ["Europe"] } }
    const unitedStates = { ...software, definition: { ...software.definition, work_models: ["remote"], allowed_countries: ["United States"] } }
    expect(classifyLocationEligibility(remoteUs, europe)).toBe("ineligible")
    expect(classifyLocationEligibility(remoteUs, unitedStates)).toBe("eligible")

    const germanRequired = normalizeDiscoveredJob(raw({ id: "same-language", title: "Platform Engineer", company: "Co", url: "https://x/language", description: "German is required. " + "The role requires experience and you will work with our team. ".repeat(10) }), "source")!
    expect(classifyLanguageEligibility(germanRequired, { ...software, definition: { target_titles: ["Platform Engineer"], accepted_languages: ["English"] } })).toBe("ineligible")
    expect(classifyLanguageEligibility(germanRequired, { ...software, definition: { target_titles: ["Platform Engineer"], accepted_languages: ["German"] } })).toBe("eligible")

    const contract = normalizeDiscoveredJob(raw({ id: "same-contract", title: "Platform Engineer", company: "Co", url: "https://x/contract", employmentType: "Contract" }), "source")!
    expect(classifyEmploymentType(contract, { ...software, definition: { target_titles: ["Platform Engineer"], accepted_employment_types: ["permanent", "full_time"] } })).toBe("ineligible")
    expect(classifyEmploymentType(contract, { ...software, definition: { target_titles: ["Platform Engineer"], accepted_employment_types: ["contract"] } })).toBe("eligible")
  })

  test("current-profile false positives are filtered per profile, not globally", () => {
    const examples = ["Framer Website Designer", "Account Executive", "Full Stack Engineer", "Senior iOS Engineer", "Business Development Manager"]
    const sales = { ...profiles.accounting, definition: { target_titles: ["Account Executive", "Sales", "Business Development"] } }
    for (const title of examples) expect(classifyTargetRole(title, profiles.security)).toBe("unrelated")
    expect(classifyTargetRole("Account Executive", sales)).toBe("target_match")
    expect(classifyTargetRole("Business Development Manager", sales)).toBe("target_match")
  })

  test("restrictive JD location overrides worldwide metadata and missing scope stays unclear", () => {
    const profile = { ...profiles.security, definition: { ...profiles.security.definition, remote_only: true, english_only: true, eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" } } }
    const restricted = normalizeDiscoveredJob(raw({ id: "1", title: "Security Engineer", company: "Co", url: "https://x/1", location: "Anywhere in the World", remoteScope: "Worldwide", description: "This role is remote within the United States only. " + "Build secure systems with our team. ".repeat(10) }), "source")!
    const unknown = normalizeDiscoveredJob(raw({ id: "2", title: "Security Engineer", company: "Co", url: "https://x/2", location: "Vienna", remoteScope: null, description: "Security Engineer role" }), "source")!
    expect(classifyLocationEligibility(restricted, profile)).toBe("ineligible")
    expect(classifyLocationEligibility(unknown, profile)).toBe("unclear")
  })

  test("worldwide preference does not accept an incompatible office country", () => {
    const profile = {
      ...profiles.security,
      definition: {
        ...profiles.security.definition,
        remote_only: true,
        work_models: ["remote"],
        allowed_regions: ["Austria", "EU", "EEA", "EMEA", "Europe", "worldwide"],
        eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" },
      },
    }
    const cityOnly = normalizeDiscoveredJob(raw({
      id: "global-city",
      title: "Security Engineer",
      company: "Global Co",
      url: "https://x/global-city",
      location: "Kuala Lumpur, Malaysia",
      description: "Full description with no work-model statement.",
    }), "source")!

    expect(classifyLocationEligibility(cityOnly, profile)).toBe("ineligible")
    expect(classifyLocationEligibility({ ...cityOnly, remoteScope: "Remote" }, profile)).toBe("ineligible")
  })

  test("multi-region metadata is eligible when Europe is included, but US-only JD restrictions are not", () => {
    const profile = { ...profiles.security, definition: { ...profiles.security.definition, remote_only: true, eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" } } }
    const europeIncluded = normalizeDiscoveredJob(raw({ id: "multi", title: "DevOps & Security Engineer", company: "Co", url: "https://x/multi", location: "Full Remote", remoteScope: "LATAM, Europe, North America, Canada" }), "source")!
    const usOnly = normalizeDiscoveredJob(raw({ id: "us", title: "Security Engineer", company: "Co", url: "https://x/us", location: "Anywhere in the World", remoteScope: "Worldwide", description: "US-based candidates only. " + "Build secure systems with our team. ".repeat(10) }), "source")!
    expect(classifyLocationEligibility(europeIncluded, profile)).toBe("eligible")
    expect(classifyLocationEligibility(usOnly, profile)).toBe("ineligible")
  })

  test("named-country-only and conflicting geographic JD restrictions are handled conservatively", () => {
    const profile = { ...profiles.security, definition: { ...profiles.security.definition, remote_only: true, eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" } } }
    const germanyOnly = normalizeDiscoveredJob(raw({ id: "de", title: "Security Engineer", company: "Co", url: "https://x/de", location: "Remote Germany", remoteScope: "Remote Germany", description: "Candidates located in Germany only. " + "Build secure systems with our team. ".repeat(10) }), "source")!
    const conflict = normalizeDiscoveredJob(raw({ id: "conflict", title: "Security Engineer", company: "Co", url: "https://x/conflict", location: "Anywhere in the World", remoteScope: "Worldwide", description: "Remote within the United States only. Candidates located in Germany only. " + "Build secure systems with our team. ".repeat(10) }), "source")!
    expect(classifyLocationEligibility(germanyOnly, profile)).toBe("ineligible")
    expect(classifyLocationEligibility(conflict, profile)).toBe("ineligible")
  })

  test("remote country-code lists resolve supported regions and explicit US-only text wins before missing-scope uncertainty", () => {
    const profile = { ...profiles.security, definition: { ...profiles.security.definition, remote_only: true, eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" } } }
    const euCodes = normalizeDiscoveredJob(raw({ id: "eu-codes", title: "Security Engineer", company: "Co", url: "https://x/eu", location: "AT, DE, FR", remoteScope: "Full Remote" }), "source")!
    const usOnlyNoRemoteFlag = normalizeDiscoveredJob(raw({ id: "us-restricted", title: "Security Engineer", company: "Co", url: "https://x/us-only", location: "Andover, MA", remoteScope: null, description: "The position applies to candidates located within the United States." }), "source")!
    expect(classifyLocationEligibility(euCodes, profile)).toBe("eligible")
    expect(classifyLocationEligibility(usOnlyNoRemoteFlag, profile)).toBe("ineligible")
  })


  test("final eligibility requires active lifecycle, resolved role/location/language, and a full JD only for Fit readiness", () => {
    const profile = { ...profiles.security, definition: { ...profiles.security.definition, remote_only: true, english_only: true, eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" } } }
    const eligible = normalizeDiscoveredJob(raw({ id: "eligible", title: "Security Engineer", company: "Co", url: "https://x/eligible", location: "AT, DE, FR", remoteScope: "Full Remote" }), "source")!
    eligible.validation = { status: "active", method: "source_detail", confidence: 100, checkedAt: "2026-10-05T00:00:00Z" }
    expect(evaluateFinalJobEligibility(eligible, profile)).toMatchObject({ role: "target_match", location: "eligible", language: "eligible", actionable: true })

    const unresolved = { ...eligible, location: "Vienna", remoteScope: null }
    expect(evaluateFinalJobEligibility(unresolved, profile).actionable).toBe(false)
    const stale = { ...eligible, validation: { ...eligible.validation, status: "unknown" as const } }
    expect(evaluateFinalJobEligibility(stale, profile).actionable).toBe(false)
    const excluded = { ...eligible, title: "Security Analyst" }
    expect(evaluateFinalJobEligibility(excluded, profile).actionable).toBe(false)
  })

  test("a full JD cannot rescue an explicit incompatible geography or non-English posting", () => {
    const profile = { ...profiles.security, definition: { ...profiles.security.definition, remote_only: true, english_only: true, eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" } } }
    const active = { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-05T00:00:00Z" }
    const usOnly = normalizeDiscoveredJob(raw({ id: "us", title: "Security Engineer", company: "Co", url: "https://x/us", location: "Andover, MA", remoteScope: null, description: `The position applies to candidates located within the United States. ${"Security engineering responsibilities. ".repeat(12)}` }), "source")!
    usOnly.validation = active
    expect(evaluateFinalJobEligibility(usOnly, profile)).toMatchObject({ location: "ineligible", actionable: false })
    const german = normalizeDiscoveredJob(raw({ id: "de", title: "Security Engineer", company: "Co", url: "https://x/de", location: "Germany", remoteScope: "Hybrid", description: `Deutsch erforderlich. ${"Sicherheitsverantwortung und Engineering. ".repeat(12)}` }), "source")!
    german.validation = active
    expect(evaluateFinalJobEligibility(german, profile)).toMatchObject({ language: "ineligible", actionable: false })
  })

  test("discovery drops unrelated roles but retains preference mismatches", async () => {
    const store = new MemoryStore()
    let validatorInput: NormalizedJob[] = []
    const result = await runGenericDiscovery({
      mode: "broad",
      profile: { ...profiles.security, definition: { ...profiles.security.definition, remote_only: true, eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" } } },
      sourceRunners: [runner("test", [
        raw({ id: "1", title: "Senior Security Engineer", company: "Good", url: "https://x/1", location: "Remote Europe", remoteScope: "Remote Europe" }),
        raw({ id: "2", title: "Senior Software Engineer", company: "SecurityCo", url: "https://x/2", location: "Remote Europe", remoteScope: "Remote Europe" }),
        raw({ id: "3", title: "SOAR Developer", company: "Co", url: "https://x/3", location: "Remote Europe", remoteScope: "Remote Europe" }),
        raw({ id: "4", title: "Security Engineer", company: "Co", url: "https://x/4", location: "Anywhere in the World", remoteScope: "Worldwide", description: "Remote within the United States only. " + "Build secure systems with our team. ".repeat(10) }),
      ])],
      validator: async (input) => {
        validatorInput = input
        return { all: input.map((job) => ({ ...job, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-05T00:00:00Z" } })), results: input }
      },
      store,
      now: new Date("2026-10-05T00:00:00Z"),
    })
    expect(validatorInput.map((job) => job.id)).toEqual(["1", "3"])
    expect(store.rows.map((row) => row.title)).toEqual(["Senior Security Engineer", "Security Engineer"])
    expect(result.stats.target_matches).toBe(2)
    expect(result.stats.target_adjacent).toBe(0)
    expect(result.stats.unrelated).toBe(2)
    expect(result.stats.location_ineligible).toBe(1)
    expect(result.stats.target_adjacent_sent_for_evidence).toBe(1)
    expect(result.stats.active_actionable).toBe(1)
    expect(result.stats.filtered_irrelevant).toBe(2)
    expect(result.stats.filtered_ineligible).toBe(0)
    expect(result.stats.preference_mismatches_retained).toBe(1)
    expect(store.associations).toHaveLength(2)
    expect(store.associations[1].context).toMatchObject({ eligibility_outcome: "preference_mismatch", preference_mismatch_fields: ["location"] })
    expect(result.sourceDetails[0]).toHaveProperty("target_matches")
    expect(result.sourceDetails[0]).not.toHaveProperty("normalizedJobs")
  })

  test("ambiguous rediscovery preserves prior validation_failed lifecycle", async () => {
    const store = new MemoryStore()
    store.rows.push({
      id: 44, source: "test", source_job_id: "ambiguous-1", source_url: "https://x/ambiguous",
      company: "Co", title: "SOAR Developer", location: "Remote Europe", remote_scope: "Remote Europe",
      description: "A detailed role description", description_kind: "full", availability_status: "validation_failed",
    })
    const result = await runGenericDiscovery({
      mode: "broad",
      profile: { ...profiles.security, definition: { ...profiles.security.definition, remote_only: true, eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" } } },
      sourceRunners: [runner("test", [raw({ id: "ambiguous-1", title: "SOAR Developer", company: "Co", url: "https://x/ambiguous", location: "Remote Europe", remoteScope: "Remote Europe", description: `This role supports Application Security and SOAR automation. ${"Build secure systems and partner with engineering teams. ".repeat(10)}` })])],
      validator: async (jobs) => {
        expect(jobs).toHaveLength(1)
        return { all: jobs.map((job) => ({ ...job, validation: { status: "validation_failed" as const, method: "http" as const, confidence: 0, checkedAt: "2026-10-05T00:00:00Z" } })), results: [] }
      },
      store,
      now: new Date("2026-10-05T00:00:00Z"),
    })
    expect(result.stats.validation_skipped).toBe(0)
    expect(store.rows[0].availability_status).toBe("validation_failed")
    expect(store.associations[0].outcome).toBe("validation_failed")
    expect(store.associations[0].context).toMatchObject({ eligibility_outcome: "eligibility_unclear", eligibility_unclear_fields: expect.arrayContaining(["role"]) })
    expect(result.stats.target_adjacent_sent_for_evidence).toBe(1)
  })

  test("ambiguous role is resolved only by explicit security responsibilities in the hydrated JD", () => {
    expect(classifyTargetRoleAfterDescription("SOAR Developer", "This Security Engineer role builds and operates SOAR security automation.", profiles.security)).toBe("target_match")
    expect(classifyTargetRoleAfterDescription("Abuse Research Engineer", "The role focuses on abuse investigations and trust and safety policy enforcement.", profiles.security)).toBe("unrelated")
    expect(classifyTargetRoleAfterDescription("SOAR Developer", "A cross-functional engineering role with broad responsibilities.", profiles.security)).toBe("unrelated")
  })

  test("only ambiguous jobs are sent to JD hydration; explicit title exclusions stop early", async () => {
    const store = new MemoryStore()
    let validationIds: string[] = []
    let enrichmentCount = 0
    const result = await runGenericDiscovery({
      mode: "broad",
      profile: profiles.security,
      sourceRunners: [runner("test", [
        raw({ id: "amb", title: "SOAR Developer", company: "Co", url: "https://x/amb", description: "", descriptionKind: "missing" }),
        raw({ id: "analyst", title: "Security Analyst", company: "Co", url: "https://x/analyst" }),
        raw({ id: "soc", title: "SOC Engineer", company: "Co", url: "https://x/soc" }),
        raw({ id: "web", title: "Web Designer", company: "Co", url: "https://x/web" }),
      ])],
      validator: async (jobs) => {
        validationIds = jobs.map((job) => String(job.id))
        return { all: jobs.map((job) => ({ ...job, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-05T00:00:00Z" } })), results: jobs }
      },
      enricher: async (jobs) => {
        enrichmentCount += jobs.length
        return { jobs, stats: { considered: jobs.length, attempted: jobs.length, success: 0, cacheHits: 0, notNeeded: 0, notSupported: jobs.length, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }
      },
      store,
      now: new Date("2026-10-05T00:00:00Z"),
    })
    expect(validationIds).toEqual(["amb"])
    expect(enrichmentCount).toBe(1)
    expect(result.stats.early_preference_exclusions).toBe(2)
    expect(result.stats.early_unrelated_exclusions).toBe(1)
    expect(result.stats.fit_ready).toBe(0)
  })

  test("security and non-security ambiguous roles are resolved from hydrated JDs without changing liveness", async () => {
    const input = [
      raw({ id: "security-scope", title: "SOAR Developer", company: "Co", url: "https://x/security", location: "Remote Europe", remoteScope: "Remote Europe", description: "", descriptionKind: "missing" }),
      raw({ id: "business-scope", title: "Abuse Research Engineer", company: "Co", url: "https://x/business", location: "Remote Europe", remoteScope: "Remote Europe", description: "", descriptionKind: "missing" }),
    ]
    const result = await runGenericDiscovery({
      mode: "broad",
      profile: { ...profiles.security, definition: { ...profiles.security.definition, target_adjacent_terms: ["SOAR Developer", "Abuse Research Engineer"], remote_only: true, eligibility_constraints: { remote_scope: "Europe/EMEA" } } },
      sourceRunners: [runner("test", input)],
      validator: async (jobs) => ({ all: jobs.map((job) => ({ ...job, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-05T00:00:00Z" } })), results: jobs }),
      enricher: async (jobs) => ({
        jobs: jobs.map((job) => ({
          ...job,
          description: job.id === "security-scope"
            ? `Responsibilities: This Security Engineer role builds and operates SOAR security automation and incident response workflows. Own detection programs, design response procedures, implement safeguards, support product teams, assess operational risks, and maintain reliable services. Qualifications: Collaborate with engineering, communicate findings clearly, document decisions, and improve processes. English is required for daily collaboration with international teams.`
            : `Responsibilities: Focus on abuse investigations and trust and safety policy enforcement. Coordinate cases, research harmful behavior, develop policy guidance, review reports, protect platform users, support operations teams, and maintain consistent case records. Qualifications: Communicate clearly, manage investigations with care, document outcomes, and collaborate across teams. English is required for daily collaboration with international teams.`,
          descriptionKind: "full",
        })),
        stats: { considered: 2, attempted: 2, success: 2, cacheHits: 0, notNeeded: 0, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} },
      }),
      now: new Date("2026-10-05T00:00:00Z"),
    })
    expect(result.stats.role_resolved_after_jd).toBe(2)
    expect(result.stats.final_actionable).toBe(1)
    expect(result.stats.fit_ready).toBe(1)
    expect(result.jobs.every((job) => job.validation?.status === "active")).toBe(true)
  })

  test("unknown-location security job verifies and hydrates before final eligibility and Fit readiness", async () => {
    const profile = { ...profiles.security, definition: { ...profiles.security.definition, remote_only: true, english_only: true, eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" } } }
    const input = raw({ id: "emea", title: "Security Engineer", company: "Co", url: "https://x/emea", location: "Vienna", remoteScope: null, description: "", descriptionKind: "missing" })
    let validated: NormalizedJob[] = []
    let hydrated: NormalizedJob[] = []
    const result = await runGenericDiscovery({
      mode: "broad",
      profile,
      sourceRunners: [runner("test", [input])],
      validator: async (jobs) => {
        validated = jobs
        return { all: jobs.map((job) => ({ ...job, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-05T00:00:00Z" } })), results: jobs }
      },
      enricher: async (jobs) => {
        hydrated = jobs
        const description = `Responsibilities: This is a full remote security engineering role across EMEA. Build secure systems, design security controls, lead assessments, implement improvements, partner with engineering, respond to incidents, protect customer data, and maintain risk documentation. Qualifications: Communicate clearly, collaborate across teams, own delivery, share progress with stakeholders, and improve established procedures. English is required for daily collaboration with international teams.`
        return { jobs: jobs.map((job) => ({ ...job, description, descriptionKind: "full", location: "Remote EMEA" })), stats: { considered: 1, attempted: 1, success: 1, cacheHits: 0, notNeeded: 0, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} } }
      },
      now: new Date("2026-10-05T00:00:00Z"),
    })
    expect(validated).toHaveLength(1)
    expect(hydrated).toHaveLength(1)
    expect(result.jobs[0].descriptionKind).toBe("full")
    expect(classifyLocationEligibility(result.jobs[0], profile)).toBe("eligible")
    expect(result.stats.location_unclear_sent_for_evidence).toBe(1)
    expect(result.stats.location_resolved_after_jd).toBe(1)
    expect(result.stats.fit_ready).toBe(1)
    expect(result.stats.fit_calls).toBe(0)
  })

  test("post-hydration US-only restriction rejects worldwide metadata and unresolved geography remains non-actionable", async () => {
    const profile = { ...profiles.security, definition: { ...profiles.security.definition, remote_only: true, eligibility_constraints: { remote_scope: "Austria/EU/EEA/EMEA/Europe/worldwide" } } }
    const us = raw({ id: "us-hydrated", title: "Security Engineer", company: "Co", url: "https://x/us-hydrated", location: "Anywhere in the World", remoteScope: "Worldwide", description: "", descriptionKind: "missing" })
    const unknown = raw({ id: "still-unknown", title: "Security Engineer", company: "Co", url: "https://x/unknown", location: "Vienna", remoteScope: null, description: "", descriptionKind: "missing" })
    const result = await runGenericDiscovery({
      mode: "broad",
      profile,
      sourceRunners: [runner("test", [us, unknown])],
      validator: async (jobs) => ({ all: jobs.map((job) => ({ ...job, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-05T00:00:00Z" } })), results: jobs }),
      enricher: async (jobs) => ({
        jobs: jobs.map((job) => {
          if (job.id === "us-hydrated") return { ...job, description: `Responsibilities: Fully remote within the United States only. Lead security reviews, design controls, implement improvements, support teams, and assess risk. Qualifications: Collaborate, communicate, and own delivery.`, descriptionKind: "full" }
          return { ...job, description: `Responsibilities: Lead general security engineering work, build secure systems, design controls, support teams, and assess risk. Qualifications: Communicate clearly, collaborate, and own delivery.`, descriptionKind: "full" }
        }),
        stats: { considered: 2, attempted: 2, success: 2, cacheHits: 0, notNeeded: 0, notSupported: 0, notFound: 0, failed: 0, rateLimited: 0, timeout: 0, bySource: {} },
      }),
      now: new Date("2026-10-05T00:00:00Z"),
    })
    expect(result.jobs.some((job) => job.sourceJobId === "us-hydrated")).toBe(true)
    expect(classifyLocationEligibility(result.jobs.find((job) => job.sourceJobId === "us-hydrated")!, profile)).toBe("ineligible")
    expect(result.jobs.find((job) => job.sourceJobId === "still-unknown") && classifyLocationEligibility(result.jobs.find((job) => job.sourceJobId === "still-unknown")!, profile)).toBe("unclear")
    expect(result.stats.active_actionable).toBe(0)
    expect(result.stats.fit_ready).toBe(0)
  })

  test("partial source failure still records successful results as a partial run", async () => {
    const store = new MemoryStore()
    const result = await runGenericDiscovery({
      mode: "targeted",
      profile: profiles.accounting,
      sourceRunners: [runner("good", [raw({ id: "1", title: "Accountant", company: "Co", url: "https://x/1" })]), runner("bad", [], false)],
      validator: async (jobs) => ({ all: jobs.map((job) => ({ ...job, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-04T10:00:00Z" } })), results: jobs }),
      store,
      now: new Date("2026-10-04T10:00:00Z"),
    })
    expect(result.stats.new_jobs).toBe(1)
    expect(store.finished.status).toBe("partial")
    expect(store.associations[0].outcome).toBe("new")
  })

  test("suppression is exact-role and lifecycle outcomes are retained", async () => {
    const store = new MemoryStore()
    store.suppressedTitles.add("Accountant")
    store.rows.push({
      id: 41,
      source: "mock",
      source_job_id: "1",
      source_url: "https://x/1",
      company: "Co",
      title: "Accountant",
      last_seen_at: "2026-10-01T00:00:00Z",
    })
    const result = await runGenericDiscovery({
      mode: "targeted",
      profile: profiles.accounting,
      sourceRunners: [runner("good", [
        raw({ id: "1", title: "Accountant", company: "Co", url: "https://x/1" }),
        raw({ id: "2", title: "Financial Controller", company: "Co", url: "https://x/2" }),
      ])],
      validator: async (jobs) => ({
        all: jobs.map((job) => ({ ...job, validation: { status: job.id === "2" ? "expired" as const : "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-04T10:00:00Z" } })),
        results: jobs,
      }),
      store,
      now: new Date("2026-10-04T10:00:00Z"),
    })
    expect(result.stats.suppressed).toBe(1)
    expect(store.associations.map((item) => item.outcome)).toEqual(["suppressed", "expired"])
    expect(store.associations[0].context).toMatchObject({ eligibility_outcome: "suppressed_history" })
    expect(result.stats.expired).toBe(1)
    expect(Date.parse(String(store.rows[0].last_seen_at))).toBeGreaterThan(Date.parse("2026-10-04T10:00:00.000Z"))
    expect(store.upsertCalls).toBe(2)
    expect(result.processedJobIds).toEqual([41, 2])
  })

  test("definitively irrelevant roles are discarded while geography mismatches are retained", async () => {
    const store = new MemoryStore()
    const profile: SearchProfileRecord = {
      ...profiles.security,
      definition: {
        ...profiles.security.definition,
        allowed_regions: ["Europe"],
        work_models: ["remote"],
      },
    }
    const candidates = [
      raw({ id: "relevant", title: "Security Engineer", company: "Relevant Co", url: "https://x/relevant", location: "Remote Europe", remoteScope: "Remote Europe" }),
      raw({ id: "unrelated", title: "Software Engineer", company: "Unrelated Co", url: "https://x/unrelated" }),
      raw({ id: "excluded", title: "Security Analyst", company: "Excluded Co", url: "https://x/excluded" }),
      raw({ id: "wrong-region", title: "Security Engineer", company: "Wrong Region Co", url: "https://x/wrong-region", location: "United States", remoteScope: "Remote US" }),
    ]
    let validatedTitles: string[] = []
    const result = await runGenericDiscovery({
      mode: "broad",
      profile,
      sourceRunners: [runner("test", candidates)],
      validator: async (jobs) => {
        validatedTitles = jobs.map((item) => String(item.title))
        return {
          all: jobs.map((item) => ({ ...item, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-06T00:00:00Z" } })),
          results: jobs,
        }
      },
      store,
      now: new Date("2026-10-06T00:00:00Z"),
    })

    expect(validatedTitles).toEqual(["Security Engineer"])
    expect(store.rows.map((row) => row.company)).toEqual(["Relevant Co", "Wrong Region Co"])
    expect(result.jobs.map((item) => item.company)).toEqual(["Relevant Co", "Wrong Region Co"])
    expect(result.stats.filtered_irrelevant).toBe(2)
    expect(result.stats.filtered_ineligible).toBe(0)
    expect(result.stats.preference_mismatches_retained).toBe(1)
    expect(result.stats.new_jobs).toBe(2)
  })

  test("retains profile-relevant jobs with remote, geography, language, employment, or seniority mismatches", async () => {
    const profile: SearchProfileRecord = {
      ...profiles.security,
      definition: {
        ...profiles.security.definition,
        remote_only: true,
        allowed_regions: ["Austria"],
        accepted_languages: ["English"],
        accepted_employment_types: ["permanent"],
        excluded_seniority: ["junior"],
      },
    }
    const cases = [
      { id: "remote", title: "Security Engineer", location: "Remote Austria", remoteScope: "Remote Austria", employmentType: "Permanent", expected: "actionable" },
      { id: "hybrid", title: "Security Engineer", location: "Vienna, Austria", remoteScope: "Hybrid", employmentType: "Permanent", expected: "preference_mismatch" },
      { id: "onsite", title: "Security Engineer", location: "Vienna, Austria", remoteScope: "On-site", employmentType: "Permanent", expected: "preference_mismatch" },
      { id: "unknown", title: "Security Engineer", location: "Vienna, Austria", remoteScope: null, employmentType: "Permanent", expected: "eligibility_unclear" },
      { id: "poland", title: "Security Engineer", location: "Remote Poland", remoteScope: "Remote Poland", employmentType: "Permanent", expected: "preference_mismatch" },
      { id: "german", title: "Security Engineer", location: "Remote Austria", remoteScope: "Remote Austria", employmentType: "Permanent", description: `Deutsch erforderlich. ${"Security engineering responsibilities. ".repeat(20)}`, expected: "preference_mismatch" },
      { id: "contract", title: "Security Engineer", location: "Remote Austria", remoteScope: "Remote Austria", employmentType: "Contract", expected: "preference_mismatch" },
      { id: "junior", title: "Junior Security Engineer", location: "Remote Austria", remoteScope: "Remote Austria", employmentType: "Permanent", expected: "preference_mismatch" },
    ]
    const store = new MemoryStore()
    const result = await runGenericDiscovery({
      mode: "broad", profile,
      sourceRunners: [runner("test", cases.map((item) => raw({ ...item, company: "Example Co", url: `https://x/${item.id}` })))],
      validator: async (jobs) => ({
        all: jobs.map((job) => ({ ...job, validation: { status: "active" as const, method: "source_detail" as const, confidence: 100, checkedAt: "2026-10-06T00:00:00Z" } })),
        results: jobs,
      }),
      store, now: new Date("2026-10-06T00:00:00Z"),
    })
    expect(store.rows).toHaveLength(cases.length)
    expect(store.associations).toHaveLength(cases.length)
    const bySourceId = new Map(store.associations.map((item) => [String((item.context as any).source_job_id), item.context as any]))
    for (const item of cases) {
      expect(bySourceId.get(item.id)?.eligibility_outcome).toBe(item.expected)
    }
    expect(bySourceId.get("hybrid")?.work_model_verdict).toBe("hybrid")
    expect(bySourceId.get("onsite")?.work_model_verdict).toBe("onsite")
    expect(bySourceId.get("unknown")?.work_model_verdict).toBe("unknown")
    expect(bySourceId.get("poland")?.preference_mismatch_fields).toContain("location")
    expect(bySourceId.get("german")?.preference_mismatch_fields).toContain("language")
    expect(bySourceId.get("contract")?.preference_mismatch_fields).toContain("employment_type")
    expect(bySourceId.get("junior")?.preference_mismatch_fields).toContain("seniority")
    expect(result.stats.active_actionable).toBe(1)
    expect(result.stats.preference_mismatches_retained).toBe(6)
    expect(result.stats.eligibility_unclear_retained).toBe(1)
  })

  test("the same persistence boundary works for a backend software profile", async () => {
    const profile: SearchProfileRecord = {
      ...profiles.software,
      definition: { target_titles: ["Backend Engineer"], work_models: ["remote"], allowed_regions: ["Europe"] },
    }
    const store = new MemoryStore()
    const result = await runGenericDiscovery({
      mode: "targeted", profile,
      sourceRunners: [runner("test", [raw({ id: "backend-hybrid", title: "Backend Engineer", company: "Product Co", url: "https://x/backend-hybrid", location: "Berlin, Germany", remoteScope: "Hybrid", description: "Build APIs and distributed services with Python." })])],
      validator: async (jobs) => ({ all: jobs, results: jobs }),
      store, now: new Date("2026-10-06T00:00:00Z"),
    })
    expect(store.rows).toHaveLength(1)
    expect(result.stats.preference_mismatches_retained).toBe(1)
    expect(store.associations[0].context).toMatchObject({ eligibility_outcome: "preference_mismatch", work_model_verdict: "hybrid" })
  })

  test("applied and ignored decisions suppress this user's association while global observations remain current", async () => {
    const store = new MemoryStore()
    store.rows.push(
      { id: 1, source: "mock", source_job_id: "applied", source_url: "https://x/applied", company: "Co", title: "Accountant", last_seen_at: "2026-10-01T00:00:00Z" },
      { id: 2, source: "mock", source_job_id: "ignored", source_url: "https://x/ignored", company: "Co", title: "Accountant", last_seen_at: "2026-10-01T00:00:00Z" },
    )
    store.isSuppressed = async ({ userId, job }: any) => userId === "u1" && ["applied", "ignored"].includes(job.sourceJobId)
    const result = await runGenericDiscovery({
      mode: "targeted", profile: profiles.accounting,
      sourceRunners: [runner("test", [
        raw({ id: "applied", title: "Accountant", company: "Co", url: "https://x/applied" }),
        raw({ id: "ignored", title: "Accountant", company: "Co", url: "https://x/ignored" }),
      ])],
      validator: async (jobs) => ({ all: jobs, results: jobs }),
      store, now: new Date("2026-10-07T00:00:00Z"),
    })
    expect(result.stats.suppressed).toBe(2)
    expect(store.upsertCalls).toBe(2)
    expect(store.rows).toHaveLength(2)
    expect(store.rows.every((row) => Date.parse(String(row.last_seen_at)) >= Date.parse("2026-10-07T00:00:00.000Z"))).toBe(true)
    expect(store.associations.map((item) => item.outcome)).toEqual(["suppressed", "suppressed"])
    expect(store.associations.every((item) => (item.context as any).eligibility_outcome === "suppressed_history")).toBe(true)
  })
})
