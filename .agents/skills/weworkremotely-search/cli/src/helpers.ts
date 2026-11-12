export const RSS_URL = "https://weworkremotely.com/remote-jobs.rss"
export const HOST = "weworkremotely.com"

const UA = "Mozilla/5.0 (compatible; weworkremotely-search-cli/1.0)"
const ATTEMPT_TIMEOUTS_MS = [15000, 25000, 35000, 45000]

export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  deadline: string | null
  url: string
  description?: string | null
  jobType?: string | null
  category?: string | null
  tags?: string[]
  source?: string
  remote?: boolean
}

export function writeError(error: string, code = "ERROR", details?: string): void {
  process.stderr.write(JSON.stringify({ error, code, ...(details ? { details } : {}) }) + "\n")
}

export async function fetchText(url: string): Promise<string> {
  let delay = 500
  let lastError: string | null = null
  for (let attempt = 0; attempt < ATTEMPT_TIMEOUTS_MS.length; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.8" },
        redirect: "follow",
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUTS_MS[attempt]),
      })
      if (response.status === 429 || response.status >= 500) {
        lastError = `${response.status} ${response.statusText}`
        if (attempt === ATTEMPT_TIMEOUTS_MS.length - 1) throw new Error(`Unable to fetch jobs: ${lastError}; attempt=${attempt + 1}`)
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay *= 2
        continue
      }
      if (!response.ok) throw new Error(`Unable to fetch jobs: ${response.status} ${response.statusText}`)
      return response.text()
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt === ATTEMPT_TIMEOUTS_MS.length - 1) throw new Error(`Unable to fetch jobs: ${lastError}; attempt=${attempt + 1}`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay *= 2
    }
  }
  throw new Error(lastError ? `Unable to fetch jobs: ${lastError}` : "Unable to fetch jobs")
}

export function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

export function stripHtml(html: string): string {
  return decodeEntities(html)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function tag(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))
  return match ? decodeEntities(match[1]) : null
}

export function normalizeDate(raw: string | null): string | null {
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

export function parseTitle(raw: string): { company: string | null; title: string } {
  const parts = raw.split(":")
  if (parts.length > 1) return { company: parts.shift()?.trim() || null, title: parts.join(":").trim() }
  return { company: null, title: raw.trim() }
}

export function parseRss(xml: string): JobResult[] {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []
  return items.map((item): JobResult | null => {
    const rawTitle = tag(item, "title")
    const link = tag(item, "link")
    if (!rawTitle || !link) return null
    const { company, title } = parseTitle(rawTitle)
    const description = tag(item, "description")
    const guid = tag(item, "guid") ?? link
    const region = tag(item, "region") ?? tag(item, "country")
    const category = tag(item, "category")
    const jobType = tag(item, "type")
    const skills = tag(item, "skills")
    const deadline = normalizeDate(tag(item, "expires_at"))
    return {
      id: guid,
      title,
      company,
      location: region || "Remote",
      date: normalizeDate(tag(item, "pubDate")),
      deadline,
      url: link,
      description: description ? stripHtml(description) : null,
      category,
      jobType,
      tags: [category, jobType, ...(skills ? skills.split(",").map((s) => s.trim()) : [])].filter((s): s is string => Boolean(s)),
      source: "We Work Remotely",
      remote: true,
    }
  }).filter((job): job is JobResult => job !== null)
}

const EUROPE_TERMS = ["europe", "european", "eu", "emea", "cet", "cest", "austria", "germany", "uk", "united kingdom", "ireland", "france", "spain", "portugal", "italy", "netherlands", "belgium", "denmark", "sweden", "norway", "finland", "poland", "czech", "slovakia", "slovenia", "croatia", "serbia", "romania", "bulgaria", "greece", "hungary", "estonia", "latvia", "lithuania", "switzerland", "worldwide", "anywhere", "global"]

export function matchesText(job: JobResult, query: string | undefined): boolean {
  if (!query) return true
  const haystack = [job.title, job.company, job.location, job.description, job.category, job.jobType, ...(job.tags ?? [])].filter(Boolean).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
}

export function matchesLocation(job: JobResult, location: string | undefined): boolean {
  if (!location) return true
  const haystack = `${job.location ?? ""} ${job.description ?? ""}`.toLowerCase()
  const needle = location.toLowerCase()
  if (["europe", "eu", "emea"].includes(needle)) return EUROPE_TERMS.some((term) => haystack.includes(term))
  if (needle === "remote") return true
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
