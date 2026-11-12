import {
  configuredMarkets,
  fetchJooble,
  marketLocation,
  matchesText,
  missingMarketEnv,
  parseApi,
  withinDays,
  type JobResult,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  market?: string
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
  const configured = configuredMarkets()
  const markets = opts.market ? configured.filter((market) => market.code === opts.market?.toLowerCase()) : configured
  if (markets.length === 0) {
    process.stdout.write(JSON.stringify({
      meta: { count: 0, page: opts.page, total: 0, disabled: true, missingEnv: missingMarketEnv() },
      results: [],
    }, null, 2) + "\n")
    return 0
  }

  const pageSize = Math.min(opts.limit ?? 20, 50)
  const results: JobResult[] = []
  let total = 0
  for (const market of markets) {
    const data = await fetchJooble(market, {
      keywords: opts.query ?? "security",
      location: marketLocation(opts.location, market),
      radius: "80",
      page: opts.page,
      ResultOnPage: String(pageSize),
      companysearch: false,
    })
    const parsed = parseApi(data, market)
    total += parsed.total
    results.push(...parsed.jobs
      .filter((job) => matchesText(job, opts.query))
      .filter((job) => withinDays(job.date, opts.jobage)))
  }

  const limited = results.slice(0, pageSize)
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ meta: { count: limited.length, page: opts.page, total, markets: markets.map((market) => market.code) }, results: limited }, null, 2) + "\n")
  } else if (opts.format === "table") {
    process.stdout.write(formatTable(limited) + "\n")
  } else {
    process.stdout.write(formatPlain(limited) + "\n")
  }
  return 0
}
