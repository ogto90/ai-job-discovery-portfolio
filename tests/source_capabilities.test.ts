import { describe, expect, test } from "bun:test"
import { diagnoseSourceSelection, discoverEnabledSourceNames, getSourceMissingEnv } from "../tools/job_pipeline"
import { evaluateSourceApplicability, parseSourceCapability } from "../tools/source_capabilities"
import type { SearchProfileRecord } from "../tools/generic_discovery"

const profile = (name: string, definition: Record<string, unknown>): SearchProfileRecord => ({
  id: 1,
  user_id: "offline-user",
  name,
  definition,
  min_fit_score: 0,
  is_active: true,
})

const backend = profile("Backend Software Engineering", {
  target_titles: ["Software Engineer", "Backend Engineer", "Backend Developer", "Python Developer"],
  role_families: ["Software Engineering", "Backend Engineering", "Platform Engineering"],
  positive_concepts: ["Python", "APIs", "backend", "distributed systems"],
  excluded_title_patterns: ["Frontend", "Mobile", "QA"],
  work_models: ["remote"],
  allowed_regions: ["Europe", "EU", "EMEA"],
  accepted_languages: ["English"],
})

const product = profile("Product Management", {
  target_titles: ["Product Manager", "Senior Product Manager", "Technical Product Manager"],
  role_families: ["Product Management"],
  positive_concepts: ["roadmaps", "customer discovery"],
})

const cybersecurity = profile("Cybersecurity", {
  target_titles: ["Security Engineer", "Cybersecurity Engineer"],
  role_families: ["Application Security", "Product Security"],
  positive_concepts: ["vulnerability management"],
  excluded_title_patterns: ["Analyst", "SOC"],
})

describe("SearchProfile-aware source capabilities", () => {
  test("generic providers are selected for cybersecurity, backend, and product profiles", async () => {
    for (const searchProfile of [cybersecurity, backend, product]) {
      const selected = await discoverEnabledSourceNames(".agents/skills", searchProfile)
      expect(selected).toContain("linkedin-search")
      expect(selected).toContain("jobgether-search")
      expect(selected).toContain("himalayas-search")
      expect(selected).toContain("remotive-search")
    }
  })

  test("InfoSec is disabled by configuration while other providers remain selectable", async () => {
    const enabled = await discoverEnabledSourceNames(".agents/skills", cybersecurity)
    expect(enabled).not.toContain("infosecjobs-search")
    for (const provider of ["linkedin-search", "jobgether-search", "jobicy-search", "arbeitnow-search", "himalayas-search", "remotive-search", "remoteok-search", "weworkremotely-search"]) {
      expect(enabled).toContain(provider)
    }
    expect(await discoverEnabledSourceNames(".agents/skills", backend)).not.toContain("infosecjobs-search")
    expect(await discoverEnabledSourceNames(".agents/skills", product)).not.toContain("infosecjobs-search")
    const detail = (await diagnoseSourceSelection(".agents/skills", backend)).find((item) => item.provider === "infosecjobs-search")
    expect(detail).toMatchObject({ enabledByConfig: false, selected: false, reason: "disabled_by_config" })
  })

  test("Jobnet is explicitly disabled and excluded from runnable providers", async () => {
    const diagnostics = await diagnoseSourceSelection(".agents/skills", cybersecurity)
    const jobnet = diagnostics.find((item) => item.provider === "jobnet-search")

    expect(jobnet).toMatchObject({
      enabledByConfig: false,
      selected: false,
      reason: "disabled_by_config",
    })
    expect(await discoverEnabledSourceNames(".agents/skills", cybersecurity)).not.toContain("jobnet-search")
  })

  test("InfoSecJobs is reported disabled_by_config and excluded from runnable providers", async () => {
    const diagnostics = await diagnoseSourceSelection(".agents/skills", cybersecurity)
    const infosec = diagnostics.find((item) => item.provider === "infosecjobs-search")

    expect(infosec).toMatchObject({
      enabledByConfig: false,
      selected: false,
      reason: "disabled_by_config",
    })
    expect(await discoverEnabledSourceNames(".agents/skills", cybersecurity)).not.toContain("infosecjobs-search")
  })

  test("profile name alone does not make a specialized source applicable", () => {
    const misleadingName = profile("Cybersecurity", { target_titles: ["Backend Engineer"], role_families: ["Backend Engineering"] })
    const decision = evaluateSourceApplicability("infosecjobs-search", { generic: false, domains: ["cybersecurity"] }, true, [], misleadingName)
    expect(decision).toMatchObject({ selected: false, reason: "profile_domain_mismatch" })
  })

  test("missing domain metadata safely defaults to generic", () => {
    const capability = parseSourceCapability("enabled: true")
    expect(capability).toEqual({ generic: true, domains: [] })
    expect(evaluateSourceApplicability("future-source", capability, true, [], backend).selected).toBe(true)
  })

  test("credential and disabled settings still gate specialized sources", () => {
    const capability = { generic: false, domains: ["cybersecurity"] }
    expect(evaluateSourceApplicability("source", capability, true, ["API_TOKEN"], cybersecurity).reason).toBe("missing_credentials")
    expect(evaluateSourceApplicability("source", capability, false, [], cybersecurity).reason).toBe("disabled_by_config")
    expect(getSourceMissingEnv("adzuna-search", {})).toEqual(["ADZUNA_APP_ID", "ADZUNA_APP_KEY"])
    expect(getSourceMissingEnv("adzuna-search", { ADZUNA_APP_ID: "id", ADZUNA_APP_KEY: "key" })).toEqual([])
  })
})
