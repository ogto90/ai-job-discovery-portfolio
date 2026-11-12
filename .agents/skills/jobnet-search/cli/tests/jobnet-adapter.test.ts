import { afterEach, describe, expect, test } from "bun:test"
import { apiFetch } from "../src/helpers.js"
import { createSearchOutput, parseSearchApiResponse, type SearchFlags } from "../src/commands/search.js"

const originalFetch = globalThis.fetch
type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(handler: FetchHandler): void {
  globalThis.fetch = handler as typeof fetch
}

function validResponse(jobAds: unknown[] = []) {
  return {
    jobAds,
    searchFacets: { regions: [], workHours: [], employmentDurations: [], occupationAreas: [], countries: [] },
    totalJobAdCount: jobAds.length,
    searchString: "security",
  }
}

const flags: SearchFlags = { page: 1, "per-page": 10, order: "PublicationDate", radius: 50 }

describe("Jobnet adapter offline fixtures", () => {
  test("accepts a valid listing and preserves normalized public fields", async () => {
    mockFetch(async (input, init) => {
      expect(String(input)).toBe("https://jobnet.dk/bff/FindJob/Search?searchString=security")
      expect(new Headers(init?.headers).get("x-csrf")).toBe("1")
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
      return Response.json(validResponse([{
        jobAdId: "job-123",
        title: "Security Engineer",
        hiringOrgName: "Example A/S",
        occupation: "Security",
        municipality: "Copenhagen",
        postalCode: 1050,
        postalDistrictName: "Copenhagen K",
        country: "Danmark",
        publicationDate: "2026-10-18T08:00:00Z",
        applicationDeadline: "2026-11-01T00:00:00Z",
        applicationDeadlineStatus: "Disclosed",
        workHourPartTime: false,
        isExternal: true,
        hasLogo: true,
        logoUrl: "/logo.png",
        cvr: "12345678",
        workPlaceAddress: "Copenhagen",
        isSeen: false,
        isFavorite: false,
        description: "Security job description",
      }]), { status: 200 })
    })

    const response = parseSearchApiResponse(await apiFetch<unknown>("/FindJob/Search", { searchString: "security" }))
    const output = createSearchOutput(response, flags)
    expect(output.results[0]).toMatchObject({
      jobAdId: "job-123",
      title: "Security Engineer",
      hiringOrgName: "Example A/S",
      company: "Example A/S",
      location: "Copenhagen K",
      date: "2026-10-18",
      deadline: "2026-11-01",
      description: "Security job description",
      isExternal: true,
      workHourPartTime: false,
      url: "https://jobnet.dk/find-job/job-123",
    })
  })

  test("accepts a valid empty result as a genuine zero-result response", async () => {
    mockFetch(async () => Response.json(validResponse(), { status: 200 }))
    const parsed = parseSearchApiResponse(await apiFetch<unknown>("/FindJob/Search"))
    expect(createSearchOutput(parsed, flags).results).toEqual([])
  })

  test.each([401, 403, 404])("does not retry HTTP %i", async (status) => {
    let calls = 0
    mockFetch(async () => {
      calls += 1
      return new Response("token=fixture-secret", { status, statusText: "Fixture" })
    })
    let message = ""
    try {
      await apiFetch("/FindJob/Search")
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain(`API request failed: ${status}`)
    expect(message).not.toContain("fixture-secret")
    expect(calls).toBe(1)
  })

  test.each([429, 500])("retries HTTP %i within the adapter's bounded policy", async (status) => {
    let calls = 0
    mockFetch(async () => {
      calls += 1
      if (calls === 1) return new Response("retry", { status, statusText: "Fixture" })
      return Response.json(validResponse())
    })
    await expect(apiFetch("/FindJob/Search")).resolves.toMatchObject({ jobAds: [] })
    expect(calls).toBe(2)
  })

  test("does not retry a request timeout or network connection failure", async () => {
    for (const failure of [new DOMException("The operation timed out.", "TimeoutError"), new TypeError("fetch failed")]) {
      let calls = 0
      mockFetch(async () => {
        calls += 1
        throw failure
      })
      await expect(apiFetch("/FindJob/Search")).rejects.toBe(failure)
      expect(calls).toBe(1)
    }
  })

  test("rejects invalid JSON and malformed payloads instead of producing empty listings", async () => {
    mockFetch(async () => new Response("not-json", { status: 200 }))
    await expect(apiFetch("/FindJob/Search")).rejects.toThrow()

    for (const payload of [null, {}, { jobAds: [], searchFacets: null }, validResponse([{
      jobAdId: "job-123",
      hiringOrgName: "Example A/S",
    }])]) {
      expect(() => parseSearchApiResponse(payload)).toThrow()
    }
  })
})
