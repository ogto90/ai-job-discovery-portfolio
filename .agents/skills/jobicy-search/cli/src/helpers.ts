export const API_URL = "https://jobicy.com/api/v2/remote-jobs"
export const HOST = "jobicy.com"

const UA = "ai-job-search-jobicy-cli/1.0 (+https://github.com/MadsLorentzen/ai-job-search)"
const MAX_ATTEMPTS = 3
const MAX_RETRY_AFTER_MS = 20_000
const RETRYABLE_PARSE_PATTERNS = [/unterminated/i, /unexpected end/i, /unexpected eof/i, /end of json/i]

export interface JobicyJob {
  id?: number | string
  url?: string
  jobSlug?: string
  jobTitle?: string
  companyName?: string
  companyLogo?: string
  jobIndustry?: string[]
  jobType?: string[]
  jobGeo?: string
  jobLevel?: string
  jobExcerpt?: string
  jobDescription?: string
  pubDate?: string
  salaryMin?: number | null
  salaryMax?: number | null
  salaryCurrency?: string | null
  salaryPeriod?: string | null
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
  salaryPeriod?: string | null
  employmentType?: string | null
  jobType?: string[] | null
  categories?: string[]
  tags?: string[]
  remote?: boolean
  remoteScope?: string | null
  seniority?: string | null
  companyLogo?: string | null
  source?: string
  portal?: string
  sourceType?: "aggregator"
  metadata?: Record<string, unknown>
}

export function writeError(error: string, code = "ERROR", details?: string): void {
  process.stderr.write(JSON.stringify({ error, code, ...(details ? { details } : {}) }) + "\n")
}

export async function fetchJson(url: string, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<unknown> {
  let delay = 1_000
  let lastParseError: string | null = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_ATTEMPTS - 1) throw new Error(`Unable to fetch Jobicy jobs: ${response.status} ${response.statusText}`)
      const retryAfter = response.status === 429 ? response.headers.get("Retry-After") : null
      const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1_000 : null
      const date = retryAfter && seconds === null ? Date.parse(retryAfter) : Number.NaN
      const requestedDelay = seconds ?? (Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0)
      if (requestedDelay > MAX_RETRY_AFTER_MS) {
        throw new Error("Unable to fetch Jobicy jobs: 429 Too Many Requests (Retry-After exceeds bounded retry window)")
      }
      await sleep(Math.max(delay + Math.floor(Math.random() * 250), requestedDelay))
      delay *= 2
      continue
    }
    if (!response.ok) throw new Error(`Unable to fetch Jobicy jobs: ${response.status} ${response.statusText}`)
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      lastParseError = reason
      const retryable = RETRYABLE_PARSE_PATTERNS.some((pattern) => pattern.test(reason))
      const diagnostics = [
        `status=${response.status}`,
        `content-type=${response.headers.get("content-type") ?? "unknown"}`,
        `bytes=${new TextEncoder().encode(text).length}`,
        `content-length=${response.headers.get("content-length") ?? "unknown"}`,
        `attempt=${attempt + 1}`,
        `parser=${reason}`,
      ].join("; ")
      if (!retryable || attempt === MAX_ATTEMPTS - 1) throw new Error(`Jobicy JSON parse failed: ${diagnostics}`)
      await sleep(delay)
      delay *= 2
      continue
    }
  }
  throw new Error(lastParseError ? `Unable to fetch Jobicy jobs: ${lastParseError}` : "Unable to fetch Jobicy jobs")
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

function salary(job: JobicyJob): string | null {
  const min = typeof job.salaryMin === "number" ? job.salaryMin : null
  const max = typeof job.salaryMax === "number" ? job.salaryMax : null
  if (min === null && max === null) return null
  const currency = job.salaryCurrency ?? ""
  const period = job.salaryPeriod ? ` ${job.salaryPeriod}` : ""
  if (min !== null && max !== null) return `${min} - ${max} ${currency}${period}`.trim()
  return `${min ?? max} ${currency}${period}`.trim()
}

export function geoSlug(location: string | undefined): string | null {
  if (!location) return null
  const needle = location.trim().toLowerCase()
  if (["europe", "eu", "emea"].includes(needle)) return "europe"
  if (["remote", "worldwide", "global", "anywhere"].includes(needle)) return "anywhere"
  if (needle === "united kingdom" || needle === "uk") return "uk"
  if (needle === "austria") return "austria"
  if (needle === "germany") return "germany"
  return null
}

export function matchesText(job: JobResult, query: string | undefined): boolean {
  if (!query) return true
  const haystack = [
    job.title, job.company, job.location, job.description, job.excerpt, job.employmentType,
    job.remoteScope, job.seniority, ...(job.categories ?? []), ...(job.tags ?? []),
  ].filter(Boolean).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  const posted = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(posted)) return true
  return Date.now() - posted <= days * 24 * 60 * 60 * 1000
}

export function toResult(job: JobicyJob): JobResult | null {
  const id = String(job.id ?? job.jobSlug ?? "").trim()
  const title = job.jobTitle?.trim()
  const url = job.url?.trim()
  if (!id || !title || !url) return null
  const description = job.jobDescription ? stripHtml(job.jobDescription) : null
  const excerpt = job.jobExcerpt ? stripHtml(job.jobExcerpt) : null
  const types = Array.isArray(job.jobType) ? job.jobType.filter(Boolean) : []
  const industries = Array.isArray(job.jobIndustry) ? job.jobIndustry.filter(Boolean) : []
  return {
    id,
    sourceJobId: id,
    title: stripHtml(title),
    company: job.companyName ? stripHtml(job.companyName) : null,
    location: job.jobGeo ? `Remote ${stripHtml(job.jobGeo)}` : "Remote",
    date: normalizeDate(job.pubDate),
    deadline: null,
    url,
    applicationUrl: url,
    sourceUrl: url,
    description,
    excerpt,
    salary: salary(job),
    salaryMin: typeof job.salaryMin === "number" ? job.salaryMin : null,
    salaryMax: typeof job.salaryMax === "number" ? job.salaryMax : null,
    salaryCurrency: job.salaryCurrency ?? null,
    salaryPeriod: job.salaryPeriod ?? null,
    employmentType: types.join(", ") || null,
    jobType: types,
    categories: industries,
    tags: [...industries, ...types, job.jobLevel].filter((tag): tag is string => Boolean(tag)),
    remote: true,
    remoteScope: job.jobGeo ?? null,
    seniority: job.jobLevel ?? null,
    companyLogo: job.companyLogo ?? null,
    source: "jobicy-search",
    portal: "jobicy-search",
    sourceType: "aggregator",
    metadata: {
      provider: "Jobicy",
      rawProvider: "jobicy",
      descriptionCompleteness: description ? "full" : excerpt ? "snippet" : "missing",
      originalFields: job,
    },
  }
}

export function parseApi(data: unknown): JobResult[] {
  if (!data || typeof data !== "object" || !Array.isArray((data as { jobs?: unknown[] }).jobs)) return []
  return (data as { jobs: JobicyJob[] }).jobs.map(toResult).filter((job): job is JobResult => job !== null)
}

export function validateDetailInput(input: string): string {
  if (!/^https?:\/\//.test(input)) return input
  const url = new URL(input)
  if (url.hostname !== HOST && url.hostname !== `www.${HOST}`) throw new Error(`detail URL must belong to ${HOST}`)
  return input
}
