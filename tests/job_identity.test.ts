import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import type { NormalizedJob } from "../tools/job_availability_validator"
import { discoveryKey, mergeDiscoveredJobs, normalizeDiscoveredJob } from "../tools/generic_discovery"
import {
  preferObservationForCanonicalFacts,
  resolvePhysicalJobIdentity,
  sourceObservationFor,
} from "../tools/job_identity"

function listing(input: Partial<NormalizedJob> & { source: string; title: string; company: string; id: string; applicationUrl?: string }): NormalizedJob {
  return {
    sourceType: ["ashby", "lever", "greenhouse", "smartrecruiters", "teamtailor"].includes(input.source) ? "ats" : "aggregator",
    sourceUrl: `https://${input.source}.example/jobs/${input.id}`,
    location: "Remote Europe",
    description: "Full role description with responsibilities and qualifications.",
    ...input,
    portal: input.source,
  }
}

function observation(input: Parameters<typeof listing>[0]) {
  return sourceObservationFor(listing(input), input.source)
}

function existing(jobId: number, value: ReturnType<typeof observation>) {
  return {
    jobId,
    source: value.source,
    sourceJobId: value.sourceJobId,
    normalizedSourceUrl: value.normalizedSourceUrl,
    normalizedApplicationUrl: value.normalizedApplicationUrl,
    atsProvider: value.atsProvider,
    atsBoardId: value.atsBoardId,
    atsRequisitionId: value.atsRequisitionId,
    identityKeys: value.identityKeys,
  }
}

describe("domain-neutral physical job identity", () => {
  const ashbyUrl = "https://jobs.ashbyhq.com/coverflex/req-123"
  const aggregator = observation({ source: "jobgether", id: "jg-9", title: "Cybersecurity Lead", company: "Coverflex", applicationUrl: ashbyUrl })
  const linkedin = observation({ source: "linkedin", id: "li-2", title: "Cybersecurity Lead", company: "Coverflex", applicationUrl: ashbyUrl })
  const ashby = observation({ source: "ashby", id: "req-123", title: "Cybersecurity Lead", company: "Coverflex", applicationUrl: ashbyUrl })

  test("Jobgether and exact ATS resolve to one physical job while retaining two observations", () => {
    expect(resolvePhysicalJobIdentity(ashby, [existing(7, aggregator)] )).toMatchObject({ state: "matched", jobId: 7 })
    expect(new Set([aggregator.observationKey, ashby.observationKey]).size).toBe(2)
  })

  test("LinkedIn and exact ATS resolve to one physical job", () => {
    expect(resolvePhysicalJobIdentity(ashby, [existing(8, linkedin)])).toMatchObject({ state: "matched", jobId: 8 })
  })

  test("three source observations converge on one job without collapsing provenance", () => {
    const canonicalIds = new Set<number>()
    const observationRows: ReturnType<typeof existing>[] = []
    const input = [aggregator, linkedin, ashby]
    for (const item of input) {
      const resolution = resolvePhysicalJobIdentity(item, observationRows)
      const id = resolution.state === "new" ? 9 : resolution.jobId as number
      canonicalIds.add(id)
      observationRows.push(existing(id, item))
    }
    expect(canonicalIds.size).toBe(1)
    expect(observationRows).toHaveLength(3)
    expect(observationRows.map((item) => item.source)).toEqual(["jobgether", "linkedin", "ashby"])
  })

  test("source-local cleanup keeps cross-source observations for later physical resolution", () => {
    const jobgether = normalizeDiscoveredJob(listing({ source: "jobgether", id: "jg-9", title: "Cybersecurity Lead", company: "Coverflex", applicationUrl: ashbyUrl }), "jobgether")!
    const linkedIn = normalizeDiscoveredJob(listing({ source: "linkedin", id: "li-2", title: "Cybersecurity Lead", company: "Coverflex", applicationUrl: ashbyUrl }), "linkedin")!
    expect(mergeDiscoveredJobs([jobgether, linkedIn])).toHaveLength(2)
  })

  test("within-run dedupe keeps contradictory requisition identities separate", () => {
    const first = normalizeDiscoveredJob(listing({ source: "portal", id: "listing-1", title: "Product Manager", company: "Example", applicationUrl: "https://jobs.ashbyhq.com/example/a" }), "portal")!
    const second = normalizeDiscoveredJob(listing({ source: "portal", id: "listing-1", title: "Product Manager", company: "Example", applicationUrl: "https://jobs.ashbyhq.com/example/b" }), "portal")!
    expect(discoveryKey(first)).not.toBe(discoveryKey(second))
    expect(mergeDiscoveredJobs([first, second])).toHaveLength(2)
  })

  test("same company/title with different strong requisition IDs remains separate", () => {
    const one = observation({ source: "ashby", id: "a", title: "Security Engineer", company: "Example", applicationUrl: "https://jobs.ashbyhq.com/example/a" })
    const two = observation({ source: "ashby", id: "b", title: "Security Engineer", company: "Example", applicationUrl: "https://jobs.ashbyhq.com/example/b" })
    expect(resolvePhysicalJobIdentity(two, [existing(10, one)])).toMatchObject({ state: "new", conflictingJobIds: [] })
  })

  test("same source ID with contradictory ATS claims is a conflict", () => {
    const old = observation({ source: "portal", id: "listing-1", title: "Product Manager", company: "Example", applicationUrl: "https://jobs.ashbyhq.com/example/a" })
    const changed = observation({ source: "portal", id: "listing-1", title: "Product Manager", company: "Example", applicationUrl: "https://jobs.ashbyhq.com/example/b" })
    expect(resolvePhysicalJobIdentity(changed, [existing(14, old)])).toMatchObject({ state: "conflict", conflictingJobIds: [14] })
  })

  test("direct employer URL and stable requisition reference use the lower identity tiers", () => {
    const employer = sourceObservationFor(listing({
      source: "employer", sourceType: "employer_careers", id: "employer-role-42",
      title: "Product Manager", company: "Example", sourceUrl: "https://example.com/careers/jobs/42",
      applicationUrl: "https://apply.example.com/role/42", employerId: "example-inc",
      employerRequisitionId: "REQ-42",
    } as any), "employer")
    expect(employer.identityKeys).toContainEqual({ key: "url:https://example.com/careers/jobs/42", level: 2, basis: "employer_url" })
    expect(employer.identityKeys).toContainEqual({ key: "employer-ref:example inc:req 42", level: 3, basis: "employer_reference" })
  })

  test("weak company/title/location similarity is reported only as a possible duplicate", () => {
    const incoming = observation({ source: "linkedin", id: "li-55", title: "Backend Engineer", company: "Example", location: "Berlin" })
    const weakCandidate = { jobId: 15, source: "jobgether", sourceJobId: "jg-88" }
    expect(resolvePhysicalJobIdentity(incoming, [], [weakCandidate])).toMatchObject({ state: "new", possibleDuplicateJobIds: [15] })
  })

  test("closed prior requisition and new requisition ID remain separate", () => {
    const old = observation({ source: "ashby", id: "old", title: "Backend Engineer", company: "Example", applicationUrl: "https://jobs.ashbyhq.com/example/old", validation: { status: "expired" } as any })
    const reopened = observation({ source: "ashby", id: "new", title: "Backend Engineer", company: "Example", applicationUrl: "https://jobs.ashbyhq.com/example/new", validation: { status: "active" } as any })
    expect(resolvePhysicalJobIdentity(reopened, [existing(11, old)])).toMatchObject({ state: "new" })
  })

  test("same employer URL with contradictory verified ATS identities is a conflict", () => {
    const url = "https://careers.example.com/jobs/security-engineer"
    const old = observation({ source: "employer", sourceType: "ats", id: "source-a", title: "Security Engineer", company: "Example", applicationUrl: url,
      ats: { provider: "ashby", boardId: "example", requisitionId: "a" }, metadata: { verifiedEmployerRequisitionUrl: true } } as any)
    const contradictory = observation({ source: "employer-feed", sourceType: "ats", id: "source-b", title: "Security Engineer", company: "Example", applicationUrl: url,
      ats: { provider: "ashby", boardId: "example", requisitionId: "b" }, metadata: { verifiedEmployerRequisitionUrl: true } } as any)
    expect(resolvePhysicalJobIdentity(contradictory, [existing(12, old)])).toMatchObject({ state: "conflict", conflictingJobIds: [12] })
  })

  test("verified direct ATS facts outrank aggregator facts without discarding either observation", () => {
    expect(aggregator.authority).toBe("trusted_aggregator")
    expect(ashby.authority).toBe("verified_ats")
    expect(preferObservationForCanonicalFacts(aggregator.authorityRank, ashby)).toBe(true)
    expect(preferObservationForCanonicalFacts(ashby.authorityRank, aggregator)).toBe(false)
  })

  test("untrusted aggregator metadata cannot promote source authority or structured IDs", () => {
    const untrusted = sourceObservationFor(listing({
      source: "jobgether", id: "jg-1", title: "Security Engineer", company: "Example",
      applicationUrl: "https://example.com/job/security",
      ats: { provider: "ashby", boardId: "example", requisitionId: "claimed-id" },
      metadata: { sourceAuthority: "verified_ats", verifiedAtsSource: true, verifiedEmployerRequisitionUrl: true },
    } as any), "jobgether")
    expect(untrusted.authority).toBe("trusted_aggregator")
    expect(untrusted.identityKeys).toEqual([])
  })

  test("profession does not affect identity resolution", () => {
    for (const title of ["Security Engineer", "Backend Engineer", "Product Manager"]) {
      const source = observation({ source: "linkedin", id: `${title}-source`, title, company: "Example", applicationUrl: "https://jobs.lever.co/example/req-1" })
      const ats = observation({ source: "lever", id: "req-1", title, company: "Example", applicationUrl: "https://jobs.lever.co/example/req-1" })
      expect(resolvePhysicalJobIdentity(ats, [existing(13, source)])).toMatchObject({ state: "matched", jobId: 13 })
    }
  })

  const deferredMigration = "supabase/migrations_deferred/20261007170000_add_physical_job_identity.sql"
  const deferredMigrationTest = existsSync(deferredMigration) ? test : test.skip
  deferredMigrationTest("canonicalization code does not move user history or Fit lineage", () => {
    const sql = readFileSync(deferredMigration, "utf8")
    expect(sql).toContain("job_id bigint REFERENCES public.jobs(id) ON DELETE RESTRICT")
    expect(sql).toContain("a.user_id = p_user_id AND a.job_id = p_job_id")
    expect(sql).toContain("r.user_id = p_user_id AND r.job_id = p_job_id")
    expect(sql).not.toMatch(/\bUPDATE\s+public\.(applications|job_reviews|user_job_verifications|job_metadata_overrides|job_match_assessments)\b/i)
  })
})
