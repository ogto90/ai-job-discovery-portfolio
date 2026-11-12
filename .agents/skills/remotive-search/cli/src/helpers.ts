export const API_URL = "https://remotive.com/api/remote-jobs"
export const HOST = "remotive.com"

const UA = "Mozilla/5.0 (compatible; remotive-search-cli/1.0)"

export interface RemotiveJob {
  id?: number | string
  url?: string
  title?: string
  company_name?: string
  category?: string
  job_type?: string
  publication_date?: string
  candidate_required_location?: string
  salary?: string
  description?: string
}

export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  deadline: string | null
  url: string
  description?: string | null
  salary?: string | null
  jobType?: string | null
  category?: string | null
  tags?: string[]
  source?: string
  remote?: boolean
}

export function writeError(error: string, code = "ERROR", details?: string): void {
  process.stderr.write(JSON.stringify({ error, code, ...(details ? { details } : {}) }) + "\n")
}

export async function fetchJson(url: string): Promise<unknown> {
  let delay = 500
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 3) throw new Error(`Unable to fetch jobs: ${response.status} ${response.statusText}`)
      await new Promise((resolve) => setTimeout(resolve, delay + Math.floor(Math.random() * 250)))
      delay *= 2
      continue
    }
    if (!response.ok) throw new Error(`Unable to fetch jobs: ${response.status} ${response.statusText}`)
    return response.json()
  }
  throw new Error("Unable to fetch jobs")
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

export function decodeEntities(text: string): string {
  return stripHtml(text)
}

export function normalizeDate(raw: string | undefined | null): string | null {
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

export const EUROPE_TERMS = [
  "europe", "european", "eu", "emea", "cet", "cest", "austria", "germany", "uk", "united kingdom",
  "ireland", "france", "spain", "portugal", "italy", "netherlands", "belgium", "denmark", "sweden",
  "norway", "finland", "poland", "czech", "slovakia", "slovenia", "croatia", "serbia", "romania",
  "bulgaria", "greece", "hungary", "estonia", "latvia", "lithuania", "switzerland", "malta", "cyprus",
  "worldwide", "anywhere", "global",
]

export function matchesText(job: JobResult, query: string | undefined): boolean {
  if (!query) return true
  const haystack = [job.title, job.company, job.location, job.description, job.category, job.jobType, ...(job.tags ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
}

export function matchesLocation(job: JobResult, location: string | undefined): boolean {
  if (!location) return true
  const haystack = `${job.location ?? ""} ${job.description ?? ""}`.toLowerCase()
  const needle = location.toLowerCase()
  if (["europe", "eu", "emea"].includes(needle)) return EUROPE_TERMS.some((term) => haystack.includes(term))
  if (needle === "remote") return job.remote === true || /remote|worldwide|anywhere/i.test(haystack)
  return haystack.includes(needle)
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  const posted = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(posted)) return true
  return Date.now() - posted <= days * 24 * 60 * 60 * 1000
}

export function toResult(job: RemotiveJob): JobResult | null {
  const id = String(job.id ?? "").trim()
  const title = job.title?.trim()
  const url = job.url?.trim()
  if (!id || !title || !url) return null
  return {
    id,
    title: decodeEntities(title),
    company: job.company_name ? decodeEntities(job.company_name) : null,
    location: job.candidate_required_location ? decodeEntities(job.candidate_required_location) : "Remote",
    date: normalizeDate(job.publication_date),
    deadline: null,
    url,
    description: job.description ? stripHtml(job.description) : null,
    salary: job.salary || null,
    jobType: job.job_type || null,
    category: job.category || null,
    tags: [job.category, job.job_type].filter((tag): tag is string => Boolean(tag)),
    source: "Remotive",
    remote: true,
  }
}

export function parseApi(data: unknown): JobResult[] {
  if (!data || typeof data !== "object" || !Array.isArray((data as { jobs?: unknown[] }).jobs)) return []
  return (data as { jobs: RemotiveJob[] }).jobs.map(toResult).filter((job): job is JobResult => job !== null)
}

export function validateDetailInput(input: string): string {
  if (!/^https?:\/\//.test(input)) return input
  const url = new URL(input)
  if (url.hostname !== HOST && url.hostname !== `www.${HOST}`) throw new Error(`detail URL must belong to ${HOST}`)
  return input
}
