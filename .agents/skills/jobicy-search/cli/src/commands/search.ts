import { API_URL, fetchJson, geoSlug, matchesText, parseApi, withinDays, type JobResult } from "../helpers.js"

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
  url.searchParams.set("count", String(Math.min(Math.max(opts.limit ?? 50, 1), 200)))
  const slug = geoSlug(opts.location)
  if (slug) url.searchParams.set("geo", slug)
  if (opts.query) url.searchParams.set("tag", opts.query.slice(0, 50))
  const filtered = parseApi(await fetchJson(url.toString()))
    .filter((job) => matchesText(job, opts.query))
    .filter((job) => withinDays(job.date, opts.jobage))
  const pageSize = opts.limit ?? 20
  const offset = (opts.page - 1) * pageSize
  const results = filtered.slice(offset, offset + pageSize)
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ meta: { count: results.length, page: opts.page, total: filtered.length }, results }, null, 2) + "\n")
  } else if (opts.format === "table") {
    process.stdout.write(formatTable(results) + "\n")
  } else {
    process.stdout.write(formatPlain(results) + "\n")
  }
  return 0
}
