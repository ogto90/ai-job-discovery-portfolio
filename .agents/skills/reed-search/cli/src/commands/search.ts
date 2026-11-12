import {
  apiKey,
  appearsSecurityRelevant,
  fetchReed,
  matchesText,
  parseSearchApi,
  searchLocation,
  toResult,
  withinDays,
  type JobResult,
  type ReedDetailJob,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  details?: number
  format: "json" | "table" | "plain"
}

function formatTable(results: JobResult[]): string {
  const rows = results.map((job, i) => [String(i + 1), job.title, job.company ?? "", job.location ?? "", job.date ?? "", job.url])
  return [["#", "Title", "Company", "Location", "Date", "URL"], ...rows].map((row) => row.join("\t")).join("\n")
}

function formatPlain(results: JobResult[]): string {
  return results.map((job) => `${job.title} - ${job.company ?? "Unknown"}\n${job.location ?? "Remote"} · ${job.date ?? "date unknown"}\n${job.url}`).join("\n\n")
}

async function enrichDetails(jobs: JobResult[], maxDetails: number): Promise<JobResult[]> {
  if (maxDetails <= 0) return jobs
  const enriched: JobResult[] = []
  let used = 0
  for (const job of jobs) {
    if (used >= maxDetails || !appearsSecurityRelevant(job)) {
      enriched.push(job)
      continue
    }
    used++
    try {
      const detail = await fetchReed(`/jobs/${encodeURIComponent(job.sourceJobId)}`) as ReedDetailJob
      enriched.push(toResult(detail, "full") ?? job)
    } catch {
      enriched.push(job)
    }
  }
  return enriched
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  if (!apiKey()) {
    process.stdout.write(JSON.stringify({ meta: { count: 0, page: opts.page, total: 0, disabled: true, missingEnv: ["REED_API_KEY"] }, results: [] }, null, 2) + "\n")
    return 0
  }
  const pageSize = Math.min(opts.limit ?? 20, 100)
  const skip = (opts.page - 1) * pageSize
  const data = await fetchReed("/search", {
    keywords: opts.query ?? "security",
    locationName: searchLocation(opts.location),
    resultsToTake: pageSize,
    resultsToSkip: skip,
  })
  const parsed = parseSearchApi(data)
  const filtered = parsed.jobs
    .filter((job) => matchesText(job, opts.query))
    .filter((job) => withinDays(job.date, opts.jobage))
  const results = await enrichDetails(filtered.slice(0, pageSize), opts.details ?? 10)
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ meta: { count: results.length, page: opts.page, total: parsed.total, detailsFetchedMax: opts.details ?? 10 }, results }, null, 2) + "\n")
  } else if (opts.format === "table") {
    process.stdout.write(formatTable(results) + "\n")
  } else {
    process.stdout.write(formatPlain(results) + "\n")
  }
  return 0
}
