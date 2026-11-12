export const SEARCH_API_URL = "https://himalayas.app/jobs/api/search"
export const BROWSE_API_URL = "https://himalayas.app/jobs/api"
export const HOST = "himalayas.app"

const UA = "ai-job-search-himalayas-cli/1.0 (+https://github.com/MadsLorentzen/ai-job-search)"
const MAX_ATTEMPTS = 3

export interface HimalayasLocationObject {
  alpha2?: string
  name?: string
  slug?: string
}

export type HimalayasLocation = string | HimalayasLocationObject

export interface HimalayasJob {
  guid?: string
  title?: string
  excerpt?: string
  companyName?: string
  companySlug?: string
  companyLogo?: string
  employmentType?: string
  minSalary?: number | null
  maxSalary?: number | null
  salaryPeriod?: string | null
  seniority?: string[] | string | null
  currency?: string | null
  locationRestrictions?: HimalayasLocation[]
  timezoneRestrictions?: Array<string | number>
  categories?: string[]
  parentCategories?: string[]
  description?: string
  pubDate?: string | number | null
  expiryDate?: string | number | null
  applicationLink?: string
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
  excerpt?: string | null
  salary?: string | null
  minSalary?: number | null
  maxSalary?: number | null
  currency?: string | null
  salaryPeriod?: string | null
  jobType?: string | null
  seniority?: string[] | string | null
  categories?: string[]
  parentCategories?: string[]
  locationRestrictions?: HimalayasLocation[]
  timezoneRestrictions?: Array<string | number>
  companySlug?: string | null
  companyLogo?: string | null
  tags?: string[]
  source?: string
  remote?: boolean
}

export interface ApiResponse {
  updatedAt?: string | number
  nextCursor?: string
  offset?: number
  limit?: number
  totalCount?: number
  jobs?: HimalayasJob[]
}

export function writeError(error: string, code = "ERROR", details?: string): void {
  process.stderr.write(JSON.stringify({ error, code, ...(details ? { details } : {}) }) + "\n")
}

export async function fetchJson(url: string): Promise<unknown> {
  let delay = 500
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
      if (attempt === MAX_ATTEMPTS - 1) throw new Error(`Unable to fetch Himalayas jobs: ${response.status} ${response.statusText}`)
      await new Promise((resolve) => setTimeout(resolve, delay + Math.floor(Math.random() * 250)))
      delay *= 2
      continue
    }
    if (!response.ok) throw new Error(`Unable to fetch Himalayas jobs: ${response.status} ${response.statusText}`)
    return response.json()
  }
  throw new Error("Unable to fetch Himalayas jobs")
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

export function normalizeDate(raw: string | number | undefined | null): string | null {
  if (raw === undefined || raw === null || raw === "") return null
  const millis = typeof raw === "number" ? (raw > 10_000_000_000 ? raw : raw * 1000) : Date.parse(raw)
  if (!Number.isFinite(millis)) return null
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

const EUROPE_CODES = new Set([
  "AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IS", "IE", "IT", "XK", "LV", "LI", "LT", "LU", "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL", "PT",
  "RO", "RU", "SM", "RS", "SK", "SI", "ES", "SE", "CH", "TR", "UA", "GB", "UK", "VA",
])

const COUNTRY_CODES: Record<string, string> = {
  austria: "AT",
  germany: "DE",
  france: "FR",
  spain: "ES",
  portugal: "PT",
  italy: "IT",
  netherlands: "NL",
  belgium: "BE",
  denmark: "DK",
  sweden: "SE",
  norway: "NO",
  finland: "FI",
  ireland: "IE",
  poland: "PL",
  switzerland: "CH",
  "united kingdom": "GB",
  uk: "GB",
  "czech republic": "CZ",
  czechia: "CZ",
}

const EUROPE_TERMS = [
  "europe", "european", "eu", "emea", "eea", "cet", "cest", "austria", "germany", "uk", "united kingdom",
  "ireland", "france", "spain", "portugal", "italy", "netherlands", "belgium", "denmark", "sweden",
  "norway", "finland", "poland", "czech", "slovakia", "slovenia", "croatia", "serbia", "romania",
  "bulgaria", "greece", "hungary", "estonia", "latvia", "lithuania", "switzerland", "malta", "cyprus",
  "worldwide", "anywhere", "global",
]

export function countryCodeForLocation(location: string | undefined): string | undefined {
  if (!location) return undefined
  return COUNTRY_CODES[location.trim().toLowerCase()]
}

export function shouldUseWorldwide(location: string | undefined): boolean {
  if (!location) return false
  return ["worldwide", "global", "anywhere"].includes(location.trim().toLowerCase())
}

export function locationName(location: HimalayasLocation): string {
  if (typeof location === "string") return location
  return location.name ?? location.alpha2 ?? location.slug ?? ""
}

export function locationCode(location: HimalayasLocation): string {
  if (typeof location === "string") return location.toUpperCase()
  return (location.alpha2 ?? location.name ?? location.slug ?? "").toUpperCase()
}

export function normalizeLocation(locations: HimalayasLocation[] | undefined): string {
  if (!locations || locations.length === 0) return "Worldwide"
  return locations.map(locationName).filter(Boolean).join(", ")
}

export function matchesText(job: JobResult, query: string | undefined): boolean {
  if (!query) return true
  const haystack = [
    job.title, job.company, job.location, job.description, job.excerpt, job.jobType,
    ...(job.categories ?? []), ...(job.parentCategories ?? []), ...(job.tags ?? []),
  ].filter(Boolean).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
}

export function matchesLocation(job: JobResult, location: string | undefined): boolean {
  if (!location) return true
  const needle = location.trim().toLowerCase()
  const restrictions = job.locationRestrictions ?? []
  if (needle === "remote") return true
  if (restrictions.length === 0) return true
  if (["europe", "eu", "emea"].includes(needle)) {
    return restrictions.some((item) => EUROPE_CODES.has(locationCode(item)) || EUROPE_TERMS.includes(locationName(item).toLowerCase()))
  }
  const countryCode = countryCodeForLocation(location)
  if (countryCode && restrictions.some((item) => locationCode(item) === countryCode)) return true
  const haystack = `${job.location ?? ""} ${job.description ?? ""} ${job.excerpt ?? ""}`.toLowerCase()
  return haystack.includes(needle)
}

export function withinDays(date: string | null, days: number | undefined): boolean {
  if (!days || !date) return true
  const posted = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(posted)) return true
  return Date.now() - posted <= days * 24 * 60 * 60 * 1000
}

export function salaryText(job: HimalayasJob): string | null {
  if (job.minSalary == null && job.maxSalary == null) return null
  const range = [job.minSalary, job.maxSalary].filter((value): value is number => typeof value === "number").join("-")
  return [job.currency, range, job.salaryPeriod].filter(Boolean).join(" ")
}

export function toResult(job: HimalayasJob): JobResult | null {
  const id = String(job.guid ?? "").trim()
  const title = job.title?.trim()
  const url = job.applicationLink?.trim()
  if (!id || !title || !url) return null
  const categories = Array.isArray(job.categories) ? job.categories : []
  const parentCategories = Array.isArray(job.parentCategories) ? job.parentCategories : []
  return {
    id,
    title: decodeEntities(title),
    company: job.companyName ? decodeEntities(job.companyName) : null,
    location: normalizeLocation(job.locationRestrictions),
    date: normalizeDate(job.pubDate),
    deadline: normalizeDate(job.expiryDate),
    url,
    description: job.description ? stripHtml(job.description) : null,
    excerpt: job.excerpt ? decodeEntities(job.excerpt) : null,
    salary: salaryText(job),
    minSalary: job.minSalary ?? null,
    maxSalary: job.maxSalary ?? null,
    currency: job.currency ?? null,
    salaryPeriod: job.salaryPeriod ?? null,
    jobType: job.employmentType ?? null,
    seniority: job.seniority ?? null,
    categories,
    parentCategories,
    locationRestrictions: job.locationRestrictions ?? [],
    timezoneRestrictions: job.timezoneRestrictions ?? [],
    companySlug: job.companySlug ?? null,
    companyLogo: job.companyLogo ?? null,
    tags: [...categories, ...parentCategories, job.employmentType].filter((tag): tag is string => Boolean(tag)),
    source: "Himalayas",
    remote: true,
  }
}

export function parseApi(data: unknown): JobResult[] {
  if (!data || typeof data !== "object" || !Array.isArray((data as ApiResponse).jobs)) return []
  return ((data as ApiResponse).jobs ?? []).map(toResult).filter((job): job is JobResult => job !== null)
}

export function totalCount(data: unknown, fallback: number): number {
  if (!data || typeof data !== "object") return fallback
  const total = (data as ApiResponse).totalCount
  return typeof total === "number" ? total : fallback
}

export function validateDetailInput(input: string): string {
  if (!/^https?:\/\//.test(input)) return input
  const url = new URL(input)
  if (url.hostname !== HOST && url.hostname !== `www.${HOST}`) throw new Error(`detail URL must belong to ${HOST}`)
  const segments = url.pathname.split("/").filter(Boolean)
  return segments[segments.length - 1] || input
}

export function sameJob(job: JobResult, id: string): boolean {
  return job.id === id || job.url === id || job.url.includes(id)
}
