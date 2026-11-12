export const API_BASE = "https://api.adzuna.com/v1/api"

const UA = "ai-job-search-adzuna-cli/1.0 (+https://github.com/MadsLorentzen/ai-job-search)"
const MAX_ATTEMPTS = 3

interface EnvLike {
  [key: string]: string | undefined
}

export interface MarketConfig {
  code: string
  label: string
}

const DEFAULT_MARKETS: Record<string, MarketConfig> = {
  at: { code: "at", label: "Austria" },
  de: { code: "de", label: "Germany" },
  gb: { code: "gb", label: "United Kingdom" },
  nl: { code: "nl", label: "Netherlands" },
  fr: { code: "fr", label: "France" },
  ie: { code: "ie", label: "Ireland" },
  es: { code: "es", label: "Spain" },
  it: { code: "it", label: "Italy" },
  be: { code: "be", label: "Belgium" },
  ch: { code: "ch", label: "Switzerland" },
  pl: { code: "pl", label: "Poland" },
}

export interface AdzunaJob {
  id?: string
  title?: string
  description?: string
  redirect_url?: string
  created?: string
  company?: { display_name?: string }
  location?: { display_name?: string; area?: string[] }
  category?: { label?: string; tag?: string }
  salary_min?: number
  salary_max?: number
  salary_is_predicted?: string | number | boolean
  contract_time?: string
  contract_type?: string
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
  salaryMin?: number | null
  salaryMax?: number | null
  salaryCurrency?: string | null
  employmentType?: string | null
  categories?: string[]
  tags?: string[]
  remote?: boolean
  remoteScope?: string | null
  market?: string
  source?: string
  portal?: string
  sourceType?: "aggregator"
  metadata?: Record<string, unknown>
}

export function writeError(error: string, code = "ERROR", details?: string): void {
  process.stderr.write(JSON.stringify({ error, code, ...(details ? { details } : {}) }) + "\n")
}

export function missingEnv(env: EnvLike = process.env): string[] {
  const missing: string[] = []
  if (!env.ADZUNA_APP_ID?.trim()) missing.push("ADZUNA_APP_ID")
  if (!env.ADZUNA_APP_KEY?.trim()) missing.push("ADZUNA_APP_KEY")
  return missing
}

export function configuredMarkets(env: EnvLike = process.env): MarketConfig[] {
  const requested = (env.ADZUNA_MARKETS ?? "gb,de,at,nl,fr,ie").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)
  return requested.flatMap((code) => DEFAULT_MARKETS[code] ? [DEFAULT_MARKETS[code]] : [])
}

function apiBase(env: EnvLike): string {
  return env.ADZUNA_API_BASE?.trim() || API_BASE
}

function formatSalary(job: AdzunaJob): string | null {
  const min = typeof job.salary_min === "number" ? job.salary_min : null
  const max = typeof job.salary_max === "number" ? job.salary_max : null
  if (min === null && max === null) return null
  if (min !== null && max !== null) return `${min} - ${max}`
  return String(min ?? max)
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
  const haystack = [
    job.title, job.company, job.location, job.description, job.excerpt, job.employmentType,
    ...(job.categories ?? []), ...(job.tags ?? []),
  ].filter(Boolean).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  const posted = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(posted)) return true
  return Date.now() - posted <= days * 24 * 60 * 60 * 1000
}

export function toResult(job: AdzunaJob, market: MarketConfig): JobResult | null {
  const id = String(job.id ?? job.redirect_url ?? "").trim()
  const title = job.title?.trim()
  const url = job.redirect_url?.trim()
  if (!id || !title || !url) return null
  const description = job.description ? stripHtml(job.description) : null
  const location = job.location?.display_name?.trim() || job.location?.area?.filter(Boolean).join(", ") || market.label
  const tags = [job.category?.label, job.category?.tag, job.contract_time, job.contract_type, market.label, "Adzuna"].filter((tag): tag is string => Boolean(tag))
  return {
    id: `${market.code}:${id}`,
    sourceJobId: id,
    title: stripHtml(title),
    company: job.company?.display_name ? stripHtml(job.company.display_name) : null,
    location,
    date: normalizeDate(job.created),
    deadline: null,
    url,
    applicationUrl: url,
    sourceUrl: url,
    description,
    excerpt: description,
    salary: formatSalary(job),
    salaryMin: typeof job.salary_min === "number" ? job.salary_min : null,
    salaryMax: typeof job.salary_max === "number" ? job.salary_max : null,
    salaryCurrency: null,
    employmentType: [job.contract_time, job.contract_type].filter(Boolean).join(", ") || null,
    categories: job.category?.label ? [job.category.label] : [],
    tags,
    remote: /remote|home.?based|work from home/i.test(`${title} ${location} ${description ?? ""}`),
    remoteScope: location,
    market: market.code,
    source: "adzuna-search",
    portal: "adzuna-search",
    sourceType: "aggregator",
    metadata: {
      provider: "Adzuna",
      rawProvider: "adzuna",
      market: market.code,
      descriptionCompleteness: description && description.length >= 600 ? "full" : description ? "snippet" : "missing",
      salaryPredicted: job.salary_is_predicted ?? null,
      originalFields: job,
    },
  }
}

export function parseApi(data: unknown, market: MarketConfig): { total: number; jobs: JobResult[] } {
  if (!data || typeof data !== "object") return { total: 0, jobs: [] }
  const obj = data as { count?: unknown; results?: unknown[] }
  const rows = Array.isArray(obj.results) ? obj.results : []
  return {
    total: typeof obj.count === "number" ? obj.count : rows.length,
    jobs: (rows as AdzunaJob[]).map((job) => toResult(job, market)).filter((job): job is JobResult => job !== null),
  }
}

export async function fetchAdzuna(market: MarketConfig, opts: {
  query?: string
  location?: string
  page: number
  limit: number
}, env: EnvLike = process.env): Promise<unknown> {
  const missing = missingEnv(env)
  if (missing.length > 0) throw new Error(`Adzuna credentials missing: ${missing.join(", ")}`)
  const url = new URL(`/jobs/${encodeURIComponent(market.code)}/search/${opts.page}`, apiBase(env))
  url.searchParams.set("app_id", env.ADZUNA_APP_ID ?? "")
  url.searchParams.set("app_key", env.ADZUNA_APP_KEY ?? "")
  url.searchParams.set("results_per_page", String(Math.min(Math.max(opts.limit, 1), 50)))
  url.searchParams.set("sort_by", "date")
  url.searchParams.set("content-type", "application/json")
  if (opts.query) url.searchParams.set("what", opts.query)
  if (opts.location) url.searchParams.set("where", opts.location)

  let delay = 300
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_ATTEMPTS - 1) throw new Error(`Unable to fetch Adzuna jobs for ${market.code}: ${response.status} ${response.statusText}`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay *= 2
      continue
    }
    if (!response.ok) throw new Error(`Unable to fetch Adzuna jobs for ${market.code}: ${response.status} ${response.statusText}`)
    return response.json()
  }
  throw new Error(`Unable to fetch Adzuna jobs for ${market.code}`)
}
