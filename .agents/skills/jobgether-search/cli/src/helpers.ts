export const API_URL = "https://jobgether.com/api/v1/jobs"
export const HOST = "jobgether.com"

const UA = "Mozilla/5.0 (compatible; jobgether-search-cli/1.0)"

export interface JobgetherJob {
  id?: string
  title?: string
  company?: string
  url?: string
  location?: string
  remote?: string
  contractType?: string
  experience?: string
  salaryRange?: string
  jobFunctions?: string[]
  postedAt?: string
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
  remote?: boolean | string | null
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
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Unable to fetch jobs: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 300)}` : ""}`)
    }
    return response.json()
  }
  throw new Error("Unable to fetch jobs")
}

export function normalizeDate(raw: string | undefined | null): string | null {
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

export function stripHtml(html: string): string {
  return html.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]{2,}/g, " ").trim()
}

const LOCATION_SLUGS: Record<string, string> = {
  europe: "europe",
  eu: "europe",
  emea: "emea",
  austria: "austria",
  germany: "germany",
  uk: "united-kingdom",
  "united kingdom": "united-kingdom",
  remote: "worldwide",
  worldwide: "worldwide",
}

const EUROPE_TERMS = ["europe", "european", "eu", "emea", "cet", "cest", "austria", "germany", "united kingdom", "uk", "ireland", "france", "spain", "portugal", "italy", "netherlands", "belgium", "denmark", "sweden", "norway", "finland", "poland", "czech", "slovakia", "slovenia", "croatia", "serbia", "romania", "bulgaria", "greece", "hungary", "estonia", "latvia", "lithuania", "switzerland", "worldwide", "anywhere", "global"]

export function locationSlug(location: string | undefined): string | undefined {
  if (!location) return undefined
  return LOCATION_SLUGS[location.trim().toLowerCase()]
}

export function matchesLocation(job: JobResult, location: string | undefined): boolean {
  if (!location) return true
  const haystack = `${job.location ?? ""} ${job.description ?? ""} ${job.remote ?? ""}`.toLowerCase()
  const needle = location.toLowerCase()
  if (["europe", "eu", "emea"].includes(needle)) return EUROPE_TERMS.some((term) => haystack.includes(term))
  if (needle === "remote") return /remote|worldwide|anywhere/i.test(haystack)
  return haystack.includes(needle)
}

export function matchesText(job: JobResult, query: string | undefined): boolean {
  if (!query) return true
  const haystack = [job.title, job.company, job.location, job.description, job.category, job.jobType, ...(job.tags ?? [])].filter(Boolean).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  const posted = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(posted)) return true
  return Date.now() - posted <= days * 24 * 60 * 60 * 1000
}

export function toResult(job: JobgetherJob): JobResult | null {
  const id = job.id?.trim()
  const title = job.title?.trim()
  const url = job.url?.trim()
  if (!id || !title || !url) return null
  return {
    id,
    title: stripHtml(title),
    company: job.company ? stripHtml(job.company) : null,
    location: job.location ? stripHtml(job.location) : null,
    date: normalizeDate(job.postedAt),
    deadline: null,
    url,
    description: job.description ? stripHtml(job.description) : null,
    salary: job.salaryRange || null,
    jobType: job.contractType || null,
    category: Array.isArray(job.jobFunctions) ? job.jobFunctions.join(", ") : null,
    tags: [...(job.jobFunctions ?? []), job.experience, job.remote].filter((tag): tag is string => Boolean(tag)),
    source: "Jobgether",
    remote: job.remote || null,
  }
}

export function parseApi(data: unknown): { jobs: JobResult[]; total: number | null } {
  if (!data || typeof data !== "object" || !Array.isArray((data as { jobs?: unknown[] }).jobs)) return { jobs: [], total: null }
  const jobs = (data as { jobs: JobgetherJob[] }).jobs.map(toResult).filter((job): job is JobResult => job !== null)
  return { jobs, total: jobs.length }
}

export function validateDetailInput(input: string): string {
  if (!/^https?:\/\//.test(input)) return input
  const url = new URL(input)
  if (url.hostname !== HOST && url.hostname !== `www.${HOST}`) throw new Error(`detail URL must belong to ${HOST}`)
  return input
}

export function extractId(input: string): string {
  if (!/^https?:\/\//.test(input)) return input
  const url = new URL(input)
  const match = url.pathname.match(/\/offer\/([a-f0-9]{24})/i)
  return match?.[1] ?? input
}

export function keywordFromDetailInput(input: string): string | undefined {
  if (!/^https?:\/\//.test(input)) return undefined
  const url = new URL(input)
  const slug = url.pathname.split("/").pop() ?? ""
  return slug
    .replace(/^[a-f0-9]{24}-?/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
