import { describe, expect, test } from "bun:test"
import {
  assertSafeUrl,
  classifyHtml,
  detectAts,
  isGenericCareersRedirect,
  isNormalizationRedirect,
  validateExplicitSignals,
  validateJobAvailability,
  validateJobs,
  visibleText,
  type NormalizedJob,
} from "../tools/job_availability_validator"

const now = new Date("2026-09-04T12:00:00Z")
const safeResolver = async () => ["93.184.216.34"]

test("visible text strips malformed script end tags before decoding entities", () => {
  expect(visibleText("<script>closed</script bad=1>Active &amp;lt;role&amp;gt;"))
    .toBe("Active &lt;role&gt;")
})

function response(status: number, body = "", headers: Record<string, string> = {}) {
  return {
    status,
    statusText: String(status),
    headers: new Headers(headers),
    body: new Response(body).body ?? undefined,
  }
}

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    title: "Security Lead",
    company: "Example",
    url: "https://example.com/jobs/security-lead-12345",
    deadline: null,
    ...overrides,
  }
}

describe("explicit source signals", () => {
  test("expires past date-only deadlines at end of day UTC", () => {
    expect(validateExplicitSignals(job({ deadline: "2026-09-03" }), now)?.status).toBe("expired")
  })

  test("does not expire future deadlines", () => {
    expect(validateExplicitSignals(job({ deadline: "2026-09-05" }), now)).toBeNull()
  })

  test("malformed deadlines are ignored", () => {
    expect(validateExplicitSignals(job({ deadline: "soon-ish" }), now)).toBeNull()
  })

  test("source detail inactive is expired", () => {
    expect(validateExplicitSignals(job({ isActive: false }), now)?.method).toBe("source_detail")
  })
})

describe("ATS detection", () => {
  test("detects Greenhouse, Lever, Ashby, and SmartRecruiters public checks", () => {
    expect(detectAts("https://boards.greenhouse.io/acme/jobs/123")?.provider).toBe("greenhouse")
    expect(detectAts("https://jobs.lever.co/acme/abc-123")?.provider).toBe("lever")
    expect(detectAts("https://jobs.ashbyhq.com/acme/abc-123")?.provider).toBe("ashby")
    expect(detectAts("https://careers.smartrecruiters.com/Acme/743999999999999-security-lead")?.provider).toBe("smartrecruiters")
  })

  test("ATS API 404 is expired and API 200 is active", async () => {
    const missing = await validateJobAvailability(job({ url: "https://jobs.lever.co/acme/abc-123" }), {
      now,
      useCache: false,
      resolveHost: safeResolver,
      fetchImpl: async () => response(404),
    })
    expect(missing.validation).toMatchObject({ status: "expired", method: "ats_api", confidence: 100 })

    const active = await validateJobAvailability(job({ url: "https://jobs.lever.co/acme/abc-123" }), {
      now,
      useCache: false,
      resolveHost: safeResolver,
      fetchImpl: async () => response(200, JSON.stringify({ id: "abc-123", text: "Security Lead" })),
    })
    expect(active.validation).toMatchObject({ status: "active", method: "ats_api", confidence: 100 })
  })

  test("ATS API 200 without positive job payload is not active", async () => {
    const checked = await validateJobAvailability(job({ url: "https://jobs.lever.co/acme/abc-123" }), {
      now,
      useCache: false,
      resolveHost: safeResolver,
      fetchImpl: async () => response(200, "{}"),
    })
    expect(checked.validation).toMatchObject({ status: "validation_failed", method: "ats_api" })
  })

  test("Ashby GraphQL error body without jobPosting is expired, not active", async () => {
    const checked = await validateJobAvailability(job({ url: "https://jobs.ashbyhq.com/cantina.security/1cea4c50-2689-44d9-8c0b-4df53dd0736e/" }), {
      now,
      useCache: false,
      resolveHost: safeResolver,
      fetchImpl: async () => response(200, JSON.stringify({ errors: [{ message: "Unidentified server error. We're looking into it!" }] })),
    })
    expect(checked.validation).toMatchObject({ status: "expired", method: "ats_api", confidence: 90 })
  })
})

describe("HTTP and redirects", () => {
  test("HTTP 404 and 410 are expired", async () => {
    for (const status of [404, 410]) {
      const checked = await validateJobAvailability(job(), { now, useCache: false, resolveHost: safeResolver, fetchImpl: async () => response(status) })
      expect(checked.validation.status).toBe("expired")
      expect(checked.validation.method).toBe("http_status")
    }
  })

  test("403, 429, and 500 are validation failures, not expired", async () => {
    for (const status of [403, 429, 500]) {
      const checked = await validateJobAvailability(job(), { now, useCache: false, resolveHost: safeResolver, fetchImpl: async () => response(status) })
      expect(checked.validation.status).toBe("validation_failed")
    }
  })

  test("timeout/network failures are validation failures", async () => {
    const checked = await validateJobAvailability(job(), {
      now,
      useCache: false,
      resolveHost: safeResolver,
      fetchImpl: async () => {
        throw new Error("timeout")
      },
    })
    expect(checked.validation.status).toBe("validation_failed")
  })

  test("detects job-specific redirect to generic careers page", () => {
    expect(isGenericCareersRedirect("https://acme.com/jobs/security-lead-12345", "https://acme.com/careers")).toBe(true)
  })

  test("does not treat http-to-https, locale, trailing slash, or tracking normalization as expired redirects", () => {
    expect(isNormalizationRedirect("http://acme.com/jobs/security-lead-12345?utm_source=x", "https://www.acme.com/en/jobs/security-lead-12345/")).toBe(true)
    expect(isGenericCareersRedirect("https://acme.com/jobs/security-lead-12345?utm_source=x", "https://acme.com/jobs/security-lead-12345")).toBe(false)
  })

  test("legitimate job-specific /jobs path remains active-capable", () => {
    expect(isGenericCareersRedirect("https://acme.com/jobs/security-lead-12345", "https://acme.com/jobs/security-lead-12345/apply")).toBe(false)
  })

  test("redirect to generic careers is classified expired", async () => {
    const checked = await validateJobAvailability(job({ url: "https://acme.com/jobs/security-lead-12345" }), {
      now,
      useCache: false,
      resolveHost: safeResolver,
      fetchImpl: async (url) => url.includes("security-lead") ? response(302, "", { location: "https://acme.com/careers" }) : response(200, "Careers"),
    })
    expect(checked.validation).toMatchObject({ status: "expired", method: "redirect" })
  })
})

describe("HTML and structured data classification", () => {
  test("strong expired phrases expire pages", () => {
    expect(classifyHtml(job(), "<main>This position is no longer available.</main>", now).status).toBe("expired")
    expect(classifyHtml(job(), "<main>This job has expired.</main>", now).status).toBe("expired")
  })

  test("generic words do not false-positive", () => {
    const checked = classifyHtml(job(), "<main><h1>Security Lead</h1><footer>Office closed on holidays</footer></main>", now)
    expect(checked.status).not.toBe("expired")
  })

  test("matching JobPosting with future validThrough is active", () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Security Lead","validThrough":"2026-10-01","hiringOrganization":{"name":"Example"}}</script>`
    expect(classifyHtml(job(), html, now)).toMatchObject({ status: "active", method: "structured_data" })
  })

  test("JobPosting with expired validThrough expires", () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Security Lead","validThrough":"2026-09-01","hiringOrganization":{"name":"Example"}}</script>`
    expect(classifyHtml(job(), html, now)).toMatchObject({ status: "expired", confidence: 100 })
  })

  test("arrays and @graph JSON-LD are supported", () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"JobPosting","title":"Security Lead","validThrough":"2026-10-01","hiringOrganization":{"name":"Example"}}]}</script>`
    expect(classifyHtml(job(), html, now).status).toBe("active")
  })

  test("malformed JSON-LD and malformed HTML do not crash", () => {
    expect(classifyHtml(job(), `<script type="application/ld+json">{bad</script><main><h1>Security Lead`, now).status).toBe("uncertain")
  })

  test("active current JobPosting resists expired phrase for unrelated recommended job", () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Security Lead","validThrough":"2026-10-01","hiringOrganization":{"name":"Example"}}</script><aside>Recommended role: applications are closed</aside>`
    expect(classifyHtml(job(), html, now).status).toBe("active")
  })

  test("apply button plus title/company gives medium-confidence active", () => {
    const checked = classifyHtml(job(), "<main><h1>Security Lead</h1><p>Example</p><a href='/apply'>Apply now</a></main>", now)
    expect(checked).toMatchObject({ status: "active", method: "page_content" })
  })

  test("generic HTTP 200 page is uncertain", () => {
    expect(classifyHtml(job(), "<main>Welcome to our company.</main>", now).status).toBe("uncertain")
  })

  test("old job age alone does not expire it", () => {
    expect(validateExplicitSignals(job({ deadline: null, date: "2020-01-01" }), now)).toBeNull()
  })
})

describe("SSRF safety", () => {
  test("rejects localhost, private IPv4, private IPv6, and non-http schemes", async () => {
    await expect(assertSafeUrl("http://localhost/jobs", safeResolver)).rejects.toThrow()
    await expect(assertSafeUrl("http://127.0.0.1/jobs", safeResolver)).rejects.toThrow()
    await expect(assertSafeUrl("http://[::1]/jobs", safeResolver)).rejects.toThrow()
    await expect(assertSafeUrl("file:///etc/passwd", safeResolver)).rejects.toThrow()
  })

  test("rejects DNS resolution to private addresses", async () => {
    await expect(assertSafeUrl("https://example.com/jobs", async () => ["10.0.0.1"])).rejects.toThrow()
  })

  test("rejects redirect to private address", async () => {
    const checked = await validateJobAvailability(job({ url: "https://example.com/jobs/security-lead-12345" }), {
      now,
      useCache: false,
      resolveHost: async (host) => host === "internal.test" ? ["10.0.0.2"] : ["93.184.216.34"],
      fetchImpl: async () => response(302, "", { location: "http://internal.test/jobs" }),
    })
    expect(checked.validation.status).toBe("validation_failed")
  })
})

describe("cache and batch filtering", () => {
  test("batch validation preserves every concurrent cache update with one reusable cache", async () => {
    const cachePath = `/tmp/availability-cache-${Date.now()}-batch.json`
    const jobs = Array.from({ length: 12 }, (_, index) => job({ url: `https://example.com/jobs/security-${index}-12345` }))
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return response(200, "<h1>Security Lead</h1><p>Example</p><button>Apply now</button>")
    }

    const first = await validateJobs(jobs, { now, cachePath, concurrency: 6, resolveHost: safeResolver, fetchImpl })
    const stored = JSON.parse(await Bun.file(cachePath).text()) as Record<string, unknown>
    expect(first.stats.networkValidations).toBe(jobs.length)
    expect(Object.keys(stored)).toHaveLength(jobs.length)
    expect(calls).toBe(jobs.length)

    const second = await validateJobs(jobs, {
      now: new Date(now.getTime() + 60_000), cachePath, concurrency: 6,
      resolveHost: safeResolver,
      fetchImpl: async () => { throw new Error("cached validations should not fetch") },
    })
    expect(second.stats.cacheHits).toBe(jobs.length)
  })

  test("recent validation avoids refetch", async () => {
    const cachePath = `/tmp/availability-cache-${Date.now()}-active.json`
    let calls = 0
    const first = await validateJobAvailability(job(), { now, cachePath, resolveHost: safeResolver, fetchImpl: async () => { calls += 1; return response(200, "<h1>Security Lead</h1><p>Example</p><button>Apply now</button>") } })
    const second = await validateJobAvailability(job(), { now: new Date("2026-09-04T13:00:00Z"), cachePath, resolveHost: safeResolver, fetchImpl: async () => { calls += 1; return response(404) } })
    expect(first.validation.status).toBe("active")
    expect(second.cacheHit).toBe(true)
    expect(calls).toBe(1)
  })

  test("active TTL expires and refetches", async () => {
    const cachePath = `/tmp/availability-cache-${Date.now()}-ttl.json`
    let calls = 0
    await validateJobAvailability(job(), { now, cachePath, resolveHost: safeResolver, fetchImpl: async () => { calls += 1; return response(200, "<h1>Security Lead</h1><p>Example</p><button>Apply now</button>") } })
    const checked = await validateJobAvailability(job(), { now: new Date("2026-09-05T12:01:00Z"), cachePath, resolveHost: safeResolver, fetchImpl: async () => { calls += 1; return response(404) } })
    expect(checked.cacheHit).toBe(false)
    expect(calls).toBe(2)
  })

  test("transient failure TTL is shorter than expired TTL", async () => {
    const failCache = `/tmp/availability-cache-${Date.now()}-fail.json`
    let failCalls = 0
    await validateJobAvailability(job(), { now, cachePath: failCache, resolveHost: safeResolver, fetchImpl: async () => { failCalls += 1; return response(500) } })
    await validateJobAvailability(job(), { now: new Date("2026-09-04T14:01:00Z"), cachePath: failCache, resolveHost: safeResolver, fetchImpl: async () => { failCalls += 1; return response(200, "<h1>Security Lead</h1><p>Example</p><button>Apply now</button>") } })
    expect(failCalls).toBe(2)

    const expiredCache = `/tmp/availability-cache-${Date.now()}-expired.json`
    let expiredCalls = 0
    const first = await validateJobAvailability(job(), { now, cachePath: expiredCache, resolveHost: safeResolver, fetchImpl: async () => { expiredCalls += 1; return response(404) } })
    const second = await validateJobAvailability(job(), { now: new Date("2026-09-10T12:00:00Z"), cachePath: expiredCache, resolveHost: safeResolver, fetchImpl: async () => { expiredCalls += 1; return response(200) } })
    expect(first.validation.status).toBe("expired")
    expect(second.cacheHit).toBe(true)
    expect(expiredCalls).toBe(1)
  })

  test("batch filters only expired statuses by default", async () => {
    const jobs = [
      job({ url: "https://example.com/jobs/active-12345" }),
      job({ url: "https://example.com/jobs/missing-12345" }),
      job({ url: "https://example.com/jobs/weak-12345" }),
      job({ url: "https://example.com/jobs/blocked-12345" }),
    ]
    const fetchImpl = async (url: string) => {
      if (url.includes("active")) return response(200, "<h1>Security Lead</h1><p>Example</p><button>Apply now</button>")
      if (url.includes("missing")) return response(404)
      if (url.includes("blocked")) return response(429)
      return response(200, "Careers")
    }
    const filtered = await validateJobs(jobs, { now, useCache: false, resolveHost: safeResolver, fetchImpl })
    expect(filtered.results).toHaveLength(3)
    expect(filtered.results.map((item) => item.validation?.status)).toEqual(["active", "uncertain", "validation_failed"])
    expect(filtered.stats).toMatchObject({ total: 4, active: 1, expired: 1, uncertain: 1, validation_failed: 1 })

    const debug = await validateJobs(jobs, { now, useCache: false, resolveHost: safeResolver, fetchImpl, includeUnvalidated: true })
    expect(debug.results).toHaveLength(3)
    expect(debug.results.map((item) => item.validation?.status)).toEqual(["active", "uncertain", "validation_failed"])
  })
})
