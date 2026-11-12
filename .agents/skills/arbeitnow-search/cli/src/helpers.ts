export const API_URL = "https://www.arbeitnow.com/api/job-board-api"

const UA = "Mozilla/5.0 (compatible; arbeitnow-search-cli/1.0)"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export interface ArbeitnowJob {
  slug?: string
  company_name?: string
  title?: string
  description?: string
  remote?: boolean
  url?: string
  tags?: string[]
  job_types?: string[]
  location?: string
  created_at?: number
}

export interface ArbeitnowResponse {
  data?: ArbeitnowJob[]
  meta?: { total?: number; current_page?: number }
}

export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  deadline: string | null
  url: string
  description: string | null
  remote: boolean
  tags: string[]
}

export async function jsonFetch(url: string): Promise<unknown> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((resolve) => setTimeout(resolve, delay + jitter))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (!response.ok) throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    return response.json()
  }
  throw new Error("Request failed after max retries")
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

function normalizeDate(epoch: number | undefined): string | null {
  if (!epoch) return null
  const date = new Date(epoch * 1000)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

export function toResult(job: ArbeitnowJob): JobResult | null {
  const id = job.slug?.trim()
  const title = job.title?.trim()
  if (!id || !title) return null
  const description = job.description ? stripHtml(job.description) : null
  return {
    id,
    title,
    company: job.company_name?.trim() || null,
    location: job.location?.trim() || (job.remote ? "Remote" : null),
    date: normalizeDate(job.created_at),
    deadline: null,
    url: job.url?.trim() || `https://www.arbeitnow.com/jobs/${id}`,
    description,
    remote: Boolean(job.remote),
    tags: [
      ...(Array.isArray(job.tags) ? job.tags : []),
      ...(Array.isArray(job.job_types) ? job.job_types : []),
    ].filter((tag): tag is string => typeof tag === "string"),
  }
}

export function parseResponse(data: unknown): { total: number | null; results: JobResult[] } {
  if (!data || typeof data !== "object" || !Array.isArray((data as ArbeitnowResponse).data)) {
    return { total: null, results: [] }
  }
  return {
    total: (data as ArbeitnowResponse).meta?.total ?? null,
    results: ((data as ArbeitnowResponse).data ?? []).map(toResult).filter((item): item is JobResult => item !== null),
  }
}

export function matchesNeedle(job: JobResult, needle: string | undefined): boolean {
  if (!needle) return true
  const haystack = [job.title, job.company, job.location, job.description, ...job.tags].filter(Boolean).join(" ").toLowerCase()
  return needle.toLowerCase().split(/\s+/).every((part) => haystack.includes(part))
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  const posted = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(posted)) return true
  return Date.now() - posted <= days * 24 * 60 * 60 * 1000
}

export function matchesRemote(job: JobResult, mode: string | undefined): boolean {
  if (!mode) return true
  if (mode === "remote") return job.remote
  if (mode === "onsite") return !job.remote
  if (mode === "hybrid") {
    const text = [job.title, job.location, job.description, ...job.tags].filter(Boolean).join(" ").toLowerCase()
    return text.includes("hybrid")
  }
  return true
}

export function matchesLocation(job: JobResult, location: string | undefined): boolean {
  if (!location) return true
  if (/^(europe|eu|emea)$/i.test(location)) {
    return /\b(europe|european|eu|eea|emea|worldwide|anywhere|global|austria|vienna|germany|france|spain|portugal|italy|ireland|united kingdom|uk|netherlands|belgium|poland|czechia|czech republic|sweden|norway|denmark|finland|switzerland|greece|romania|bulgaria|estonia|latvia|lithuania|hungary|croatia|slovenia|slovakia|cyprus|malta|luxembourg|iceland)\b/i.test(String(job.location ?? ""))
      || !job.location
  }
  return matchesNeedle(job, location)
}
