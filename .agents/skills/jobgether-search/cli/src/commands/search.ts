import { API_URL, fetchJson, locationSlug, matchesLocation, matchesText, parseApi, withinDays, type JobResult } from "../helpers.js"

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
  const url = new URL(API_URL)
  if (opts.query) url.searchParams.set("keyword", opts.query)
  const slug = locationSlug(opts.location)
  if (slug && opts.location?.toLowerCase() !== "remote") url.searchParams.set("locations", slug)
  url.searchParams.set("remoteType", "full-remote")
  url.searchParams.set("sort", "date")
  url.searchParams.set("page", String(opts.page))
  url.searchParams.set("limit", String(Math.min(opts.limit ?? 20, 25)))
  const parsed = parseApi(await fetchJson(url.toString()))
  const filtered = parsed.jobs
    .filter((job) => matchesText(job, opts.query))
    .filter((job) => matchesLocation(job, opts.location))
    .filter((job) => withinDays(job.date, opts.jobage))
  const results = opts.limit ? filtered.slice(0, opts.limit) : filtered
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ meta: { count: results.length, page: opts.page, total: parsed.total ?? filtered.length }, results }, null, 2) + "\n")
  } else if (opts.format === "table") {
    process.stdout.write(formatTable(results) + "\n")
  } else {
    process.stdout.write(formatPlain(results) + "\n")
  }
  return 0
}
