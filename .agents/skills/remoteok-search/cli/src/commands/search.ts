import { API_URL, jsonFetch, matchesNeedle, matchesLocation, parseFeed, withinDays, type JobResult } from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  remote?: string
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

function formatTable(results: JobResult[]): string {
  const rows = results.map((job, i) => [String(i + 1), job.title, job.company ?? "", job.location ?? "", job.date ?? "", job.url])
  return [["#", "Title", "Company", "Location", "Date", "URL"], ...rows].map((row) => row.join("\t")).join("\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  if ((opts.remote && opts.remote !== "remote") || opts.page > 1) {
    const out = { meta: { count: 0, page: opts.page, total: 0 }, results: [] }
    process.stdout.write(opts.format === "json" ? JSON.stringify(out, null, 2) + "\n" : "")
    return 0
  }
  const all = parseFeed(await jsonFetch(API_URL))
  const filtered = all
    .filter((job) => matchesNeedle(job, opts.query))
    .filter((job) => matchesLocation(job, opts.location))
    .filter((job) => withinDays(job.date, opts.jobage))
  const results = opts.limit ? filtered.slice(0, opts.limit) : filtered
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ meta: { count: results.length, page: opts.page, total: filtered.length }, results }, null, 2) + "\n")
  } else if (opts.format === "table") {
    process.stdout.write(formatTable(results) + "\n")
  } else {
    process.stdout.write(results.map((job) => `${job.title} - ${job.company ?? "Unknown"}\n${job.location ?? "Remote"} · ${job.date ?? "date unknown"}\n${job.url}`).join("\n\n") + "\n")
  }
  return 0
}
