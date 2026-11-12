export const BASE_URL = "https://www.infosecjobboard.com"
export const HOST = "www.infosecjobboard.com"

const UA = "Mozilla/5.0 (compatible; infosecjobs-search-cli/1.0)"

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
  category?: string | null
  tags?: string[]
  source?: string
  remote?: boolean
  companyUrl?: string | null
  applyUrl?: string | null
}

export function writeError(error: string, code = "ERROR", details?: string): void {
  process.stderr.write(JSON.stringify({ error, code, ...(details ? { details } : {}) }) + "\n")
}

export async function fetchText(url: string): Promise<string> {
  let delay = 500
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 3) throw new Error(`Unable to fetch jobs: ${response.status} ${response.statusText}`)
      const retryAfter = response.status === 429 ? response.headers?.get("Retry-After") : null
      const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : null
      const date = retryAfter && seconds === null ? Date.parse(retryAfter) : NaN
      const requestedDelay = seconds ?? (Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0)
      if (requestedDelay > 20_000) throw new Error(`Unable to fetch jobs: 429 Too Many Requests (Retry-After exceeds bounded retry window)`)
      await new Promise((resolve) => setTimeout(resolve, Math.max(delay + Math.floor(Math.random() * 250), requestedDelay)))
      delay *= 2
      continue
    }
    if (!response.ok) throw new Error(`Unable to fetch jobs: ${response.status} ${response.statusText}`)
    return response.text()
  }
  throw new Error("Unable to fetch jobs")
}

export function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()
}

export function stripHtml(html: string): string {
  return decodeEntities(html).replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|li|ul|ol|div|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

function abs(path: string): string {
  return path.startsWith("http") ? decodeEntities(path) : `${BASE_URL}${path}`
}

export function normalizePostedDate(raw: string | null): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/^Posted\s+/i, "").trim()
  const withYear = /\b\d{4}\b/.test(cleaned) ? cleaned : `${cleaned} ${new Date().getUTCFullYear()}`
  const date = new Date(withYear)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

export function parseCards(html: string): JobResult[] {
  const chunks = html.split(/<div class="group relative rounded-2xl/).slice(1)
  return chunks.map((chunk): JobResult | null => {
    const urlPath = chunk.match(/href="(\/job\/[^"]+)"/)?.[1]
    const title = chunk.match(/title="([^"]+)"/)?.[1] ?? chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1]
    if (!urlPath || !title) return null
    const companyPath = chunk.match(/href="(\/companies\/[^"]+)"/)?.[1] ?? null
    const company = chunk.match(/href="\/companies\/[^"]+"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? null
    const loc = chunk.match(/href="\/(?:remote-)?cybersecurity-jobs-in-[^"]+"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? null
    const posted = chunk.match(/Posted\s+[A-Z][a-z]{2}\s+\d{1,2}/)?.[0] ?? null
    const applyUrl = chunk.match(/<a href="(https?:\/\/[^"]+)"[^>]*data-piqo-event="Apply Click"/)?.[1] ?? null
    const badges = [...chunk.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => stripHtml(m[1])).filter(Boolean)
    const salary = badges.find((b) => /[$€£]\s?\d/.test(b)) ?? null
    const category = badges.find((b) => /Security|GRC|AppSec|Detection|Privacy|Identity|Cloud|Offensive|AI/i.test(b)) ?? null
    return {
      id: urlPath.split("/").pop() ?? urlPath,
      title: stripHtml(title),
      company: company ? stripHtml(company) : null,
      location: loc ? stripHtml(loc) : null,
      date: normalizePostedDate(posted),
      deadline: null,
      url: abs(urlPath),
      description: null,
      salary,
      category,
      tags: badges,
      source: "InfoSec Job Board",
      remote: /Remote/i.test(chunk),
      companyUrl: companyPath ? abs(companyPath) : null,
      applyUrl: applyUrl ? decodeEntities(applyUrl) : null,
    }
  }).filter((job): job is JobResult => job !== null)
}

export function parseDetail(html: string, url: string): JobResult | null {
  const title = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? html.match(/<title>([\s\S]*?)<\/title>/)?.[1]
  if (!title) return null
  const applyUrl = html.match(/href="(https?:\/\/[^"]+)"[^>]*data-piqo-event="Apply Click"/)?.[1] ?? html.match(/href="(https?:\/\/[^"]+utm_source=infosecjobboard[^"]+)"/)?.[1] ?? null
  const text = stripHtml(html)
  return {
    id: url.split("/").filter(Boolean).pop() ?? url,
    title: stripHtml(title).replace(/\s*\|\s*InfoSec Job Board$/i, ""),
    company: text.match(/\n([A-Z][A-Za-z0-9 .&-]{2,80})\n/)?.[1] ?? null,
    location: text.match(/\b(United States|United Kingdom|Ireland|Netherlands|Canada|Remote|Worldwide|Europe|France|Germany|Austria)\b/)?.[1] ?? null,
    date: normalizePostedDate(text.match(/Posted\s+[A-Z][a-z]{2}\s+\d{1,2}/)?.[0] ?? null),
    deadline: null,
    url,
    description: text,
    source: "InfoSec Job Board",
    remote: /Remote/i.test(text),
    applyUrl: applyUrl ? decodeEntities(applyUrl) : null,
  }
}

export function searchUrl(query: string | undefined, page: number): string {
  const q = (query ?? "").toLowerCase()
  let path = "/remote-cybersecurity-jobs"
  if (/appsec|application security|product security/.test(q)) path = "/remote-appsec-jobs"
  if (/grc|compliance|risk|governance/.test(q)) path = "/remote-grc-jobs"
  if (/security engineer|security engineering/.test(q)) path = "/remote-security-engineering-jobs"
  return `${BASE_URL}${path}${page > 1 ? `?page=${page}` : ""}`
}

const EUROPE_TERMS = ["europe", "eu", "emea", "austria", "germany", "uk", "united kingdom", "ireland", "france", "spain", "portugal", "italy", "netherlands", "belgium", "denmark", "sweden", "norway", "finland", "poland", "worldwide", "remote"]

export function matchesText(job: JobResult, query: string | undefined): boolean {
  if (!query) return true
  const haystack = [job.title, job.company, job.location, job.category, ...(job.tags ?? [])].filter(Boolean).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
}

export function matchesLocation(job: JobResult, location: string | undefined): boolean {
  if (!location) return true
  const haystack = `${job.location ?? ""} ${job.title} ${(job.tags ?? []).join(" ")}`.toLowerCase()
  const needle = location.toLowerCase()
  if (["europe", "eu", "emea"].includes(needle)) return EUROPE_TERMS.some((term) => haystack.includes(term))
  if (needle === "remote") return job.remote === true || haystack.includes("remote")
  return haystack.includes(needle)
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  return Date.now() - new Date(`${date}T00:00:00Z`).getTime() <= days * 24 * 60 * 60 * 1000
}

export function validateDetailInput(input: string): string {
  if (!/^https?:\/\//.test(input)) return `${BASE_URL}/job/${input}`
  const url = new URL(input)
  if (url.hostname !== HOST) throw new Error(`detail URL must belong to ${HOST}`)
  return input
}
