import { API_URL, jsonFetch, matchesNeedle, matchesLocation, matchesRemote, parseResponse, withinDays, type JobResult } from "../helpers.js"

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
  const url = `${API_URL}?page=${opts.page}`
  const parsed = parseResponse(await jsonFetch(url))
  const filtered = parsed.results
    .filter((job) => matchesNeedle(job, opts.query))
    .filter((job) => matchesLocation(job, opts.location))
    .filter((job) => matchesRemote(job, opts.remote))
    .filter((job) => withinDays(job.date, opts.jobage))
  const results = opts.limit ? filtered.slice(0, opts.limit) : filtered
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ meta: { count: results.length, page: opts.page, total: filtered.length, portalTotal: parsed.total }, results }, null, 2) + "\n")
  } else if (opts.format === "table") {
    process.stdout.write(formatTable(results) + "\n")
  } else {
    process.stdout.write(results.map((job) => `${job.title} - ${job.company ?? "Unknown"}\n${job.location ?? "Remote"} · ${job.date ?? "date unknown"}\n${job.url}`).join("\n\n") + "\n")
  }
  return 0
}
