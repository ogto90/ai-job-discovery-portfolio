export const API_URL = "https://euremotejobs.com/wp-json/wp/v2/job-listings"
export const HOST = "euremotejobs.com"

const UA = "Mozilla/5.0 (compatible; euremotejobs-search-cli/1.0)"

export interface WpJob {
  id?: number
  date?: string
  slug?: string
  link?: string
  title?: { rendered?: string }
  content?: { rendered?: string }
  excerpt?: { rendered?: string }
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
      headers: { "User-Agent": UA, Accept: "application/json,text/plain;q=0.9,*/*;q=0.8" },
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
  return html.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|li|ul|ol|div|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#8211;/g, "-").replace(/&#8217;/g, "'").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

export function normalizeDate(raw: string | undefined | null): string | null {
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

export function extractCompany(text: string): string | null {
  const patterns = [/Company:\s*([^\n]+)/i, /at\s+([A-Z][A-Za-z0-9 .&-]{2,60})/]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

export function extractLocation(text: string): string | null {
  const match = text.match(/Location(?: Details)?:\s*([^\n]+)/i) ?? text.match(/\b(Worldwide|EMEA|Europe|Austria|Germany|United Kingdom|UK|Remote)\b/i)
  return match?.[1]?.trim() ?? "Remote"
}

export function toResult(job: WpJob): JobResult | null {
  if (!job.id || !job.link || !job.title?.rendered) return null
  const description = stripHtml(job.content?.rendered ?? job.excerpt?.rendered ?? "")
  return {
    id: String(job.id),
    title: stripHtml(job.title.rendered),
    company: extractCompany(description),
    location: extractLocation(description),
    date: normalizeDate(job.date),
    deadline: null,
    url: job.link,
    description,
    source: "EU Remote Jobs",
    remote: /remote|worldwide|emea|europe/i.test(description),
  }
}

export function parseApi(data: unknown): JobResult[] {
  if (!Array.isArray(data)) return []
  return (data as WpJob[]).map(toResult).filter((job): job is JobResult => job !== null)
}

const EUROPE_TERMS = ["europe", "european", "eu", "emea", "cet", "cest", "austria", "germany", "uk", "united kingdom", "ireland", "france", "spain", "portugal", "italy", "netherlands", "belgium", "denmark", "sweden", "norway", "finland", "poland", "czech", "slovakia", "slovenia", "croatia", "serbia", "romania", "bulgaria", "greece", "hungary", "estonia", "latvia", "lithuania", "switzerland", "worldwide", "anywhere", "global"]

export function matchesText(job: JobResult, query: string | undefined): boolean {
  if (!query) return true
  const haystack = [job.title, job.company, job.location, job.description].filter(Boolean).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
}

export function matchesLocation(job: JobResult, location: string | undefined): boolean {
  if (!location) return true
  const haystack = `${job.location ?? ""} ${job.description ?? ""}`.toLowerCase()
  const needle = location.toLowerCase()
  if (["europe", "eu", "emea"].includes(needle)) return EUROPE_TERMS.some((term) => haystack.includes(term))
  if (needle === "remote") return /remote|worldwide|anywhere/i.test(haystack)
  return haystack.includes(needle)
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  const posted = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(posted)) return true
  return Date.now() - posted <= days * 24 * 60 * 60 * 1000
}

export function validateDetailInput(input: string): string {
  if (!/^https?:\/\//.test(input)) return input
  const url = new URL(input)
  if (url.hostname !== HOST && url.hostname !== `www.${HOST}`) throw new Error(`detail URL must belong to ${HOST}`)
  return input
}
