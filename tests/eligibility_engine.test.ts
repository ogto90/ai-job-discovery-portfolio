import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  classifyEmploymentType,
  classifyLanguageEligibility,
  classifyLocationEligibility,
  classifySeniority,
  classifyTargetRole,
  evaluateFinalJobEligibility,
  type SearchProfileRecord,
  type DiscoveredJob,
} from "../tools/generic_discovery"
import { writeFile } from "node:fs/promises"
import {
  evaluateCandidateEligibility,
  extractJobRequirements,
  loadCandidateProfile,
  type CandidateProfile,
  type EligibilityDimension,
  type EligibilityStatus,
} from "../tools/eligibility_engine"
import type { NormalizedJob } from "../tools/company_registry"

const candidate: CandidateProfile = {
  schemaVersion: 1,
  location: {
    country: "AT",
    city: "Vienna",
    acceptableRemoteRegions: ["EU", "Europe", "EMEA", "Worldwide"],
    acceptableRemoteCountries: [],
    relocation: false,
    hybridCities: ["Vienna"],
  },
  languages: [
    { language: "English", level: "professional" },
    { language: "German", level: "basic" },
    { language: "Swedish", level: "native" },
  ],
  rolePreferences: {
    targetRoles: ["application_security", "product_security", "security_engineering", "vulnerability_management", "security_architecture", "security_management", "soc_detection", "incident_response", "grc"],
    excludedRoles: ["soc_analyst", "cloud_security"],
  },
  careerTrack: {
    prefer: "hands_on_lead",
    allowHandsOnLead: true,
    allowPeopleManagement: true,
    excluded: ["executive"],
  },
  seniority: {
    target: ["senior", "lead"],
    acceptable: ["mid", "senior", "staff", "principal", "lead", "manager"],
    excluded: ["intern", "graduate", "junior"],
  },
  employmentTypes: ["full_time"],
}

function job(input: Partial<NormalizedJob> & { title?: string; location?: string | null; description?: string | null }): NormalizedJob {
  return {
    id: input.id ?? `${input.title}-${input.location}`,
    title: input.title ?? "Security Engineer",
    company: input.company ?? "Example",
    location: input.location ?? "Remote Europe",
    url: input.url ?? "https://example.test/job",
    description: input.description ?? "",
    source: "test",
    ...input,
  }
}

function status(input: Partial<NormalizedJob>, profile: CandidateProfile | null = candidate): EligibilityStatus {
  return evaluateCandidateEligibility(profile, extractJobRequirements(job(input))).status
}

function reasons(input: Partial<NormalizedJob>, profile: CandidateProfile | null = candidate): EligibilityDimension[] {
  return evaluateCandidateEligibility(profile, extractJobRequirements(job(input))).reasons
}

describe("candidate profile loading", () => {
  test("loads structured JSON profiles with explicit field sources", async () => {
    const path = `/tmp/eligibility-profile-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    await writeFile(path, JSON.stringify(candidate), "utf8")
    const loaded = await loadCandidateProfile(path)
    expect(loaded?.location?.country).toBe("AT")
    expect(loaded?.rolePreferences?.excludedRoles).toContain("cloud_security")
  })

  test("loads a companion JSON profile when the CLI receives a markdown path", async () => {
    const base = `/tmp/eligibility-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await writeFile(`${base}.json`, JSON.stringify(candidate), "utf8")
    await writeFile(`${base}.md`, "# Human profile\n", "utf8")
    const loaded = await loadCandidateProfile(`${base}.md`)
    expect(loaded?.source).toBe(`${base}.json`)
  })

  test("returns null for missing candidate profile instead of inventing defaults", async () => {
    const loaded = await loadCandidateProfile(`/tmp/missing-${Date.now()}.md`)
    expect(loaded).toBeNull()
  })
})

describe("job requirement extraction", () => {
  const extractionCases: Array<[string, Partial<NormalizedJob>, unknown]> = [
    ["remote workplace", { location: "Remote Europe" }, "remote"],
    ["hybrid workplace", { location: "Hybrid Vienna" }, "hybrid"],
    ["onsite workplace", { location: "On-site Berlin" }, "onsite"],
    ["worldwide region", { location: "Remote Worldwide" }, "Worldwide"],
    ["eu region", { location: "Remote EU" }, "EU"],
    ["europe region", { location: "Europe (Remote)" }, "Europe"],
    ["emea region", { location: "AMER/EMEA/APAC" }, "EMEA"],
    ["north america region", { location: "Remote North America" }, "North America"],
    ["latam region", { location: "Remote LATAM" }, "LATAM"],
    ["apac region", { location: "Remote APAC" }, "APAC"],
    ["austria country", { location: "Vienna, Austria" }, "AT"],
    ["germany country", { location: "Remote Germany" }, "DE"],
    ["us country", { location: "Remote US" }, "US"],
    ["canada country", { location: "Toronto, Canada" }, "CA"],
    ["uk country", { location: "London, United Kingdom" }, "GB"],
    ["us state abbreviation", { location: "Seattle, WA" }, "US"],
    ["south korea country", { location: "Seoul, South Korea" }, "KR"],
    ["australia country", { location: "Australia" }, "AU"],
    ["singapore country", { location: "Singapore" }, "SG"],
    ["timezone evidence", { location: "Remote", description: "Remote - EST/CST time zones" }, "EST"],
    ["german required", { description: "Fluent German is required" }, "German"],
    ["english required", { description: "C1 English is essential" }, "English"],
    ["contract type", { title: "Application Security Engineer - Contract" }, "contract"],
    ["full-time type", { employmentType: "Full Time" }, "full_time"],
    ["cloud role family", { title: "Cloud Security Engineer" }, "cloud_security"],
    ["soc analyst family", { title: "Security Analyst" }, "soc_analyst"],
    ["appsec family", { title: "Senior Application Security Engineer" }, "application_security"],
    ["product security family", { title: "Product Security Engineer" }, "product_security"],
    ["vuln family", { title: "Vulnerability Management Engineer" }, "vulnerability_management"],
    ["architecture family", { title: "Lead Cyber Security Architect" }, "security_architecture"],
  ]

  for (const [name, input, expected] of extractionCases) {
    test(name, () => {
      const req = extractJobRequirements(job(input))
      const haystack = JSON.stringify(req)
      expect(haystack).toContain(String(expected))
    })
  }
})

describe("eligibility evaluation", () => {
  const cases: Array<[string, Partial<NormalizedJob>, EligibilityStatus, EligibilityDimension | "none"]> = [
    ["remote worldwide passes", { location: "Remote Worldwide" }, "pass", "none"],
    ["remote global passes", { location: "Remote Global" }, "pass", "none"],
    ["remote Europe passes", { location: "Remote Europe" }, "pass", "none"],
    ["remote EU passes", { location: "Remote EU" }, "pass", "none"],
    ["remote EMEA passes", { location: "Remote EMEA" }, "pass", "none"],
    ["remote Austria passes", { location: "Remote Austria" }, "pass", "none"],
    ["AMER EMEA APAC without a work model remains unknown", { location: "AMER/EMEA/APAC" }, "unknown", "uncertain_location"],
    ["hybrid Vienna passes", { location: "Hybrid Vienna" }, "pass", "none"],
    ["onsite Vienna passes", { location: "On-site Vienna, Austria" }, "pass", "none"],
    ["remote with no scope unknown", { location: "Remote" }, "unknown", "uncertain_location"],
    ["remote timezone only unknown", { location: "Remote", description: "Remote - EST/CST time zones" }, "unknown", "uncertain_location"],
    ["remote Germany fails", { location: "Remote Germany" }, "fail", "location"],
    ["remote US fails", { location: "Remote US" }, "fail", "location"],
    ["remote United States fails", { location: "Remote United States" }, "fail", "location"],
    ["remote Seattle WA fails", { location: "Remote Seattle, WA" }, "fail", "location"],
    ["remote North America fails", { location: "Remote North America" }, "fail", "location"],
    ["remote Canada fails", { location: "Remote Canada" }, "fail", "location"],
    ["remote UK fails", { location: "Remote UK" }, "fail", "location"],
    ["remote Australia fails", { location: "Remote Australia" }, "fail", "location"],
    ["remote Singapore fails", { location: "Remote Singapore" }, "fail", "location"],
    ["remote Hong Kong fails", { location: "Remote Hong Kong" }, "fail", "location"],
    ["remote Saudi fails", { location: "Remote Riyadh, Saudi Arabia" }, "fail", "location"],
    ["remote Brazil fails", { location: "Remote Brazil" }, "fail", "location"],
    ["onsite Berlin fails", { location: "On-site Berlin, Germany" }, "fail", "location"],
    ["onsite London fails", { location: "London, United Kingdom" }, "fail", "location"],
    ["Germany location is not German language fail", { location: "Remote Germany", description: "English required" }, "fail", "location"],
    ["German speaking fails", { description: "German-speaking team role" }, "fail", "language"],
    ["fluent German fails", { description: "Fluent German is required" }, "fail", "language"],
    ["C1 German fails", { description: "C1 German is required" }, "fail", "language"],
    ["C1/C2 German fails", { description: "C1/C2 German is essential" }, "fail", "language"],
    ["German preferred passes", { description: "German preferred", employmentType: "Full Time" }, "pass", "none"],
    ["German plus passes", { description: "German is a plus", employmentType: "Full Time" }, "pass", "none"],
    ["English required passes", { description: "C1 English is essential", employmentType: "Full Time" }, "pass", "none"],
    ["C2 English required passes for fluent professional English", { description: "C2 English is essential", employmentType: "Full Time" }, "pass", "none"],
    ["English and German required fails", { description: "English and C1 German required" }, "fail", "language"],
    ["junior fails", { title: "Junior Security Engineer" }, "fail", "seniority"],
    ["intern fails", { title: "Security Intern" }, "fail", "seniority"],
    ["graduate fails", { title: "Graduate Security Engineer" }, "fail", "seniority"],
    ["mid engineer passes", { title: "Security Engineer", employmentType: "Full Time" }, "pass", "none"],
    ["senior engineer passes", { title: "Senior Security Engineer", employmentType: "Full Time" }, "pass", "none"],
    ["staff engineer passes", { title: "Staff Security Engineer", employmentType: "Full Time" }, "pass", "none"],
    ["principal engineer passes", { title: "Principal Security Engineer", employmentType: "Full Time" }, "pass", "none"],
    ["lead engineer passes", { title: "Lead Security Engineer", employmentType: "Full Time" }, "pass", "none"],
    ["security manager passes when candidate allows management", { title: "Security Manager", employmentType: "Full Time" }, "pass", "none"],
    ["head is management rather than automatically executive", { title: "Head of Information Security" }, "pass", "none"],
    ["CISO fails as executive track", { title: "CISO" }, "fail", "management"],
    ["cloud security engineer fails by configured role exclusion", { title: "Cloud Security Engineer" }, "fail", "roleMismatch"],
    ["GCP cloud security fails by configured role exclusion", { title: "Cloud Security Engineer (GCP)" }, "fail", "roleMismatch"],
    ["security analyst fails by configured role exclusion", { title: "Security Analyst" }, "fail", "roleMismatch"],
    ["mixed analyst engineer fails by configured role exclusion", { title: "Cyber Security Analyst / Security Engineer" }, "fail", "roleMismatch"],
    ["vulnerability management analyst fails by configured role exclusion", { title: "Vulnerability Management Analyst" }, "fail", "roleMismatch"],
    ["product security passes", { title: "Product Security Engineer", employmentType: "Full Time" }, "pass", "none"],
    ["application security passes", { title: "Application Security Engineer", employmentType: "Full Time" }, "pass", "none"],
    ["secure sdlc passes", { title: "Secure SDLC Engineer", description: "Application security", employmentType: "Full Time" }, "pass", "none"],
    ["vulnerability management engineer passes", { title: "Vulnerability Management Engineer", employmentType: "Full Time" }, "pass", "none"],
    ["security architect passes", { title: "Security Architect", employmentType: "Full Time" }, "pass", "none"],
    ["contract fails when profile accepts full-time only", { title: "Application Security Engineer - Contract" }, "fail", "employmentType"],
    ["internship employment fails", { title: "Application Security Engineer", employmentType: "Internship" }, "fail", "employmentType"],
    ["US work authorization fails", { location: "Remote", description: "Must be authorized to work in the United States. We do not sponsor visas." }, "fail", "workAuthorization"],
    ["security clearance fails", { title: "Security Engineer with Security clearance" }, "fail", "workAuthorization"],
    ["location fits but language fails", { location: "Remote Europe", description: "Fluent German required" }, "fail", "language"],
    ["excellent technical match but geography fails", { title: "Senior Application Security Engineer", location: "Remote North America" }, "fail", "location"],
    ["everything fits", { title: "Senior Product Security Engineer", location: "Remote Europe", description: "C1 English is essential", employmentType: "Full Time" }, "pass", "none"],
    ["sourcegraph style remote stays unknown", { title: "Security Engineer [IC3]", location: "Remote" }, "unknown", "uncertain_location"],
    ["replit style foster city fails", { title: "Product Security Engineer", location: "Foster City, CA" }, "fail", "location"],
    ["coupang seoul fails", { title: "Senior Security Engineer", location: "Seoul, South Korea" }, "fail", "location"],
    ["glia estonia remote fails as country scoped", { title: "Senior Security Engineer Team Lead", location: "Estonia - Remote" }, "fail", "location"],
    ["nabu casa Europe passes", { title: "Product Security & Compliance Engineer", location: "Europe", remote: "Full Remote", employmentType: "Full Time" }, "pass", "none"],
    ["wayflyer remote Europe passes", { title: "Security Manager", location: "Remote Europe", employmentType: "Full Time" }, "pass", "none"],
    ["hightouch North America fails", { title: "Application Security Lead", location: "Remote (North America)" }, "fail", "location"],
    ["project eleven UK fails", { title: "Senior Security Engineer", location: "United Kingdom" }, "fail", "location"],
    ["anywhere United States fails", { title: "Information Systems Security Manager", location: "Anywhere, United States", remote: "Full Remote" }, "fail", "location"],
    ["bare anywhere passes as worldwide source metadata", { title: "Security Engineer", location: "Anywhere", remote: "Full Remote", employmentType: "Full Time" }, "pass", "none"],
  ]

  for (const [name, input, expectedStatus, expectedReason] of cases) {
    test(name, () => {
      const result = evaluateCandidateEligibility(candidate, extractJobRequirements(job(input)))
      expect(result.status).toBe(expectedStatus)
      if (expectedReason !== "none") expect(result.reasons).toContain(expectedReason)
      expect(JSON.stringify(result)).toContain("confidence")
    })
  }
})

describe("Python dashboard / TypeScript scheduled path equivalence", () => {
  test("shared SearchProfile cases produce identical dimension and actionability outcomes", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "fixtures/search_profile_path_equivalence.json"), "utf8")) as {
      profiles: Record<string, Record<string, unknown>>
      cases: Array<Record<string, string | Record<string, string | boolean>>>
    }

    for (const scenario of fixture.cases) {
      const expected = scenario.expected as Record<string, string | boolean>
      const profileKey = String(scenario.profile)
      const profile: SearchProfileRecord = {
        id: 1,
        user_id: "fixture-user",
        name: profileKey,
        definition: fixture.profiles[profileKey] as SearchProfileRecord["definition"],
        min_fit_score: 60,
        is_active: true,
      }
      const job = {
        source: "fixture",
        sourceJobId: String(scenario.name),
        sourceUrl: null,
        applicationUrl: null,
        company: "Fixture Co",
        title: String(scenario.title),
        location: String(scenario.location),
        remoteScope: String(scenario.remote_scope),
        employmentType: String(scenario.employment_type),
        description: String(scenario.description),
        descriptionKind: "full",
        postedAt: null,
        raw: {},
        validation: { status: "active" },
      } as DiscoveredJob

      const result = evaluateFinalJobEligibility(job, profile)
      expect({
        role: result.role,
        location: result.location,
        language: result.language,
        employment_type: result.employmentType,
        seniority: result.seniority,
        actionable: result.actionable,
      }, String(scenario.name)).toEqual(expected)

      const direct = {
        role: classifyTargetRole(job.title, profile),
        location: classifyLocationEligibility(job, profile),
        language: classifyLanguageEligibility(job, profile),
        employment_type: classifyEmploymentType(job, profile),
        seniority: classifySeniority(job.title, profile),
      }
      expect(result.actionable).toBe(
        direct.role === "target_match"
          && direct.location === "eligible"
          && direct.language === "eligible"
          && direct.employment_type === "eligible"
          && direct.seniority === "eligible",
      )
    }
  })
})
