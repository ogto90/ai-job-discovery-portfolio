import { RSS_URL, fetchText, matchesLocation, matchesText, parseRss, withinDays, type JobResult } from "../helpers.js"

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
  const all = parseRss(await fetchText(RSS_URL))
  const filtered = all
    .filter((job) => matchesText(job, opts.query))
    .filter((job) => matchesLocation(job, opts.location))
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
