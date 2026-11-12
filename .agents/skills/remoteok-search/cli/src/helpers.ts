export const API_URL = "https://remoteok.com/api"

const UA = "Mozilla/5.0 (compatible; remoteok-search-cli/1.0)"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export interface RemoteOkJob {
  id?: string | number
  slug?: string
  date?: string
  epoch?: number
  company?: string
  position?: string
  location?: string
  tags?: string[]
  description?: string
  url?: string
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

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function normalizeDate(raw: string | undefined, epoch: number | undefined): string | null {
  if (raw) {
    const date = new Date(raw)
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
  }
  if (epoch) {
    const date = new Date(epoch * 1000)
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
  }
  return null
}

export function toResult(job: RemoteOkJob): JobResult | null {
  const title = job.position?.trim()
  const id = String(job.id ?? job.slug ?? "").trim()
  if (!title || !id) return null
  const slug = job.slug?.trim() || id
  const url = job.url?.trim() || `https://remoteok.com/remote-jobs/${slug}`
  return {
    id: slug,
    title: decodeEntities(title),
    company: job.company ? decodeEntities(job.company.trim()) : null,
    location: job.location ? decodeEntities(job.location.trim()) : "Remote",
    date: normalizeDate(job.date, job.epoch),
    deadline: null,
    url,
    description: job.description ? stripHtml(job.description) : null,
    tags: Array.isArray(job.tags) ? job.tags.filter((tag): tag is string => typeof tag === "string") : [],
  }
}

export function parseFeed(data: unknown): JobResult[] {
  if (!Array.isArray(data)) return []
  return data
    .filter((item): item is RemoteOkJob => item && typeof item === "object" && !("legal" in item))
    .map(toResult)
    .filter((item): item is JobResult => item !== null)
}

export function matchesNeedle(job: JobResult, needle: string | undefined): boolean {
  if (!needle) return true
  const haystack = [job.title, job.company, job.location, ...job.tags].filter(Boolean).join(" ").toLowerCase()
  return needle.toLowerCase().split(/\s+/).every((part) => haystack.includes(part))
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  const posted = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(posted)) return true
  return Date.now() - posted <= days * 24 * 60 * 60 * 1000
}

export function matchesLocation(job: JobResult, location: string | undefined): boolean {
  if (!location) return true
  if (/^(europe|eu|emea)$/i.test(location)) {
    return /\b(europe|european|eu|eea|emea|worldwide|anywhere|global|austria|vienna|germany|france|spain|portugal|italy|ireland|united kingdom|uk|netherlands|belgium|poland|czechia|czech republic|sweden|norway|denmark|finland|switzerland|greece|romania|bulgaria|estonia|latvia|lithuania|hungary|croatia|slovenia|slovakia|cyprus|malta|luxembourg|iceland)\b/i.test(String(job.location ?? ""))
      || !job.location
  }
  return matchesNeedle(job, location)
}
