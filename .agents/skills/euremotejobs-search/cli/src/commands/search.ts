import { API_URL, fetchJson, matchesLocation, matchesText, parseApi, withinDays, type JobResult } from "../helpers.js"

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
  if (opts.query) url.searchParams.set("search", opts.query)
  url.searchParams.set("page", String(opts.page))
  url.searchParams.set("per_page", String(Math.min(opts.limit ?? 20, 100)))
  url.searchParams.set("orderby", "date")
  url.searchParams.set("order", "desc")
  const all = parseApi(await fetchJson(url.toString()))
  const filtered = all
    .filter((job) => matchesText(job, opts.query))
    .filter((job) => matchesLocation(job, opts.location))
    .filter((job) => withinDays(job.date, opts.jobage))
  const results = opts.limit ? filtered.slice(0, opts.limit) : filtered
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ meta: { count: results.length, page: opts.page, total: filtered.length }, results }, null, 2) + "\n")
  } else if (opts.format === "table") {
    process.stdout.write(formatTable(results) + "\n")
  } else {
    process.stdout.write(formatPlain(results) + "\n")
  }
  return 0
}
