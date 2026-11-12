import {
  SEARCH_API_URL,
  countryCodeForLocation,
  fetchJson,
  matchesLocation,
  matchesText,
  parseApi,
  shouldUseWorldwide,
  totalCount,
  withinDays,
  type JobResult,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

function formatTable(results: JobResult[]): string {
  const rows = results.map((job, i) => [String(i + 1), job.title, job.company ?? "", job.location ?? "", job.date ?? "", job.url])
  return [["#", "Title", "Company", "Location", "Date", "URL"], ...rows].map((row) => row.join("\t")).join("\n")
}

function formatPlain(results: JobResult[]): string {
  return results.map((job) => `${job.title} - ${job.company ?? "Unknown"}\n${job.location ?? "Remote"} · ${job.date ?? "date unknown"}\n${job.url}`).join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  const pageSize = opts.limit ?? 20
  const maxPages = Math.min(Math.ceil(pageSize / 20), 5)
  const filtered: JobResult[] = []
  let total = 0

  for (let pageOffset = 0; pageOffset < maxPages && filtered.length < pageSize; pageOffset++) {
    const url = new URL(SEARCH_API_URL)
    url.searchParams.set("page", String(opts.page + pageOffset))
    if (opts.query) url.searchParams.set("q", opts.query)
    if (opts.location) {
      if (shouldUseWorldwide(opts.location)) url.searchParams.set("worldwide", "true")
      else {
        const country = countryCodeForLocation(opts.location)
        if (country) url.searchParams.set("country", country)
      }
    }
    const data = await fetchJson(url.toString())
    const rawJobs = parseApi(data)
    const jobs = rawJobs
      .filter((job) => matchesText(job, opts.query))
      .filter((job) => matchesLocation(job, opts.location))
      .filter((job) => withinDays(job.date, opts.jobage))
    total = totalCount(data, filtered.length + jobs.length)
    filtered.push(...jobs)
    if (rawJobs.length === 0 || filtered.length >= total) break
  }

  const results = filtered.slice(0, pageSize)
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ meta: { count: results.length, page: opts.page, total }, results }, null, 2) + "\n")
  } else if (opts.format === "table") {
    process.stdout.write(formatTable(results) + "\n")
  } else {
    process.stdout.write(formatPlain(results) + "\n")
  }
  return 0
}
