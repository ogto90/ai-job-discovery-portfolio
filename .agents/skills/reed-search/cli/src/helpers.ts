export const API_BASE = "https://www.reed.co.uk/api/1.0"
export const HOST = "www.reed.co.uk"

const UA = "ai-job-search-reed-cli/1.0 (+https://github.com/MadsLorentzen/ai-job-search)"
const MAX_ATTEMPTS = 3

export interface ReedSearchJob {
  jobId?: number | string
  employerId?: number | string
  employerName?: string
  employerProfileId?: number | string
  jobTitle?: string
  description?: string
  locationName?: string
  minimumSalary?: number | null
  maximumSalary?: number | null
  currency?: string | null
  date?: string
  datePosted?: string
  expirationDate?: string
  jobDescription?: string
  jobUrl?: string
}

export interface ReedDetailJob extends ReedSearchJob {
  yearlyMinimumSalary?: number | null
  yearlyMaximumSalary?: number | null
  salaryType?: string | null
  contractType?: string | null
  jobType?: string | null
  externalUrl?: string | null
}

export interface JobResult {
  id: string
  sourceJobId: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  deadline: string | null
  validThrough?: string | null
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
  contractType?: string | null
  tags?: string[]
  remote?: boolean
  source?: string
  portal?: string
  sourceType?: "aggregator"
  metadata?: Record<string, unknown>
}

export function writeError(error: string, code = "ERROR", details?: string): void {
  process.stderr.write(JSON.stringify({ error, code, ...(details ? { details } : {}) }) + "\n")
}

export function apiKey(): string | null {
  const key = process.env.REED_API_KEY?.trim()
  return key || null
}

function authHeader(key: string): string {
  return `Basic ${btoa(`${key}:`)}`
}

export async function fetchReed(path: string, params: Record<string, string | number | boolean | undefined> = {}, key = apiKey()): Promise<unknown> {
  if (!key) throw new Error("REED_API_KEY is not configured")
  const url = new URL(`${API_BASE}${path}`)
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value))
  }
  let delay = 250
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Authorization: authHeader(key),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_ATTEMPTS - 1) throw new Error(`Unable to fetch Reed jobs: ${response.status} ${response.statusText}`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay *= 2
      continue
    }
    if (!response.ok) throw new Error(`Unable to fetch Reed jobs: ${response.status} ${response.statusText}`)
    return response.json()
  }
  throw new Error("Unable to fetch Reed jobs")
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
  const dmy = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) {
    const [, day, month, year] = dmy
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
  }
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

export function searchLocation(input: string | undefined): string | undefined {
  if (!input) return undefined
  const needle = input.trim().toLowerCase()
  if (["remote", "europe", "eu", "emea"].includes(needle)) return "Remote"
  return input
}

function salary(job: ReedSearchJob | ReedDetailJob): string | null {
  const min = typeof job.minimumSalary === "number" ? job.minimumSalary : typeof (job as ReedDetailJob).yearlyMinimumSalary === "number" ? (job as ReedDetailJob).yearlyMinimumSalary! : null
  const max = typeof job.maximumSalary === "number" ? job.maximumSalary : typeof (job as ReedDetailJob).yearlyMaximumSalary === "number" ? (job as ReedDetailJob).yearlyMaximumSalary! : null
  if (min === null && max === null) return null
  const currency = (job as ReedDetailJob).currency ?? "GBP"
  const period = (job as ReedDetailJob).salaryType ? ` ${(job as ReedDetailJob).salaryType}` : ""
  if (min !== null && max !== null) return `${min} - ${max} ${currency}${period}`.trim()
  return `${min ?? max} ${currency}${period}`.trim()
}

export function matchesText(job: JobResult, query: string | undefined): boolean {
  if (!query) return true
  const haystack = [job.title, job.company, job.location, job.description, job.excerpt, job.employmentType, job.contractType, ...(job.tags ?? [])]
    .filter(Boolean).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
}

export function appearsSecurityRelevant(job: JobResult): boolean {
  return /\b(appsec|application security|product security|security engineer|cybersecurity|cyber security|information security|vulnerability|secure coding|grc|security manager|security lead)\b/i
    .test([job.title, job.company, job.location, job.description, job.excerpt, ...(job.tags ?? [])].filter(Boolean).join(" "))
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  const posted = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(posted)) return true
  return Date.now() - posted <= days * 24 * 60 * 60 * 1000
}

export function toResult(job: ReedSearchJob | ReedDetailJob, completeness: "snippet" | "full" = "snippet"): JobResult | null {
  const id = String(job.jobId ?? "").trim()
  const title = job.jobTitle?.trim()
  if (!id || !title) return null
  const reedUrl = job.jobUrl?.trim() || `https://www.reed.co.uk/jobs/${id}`
  const detail = job as ReedDetailJob
  const rawDescription = job.jobDescription ?? job.description
  const description = rawDescription ? stripHtml(rawDescription) : null
  const apply = typeof detail.externalUrl === "string" && detail.externalUrl.trim() ? detail.externalUrl.trim() : reedUrl
  const min = typeof job.minimumSalary === "number" ? job.minimumSalary : typeof detail.yearlyMinimumSalary === "number" ? detail.yearlyMinimumSalary : null
  const max = typeof job.maximumSalary === "number" ? job.maximumSalary : typeof detail.yearlyMaximumSalary === "number" ? detail.yearlyMaximumSalary : null
  return {
    id,
    sourceJobId: id,
    title: stripHtml(title),
    company: job.employerName ? stripHtml(job.employerName) : null,
    location: job.locationName ? stripHtml(job.locationName) : null,
    date: normalizeDate(job.datePosted ?? job.date),
    deadline: normalizeDate(job.expirationDate),
    validThrough: normalizeDate(job.expirationDate),
    url: reedUrl,
    applicationUrl: apply,
    sourceUrl: reedUrl,
    description: completeness === "full" ? description : null,
    excerpt: completeness === "full" ? null : description,
    salary: salary(job),
    salaryMin: min,
    salaryMax: max,
    salaryCurrency: detail.currency ?? "GBP",
    salaryPeriod: detail.salaryType ?? null,
    employmentType: detail.jobType ?? null,
    contractType: detail.contractType ?? null,
    tags: [detail.jobType, detail.contractType].filter((tag): tag is string => Boolean(tag)),
    remote: /remote|home.?based/i.test(`${job.jobTitle ?? ""} ${job.locationName ?? ""} ${description ?? ""}`),
    source: "reed-search",
    portal: "reed-search",
    sourceType: "aggregator",
    metadata: {
      provider: "Reed",
      rawProvider: "reed",
      descriptionCompleteness: completeness === "full" && description ? "full" : description ? "snippet" : "missing",
      originalFields: job,
    },
  }
}

export function parseSearchApi(data: unknown): { total: number; jobs: JobResult[] } {
  if (!data || typeof data !== "object") return { total: 0, jobs: [] }
  const obj = data as { totalResults?: unknown; results?: unknown[] }
  const rows = Array.isArray(obj.results) ? obj.results : []
  return {
    total: typeof obj.totalResults === "number" ? obj.totalResults : rows.length,
    jobs: (rows as ReedSearchJob[]).map((job) => toResult(job, "snippet")).filter((job): job is JobResult => job !== null),
  }
}
