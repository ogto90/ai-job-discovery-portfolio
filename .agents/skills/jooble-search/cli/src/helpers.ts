const UA = "ai-job-search-jooble-cli/1.0 (+https://github.com/MadsLorentzen/ai-job-search)"
const MAX_ATTEMPTS = 3

interface EnvLike {
  [key: string]: string | undefined
}

export interface MarketConfig {
  code: string
  label: string
  baseUrl: string
  apiKey: string
}

const DEFAULT_MARKETS: Record<string, { label: string; baseUrl: string }> = {
  at: { label: "Austria", baseUrl: "https://at.jooble.org" },
  de: { label: "Germany", baseUrl: "https://de.jooble.org" },
  uk: { label: "United Kingdom", baseUrl: "https://uk.jooble.org" },
  us: { label: "United States", baseUrl: "https://jooble.org" },
}

export interface JoobleJob {
  id?: number | string
  title?: string
  location?: string
  snippet?: string
  salary?: string
  source?: string
  type?: string
  link?: string
  company?: string
  updated?: string
}

export interface JobResult {
  id: string
  sourceJobId: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  deadline: string | null
  url: string
  applicationUrl: string
  sourceUrl: string
  description?: string | null
  excerpt?: string | null
  salary?: string | null
  employmentType?: string | null
  tags?: string[]
  remote?: boolean
  market?: string
  source?: string
  portal?: string
  sourceType?: "aggregator"
  metadata?: Record<string, unknown>
}

export function writeError(error: string, code = "ERROR", details?: string): void {
  process.stderr.write(JSON.stringify({ error, code, ...(details ? { details } : {}) }) + "\n")
}

export function configuredMarkets(env: EnvLike = process.env): MarketConfig[] {
  const requested = (env.JOOBLE_MARKETS ?? "at,de,uk").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)
  return requested.flatMap((code) => {
    const defaults = DEFAULT_MARKETS[code]
    const key = env[`JOOBLE_API_KEY_${code.toUpperCase()}`]
    if (!defaults || !key) return []
    const baseUrl = env[`JOOBLE_API_BASE_${code.toUpperCase()}`] ?? defaults.baseUrl
    return [{ code, label: defaults.label, baseUrl, apiKey: key }]
  })
}

export function missingMarketEnv(env: EnvLike = process.env): string[] {
  const requested = (env.JOOBLE_MARKETS ?? "at,de,uk").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)
  return requested
    .filter((code) => DEFAULT_MARKETS[code] && !env[`JOOBLE_API_KEY_${code.toUpperCase()}`])
    .map((code) => `JOOBLE_API_KEY_${code.toUpperCase()}`)
}

export function marketLocation(input: string | undefined, market: MarketConfig): string {
  if (!input) return market.label
  const needle = input.trim().toLowerCase()
  if (["europe", "eu", "emea", "remote"].includes(needle)) return market.label
  return input
}

export async function fetchJooble(market: MarketConfig, body: Record<string, unknown>): Promise<unknown> {
  const url = new URL(`/api/${encodeURIComponent(market.apiKey)}`, market.baseUrl)
  let delay = 250
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_ATTEMPTS - 1) throw new Error(`Unable to fetch Jooble jobs for ${market.code}: ${response.status} ${response.statusText}`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay *= 2
      continue
    }
    if (!response.ok) throw new Error(`Unable to fetch Jooble jobs for ${market.code}: ${response.status} ${response.statusText}`)
    return response.json()
  }
  throw new Error(`Unable to fetch Jooble jobs for ${market.code}`)
}

export function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function normalizeDate(raw: string | undefined | null): string | null {
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

export function matchesText(job: JobResult, query: string | undefined): boolean {
  if (!query) return true
  const haystack = [job.title, job.company, job.location, job.excerpt, job.employmentType, ...(job.tags ?? [])]
    .filter(Boolean).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  const posted = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(posted)) return true
  return Date.now() - posted <= days * 24 * 60 * 60 * 1000
}

export function toResult(job: JoobleJob, market: MarketConfig): JobResult | null {
  const id = String(job.id ?? job.link ?? "").trim()
  const title = job.title?.trim()
  const url = job.link?.trim()
  if (!id || !title || !url) return null
  const snippet = job.snippet ? stripHtml(job.snippet) : null
  return {
    id: `${market.code}:${id}`,
    sourceJobId: String(id),
    title: stripHtml(title),
    company: job.company ? stripHtml(job.company) : null,
    location: job.location ? stripHtml(job.location) : market.label,
    date: normalizeDate(job.updated),
    deadline: null,
    url,
    applicationUrl: url,
    sourceUrl: url,
    description: null,
    excerpt: snippet,
    salary: job.salary || null,
    employmentType: job.type || null,
    tags: [job.type, market.label, "Jooble"].filter((tag): tag is string => Boolean(tag)),
    remote: /remote|home.?based/i.test(`${job.title ?? ""} ${job.location ?? ""} ${snippet ?? ""}`),
    market: market.code,
    source: "jooble-search",
    portal: "jooble-search",
    sourceType: "aggregator",
    metadata: {
      provider: "Jooble",
      rawProvider: "jooble",
      market: market.code,
      marketBaseUrl: market.baseUrl,
      descriptionCompleteness: snippet ? "snippet" : "missing",
      originalFields: job,
    },
  }
}

export function parseApi(data: unknown, market: MarketConfig): { total: number; jobs: JobResult[] } {
  if (!data || typeof data !== "object") return { total: 0, jobs: [] }
  const obj = data as { totalCount?: unknown; jobs?: unknown[] }
  const rows = Array.isArray(obj.jobs) ? obj.jobs : []
  return {
    total: typeof obj.totalCount === "number" ? obj.totalCount : rows.length,
    jobs: (rows as JoobleJob[]).map((job) => toResult(job, market)).filter((job): job is JobResult => job !== null),
  }
}
