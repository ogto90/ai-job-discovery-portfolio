import { isSecurityLeadershipTitle, requiresDeepCloudSpecialization } from "./security_roles"
import { readFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import type { NormalizedJob } from "./company_registry"
import { classifyWorkModel } from "./work_model"

export type EligibilityStatus = "pass" | "fail" | "unknown" | "not_evaluated"
export type EligibilityDimension =
  | "location"
  | "language"
  | "seniority"
  | "management"
  | "roleMismatch"
  | "workAuthorization"
  | "employmentType"
  | "uncertain_location"
  | "expired"
  | "validation_failed"
  | "uncertain"
  | "none"
  | "not_evaluated"

export type RegionCode = "EU" | "Europe" | "EMEA" | "North America" | "LATAM" | "APAC" | "Worldwide"
export type WorkplaceType = "remote" | "hybrid" | "onsite" | "unknown"
export type LanguageImportance = "required" | "preferred" | "optional"
export type Seniority =
  | "intern"
  | "graduate"
  | "junior"
  | "mid"
  | "senior"
  | "staff"
  | "principal"
  | "lead"
  | "manager"
  | "director"
  | "head"
  | "executive"
  | "unknown"
export type CareerTrack = "individual_contributor" | "hands_on_lead" | "people_manager" | "executive" | "unknown"
export type EmploymentType = "full_time" | "part_time" | "contract" | "internship" | "temporary" | "unknown"

export interface Evidence {
  field: string
  text: string
  source?: string
  confidence?: number
}

export interface CandidateProfile {
  schemaVersion: number
  source?: string
  location?: {
    country?: string
    city?: string
    acceptableRemoteRegions?: RegionCode[]
    acceptableRemoteCountries?: string[]
    relocation?: boolean
    hybridCities?: string[]
  }
  languages?: Array<{
    language: string
    level?: string
  }>
  rolePreferences?: {
    targetRoles?: string[]
    secondaryRoles?: string[]
    lowInterestRoles?: string[]
    excludedRoles?: string[]
  }
  skills?: Array<{
    skill: string
    level?: "strong" | "moderate" | "weak" | "mentioned"
    years?: number | null
    evidence?: Evidence[]
  }>
  certifications?: string[]
  matchPreferences?: {
    strengths?: string[]
    moderate?: string[]
    lowInterest?: string[]
    preferredIndustries?: string[]
    lowerInterestIndustries?: string[]
    salaryTarget?: { amount: number; currency: string }
  }
  careerTrack?: {
    prefer?: CareerTrack
    prioritizeLeadership?: boolean
    allowHandsOnLead?: boolean
    allowPeopleManagement?: boolean
    excluded?: CareerTrack[]
  }
  seniority?: {
    target?: Seniority[]
    acceptable?: Seniority[]
    excluded?: Seniority[]
  }
  employmentTypes?: EmploymentType[]
  fieldSources?: Record<string, "explicit_structured_profile" | "deterministic_parsing" | "default">
}

export interface JobRequirements {
  schemaVersion: number
  workplace: WorkplaceType
  geography: {
    conflictingScope?: boolean
    rawLocation?: string | null
    worldwide: boolean
    allowedCountries: string[]
    allowedRegions: RegionCode[]
    excludedCountries: string[]
    cityRestrictions: string[]
    timezoneRestrictions: string[]
    relocationRequired: boolean
    evidence: Evidence[]
  }
  workAuthorization: {
    requiredCountries: string[]
    requiredRegions: RegionCode[]
    sponsorshipAvailable?: boolean
    sponsorshipUnavailable?: boolean
    explicitAuthorizationRequired: boolean
    evidence: Evidence[]
  }
  languages: Array<{
    language: string
    importance: LanguageImportance
    proficiency?: string
    evidence: Evidence[]
  }>
  seniority: Seniority
  careerTrack: CareerTrack
  roleFamilies: string[]
  employmentType: EmploymentType
  evidence: Evidence[]
}

export interface EligibilityFinding {
  dimension: EligibilityDimension
  candidateValue?: unknown
  jobValue?: unknown
  reason: string
  evidence?: Evidence[]
  confidence: number
}

export interface EligibilityResult {
  status: EligibilityStatus
  eligible: boolean | null
  confidence: number
  hardFailures: EligibilityFinding[]
  unknowns: EligibilityFinding[]
  preferences: EligibilityFinding[]
  reasons: EligibilityDimension[]
  notes: string[]
}

const EU_COUNTRIES = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"])
const EUROPE_COUNTRIES = new Set([...EU_COUNTRIES, "GB", "CH", "NO", "IS", "LI", "RS", "BA", "ME", "MK", "AL", "UA", "MD"])
const EMEA_COUNTRIES = new Set([...EUROPE_COUNTRIES, "AE", "SA", "ZA", "NG", "EG", "KE", "MA", "IL", "TR"])
const NORTH_AMERICA_COUNTRIES = new Set(["US", "CA", "MX"])
const LATAM_COUNTRIES = new Set(["BR", "AR", "CL", "CO", "MX", "PE", "UY"])
const APAC_COUNTRIES = new Set(["AU", "SG", "HK", "IN", "JP", "KR", "NZ", "MY", "PH", "TH", "VN", "ID"])
const KNOWN_COUNTRY_CODES = new Set([...EMEA_COUNTRIES, ...NORTH_AMERICA_COUNTRIES, ...LATAM_COUNTRIES, ...APAC_COUNTRIES])

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" })
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
  const code = String.fromCharCode(a, b)
  const name = REGION_NAMES.of(code)
  if (name && name !== code && name !== "Unknown Region" && !["EU", "EZ", "UN", "QO"].includes(code)) KNOWN_COUNTRY_CODES.add(code)
}

const COUNTRY_ALIASES: Array<[string, string, RegExp]> = [
  ["AT", "Austria", /\b(austria|vienna)\b/i],
  ["DE", "Germany", /\b(germany|deutschland|berlin|munich)\b/i],
  ["US", "United States", /\b(united states|usa|u\.s\.a\.|u\.s\.|new york|san francisco|boston|austin|phoenix|virginia|texas|florida|miami|plano|seattle|tacoma|foster city|falls church|tampa)\b|,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/i],
  ["CA", "Canada", /\b(canada|toronto)\b/i],
  ["GB", "United Kingdom", /\b(united kingdom|uk\b|u\.k\.|great britain|england|london|cambridge|birmingham|farnborough)\b/i],
  ["FR", "France", /\b(france|paris)\b/i],
  ["ES", "Spain", /\b(spain|madrid)\b/i],
  ["PL", "Poland", /\b(poland|warsaw)\b/i],
  ["EE", "Estonia", /\b(estonia|tallinn)\b/i],
  ["AU", "Australia", /\b(australia|sydney|melbourne)\b/i],
  ["SG", "Singapore", /\b(singapore)\b/i],
  ["KR", "South Korea", /\b(south korea|seoul)\b/i],
  ["HK", "Hong Kong", /\b(hong kong)\b/i],
  ["SA", "Saudi Arabia", /\b(saudi arabia|riyadh|jiddah)\b/i],
  ["AE", "United Arab Emirates", /\b(united arab emirates|uae|dubai|abu dhabi|sharjah)\b/i],
  ["BR", "Brazil", /\b(brazil)\b/i],
  ["MY", "Malaysia", /\b(malaysia)\b/i],
  ["RO", "Romania", /\b(romania|bucharest|cluj)\b/i],
  ["PT", "Portugal", /\b(portugal|lisbon)\b/i],
  ["NL", "Netherlands", /\b(netherlands|delft)\b/i],
  ["BE", "Belgium", /\b(belgium)\b/i],
  ["CY", "Cyprus", /\b(cyprus)\b/i],
  ["BG", "Bulgaria", /\b(bulgaria)\b/i],
  ["DK", "Denmark", /\b(denmark|københavn|copenhagen|odense)\b/i],
  ["IN", "India", /\b(india|hyderabad|mumbai)\b/i],
]

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function evidence(field: string, text: unknown, source = field, confidence = 0.9): Evidence[] {
  return typeof text === "string" && text.trim() ? [{ field, text: text.trim(), source, confidence }] : []
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim()).map((item) => item.trim())
}

function normalizeCountry(raw: string): string | null {
  const trimmed = raw.trim()
  const upper = trimmed.toUpperCase()
  if (/^[A-Z]{2}$/.test(upper)) return upper
  const found = COUNTRY_ALIASES.find(([, name, pattern]) => name.toLowerCase() === trimmed.toLowerCase() || pattern.test(trimmed))
  return found?.[0] ?? null
}

function countriesInText(text: string): string[] {
  const codeMatches = [...text.matchAll(/\b[A-Z]{2}\b/g)].map((match) => match[0]).filter((code) => KNOWN_COUNTRY_CODES.has(code))
  const names = REGION_NAMES
  const namedCountries = [...KNOWN_COUNTRY_CODES].filter((code) => {
    const name = names.of(code)
    return name && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)
  })
  return unique([...codeMatches, ...namedCountries, ...COUNTRY_ALIASES.filter(([, , pattern]) => pattern.test(text)).map(([code]) => code)])
}

function regionsInText(text: string): RegionCode[] {
  const regions: RegionCode[] = []
  if (/\b(worldwide|global|anywhere in the world|anywhere)\b/i.test(text)) regions.push("Worldwide")
  if (/\bemea\b/i.test(text)) regions.push("EMEA")
  if (/\beu\b|european union/i.test(text)) regions.push("EU")
  if (/\beurope\b|european\b/i.test(text)) regions.push("Europe")
  if (/\bnorth america\b|americas?\b/i.test(text)) regions.push("North America")
  if (/\blatam\b|latin america/i.test(text)) regions.push("LATAM")
  if (/\bapac\b|asia[-\s]?pacific/i.test(text)) regions.push("APAC")
  return unique(regions)
}

function regionContainsCountry(region: RegionCode, country: string): boolean {
  if (region === "Worldwide") return true
  if (region === "EU") return EU_COUNTRIES.has(country)
  if (region === "Europe") return EUROPE_COUNTRIES.has(country)
  if (region === "EMEA") return EMEA_COUNTRIES.has(country)
  if (region === "North America") return NORTH_AMERICA_COUNTRIES.has(country)
  if (region === "LATAM") return LATAM_COUNTRIES.has(country)
  if (region === "APAC") return APAC_COUNTRIES.has(country)
  return false
}

function parseJsonProfile(raw: string, source: string): CandidateProfile {
  const parsed = JSON.parse(raw) as CandidateProfile
  return { schemaVersion: parsed.schemaVersion ?? 1, source, ...parsed }
}

function parseMarkdownProfile(raw: string, source: string): CandidateProfile {
  const profile: CandidateProfile = { schemaVersion: 1, source, fieldSources: {} }
  const locationMatch = raw.match(/\*\*Location:\*\*\s*([^\n]+)/i)
  if (locationMatch) {
    const text = locationMatch[1]
    profile.location = {
      country: countriesInText(text)[0],
      city: /\bvienna\b/i.test(text) ? "Vienna" : undefined,
      acceptableRemoteRegions: regionsInText(text),
      relocation: /relocation:\s*true/i.test(raw) ? true : /relocation:\s*false/i.test(raw) ? false : undefined,
      hybridCities: /\bhybrid vienna|vienna hybrid\b/i.test(raw) ? ["Vienna"] : undefined,
    }
    profile.fieldSources = { ...profile.fieldSources, location: "deterministic_parsing" }
  }
  const languages = [...raw.matchAll(/\|\s*([^|\n]+)\s*\|\s*([^|\n]+)\s*\|/g)]
    .map((match) => ({ language: match[1].trim(), level: match[2].trim() }))
    .filter((item) => !/^language$/i.test(item.language) && !/^[-: ]+$/.test(item.language))
  if (languages.length) {
    profile.languages = languages
    profile.fieldSources = { ...profile.fieldSources, languages: "deterministic_parsing" }
  }
  return profile
}

export async function loadCandidateProfile(path?: string | null): Promise<CandidateProfile | null> {
  if (!path) return null
  const candidates = extname(path).toLowerCase() === ".json"
    ? [path]
    : [join(dirname(path), `${path.split("/").pop()!.replace(/\.[^.]+$/, "")}.json`), path]
  for (const candidatePath of candidates) {
    try {
      const raw = await readFile(candidatePath, "utf8")
      if (candidatePath.endsWith(".json")) return parseJsonProfile(raw, candidatePath)
      return parseMarkdownProfile(raw, candidatePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return null
}

function textForJob(job: NormalizedJob): string {
  return [
    job.title,
    job.company,
    job.location,
    job.description,
    job.remote,
    job.workplaceType,
    job.employmentType,
    ...(Array.isArray(job.tags) ? job.tags : []),
    ...(Array.isArray(job.categories) ? job.categories : []),
    ...(Array.isArray(job.locationRestrictions) ? job.locationRestrictions : []),
    ...(Array.isArray(job.timezoneRestrictions) ? job.timezoneRestrictions : []),
  ].filter((value) => value !== undefined && value !== null).map(String).join("\n")
}

function inferWorkplace(job: NormalizedJob): WorkplaceType {
  return classifyWorkModel({
    title: job.title, location: job.location, description: job.description,
    remoteScope: job.workplaceType ?? (typeof job.remote === "string" ? job.remote : job.remote === true ? "remote" : null),
    structuredWorkModel: job.sourceType === "ats" ? job.workplaceType : null,
  })
}

function extractGeography(job: NormalizedJob, text: string): JobRequirements["geography"] {
  const rawLocation = typeof job.location === "string" ? job.location : null
  const locationText = [
    rawLocation,
    ...(Array.isArray(job.locationRestrictions) ? job.locationRestrictions : []),
  ].filter(Boolean).join(", ")
  const description = String(job.description ?? "").replace(/<[^>]*>/g, " ")
  // Only role-specific remote statements can override an office location.
  const remoteScope = description.match(/\b(?:work (?:remotely )?from anywhere(?: in [^.!\n]+)?|(?:fully )?remote (?:role |position )?(?:anywhere |within |across |in |from )[^.!\n]+|(?:candidates|applicants) must (?:be (?:based|located)|reside) in [^.!\n]+)/gi) ?? []
  const restrictive = remoteScope.filter((part) => /must|only|restricted/i.test(part))
  const explicitScope = (restrictive.length ? restrictive : remoteScope).filter((part) => countriesInText(part).length || regionsInText(part).length)
  const titleCountries = countriesInText(String(job.title ?? ""))
  const structuredCountries = countriesInText(stringList(job.locationRestrictions).join(", "))
  const locationCountries = countriesInText(locationText)
  const countryNames = new Intl.DisplayNames(["en"], { type: "region" })
  const countryOnlyLocation = locationCountries.some((country) => {
    const value = String(rawLocation ?? "").trim().toLowerCase()
    return value === country.toLowerCase() || value === countryNames.of(country)?.toLowerCase()
      || /^(?:remote[ ,:()/-]+|anywhere in )/i.test(value)
  })
  const explicitCountries = countriesInText(explicitScope.join("\n"))
  // A role-specific restriction must narrow, never union with, broad portal coverage.
  const scopedCountries = titleCountries.length ? titleCountries
    : restrictive.length && explicitCountries.length ? explicitCountries
    : structuredCountries.length ? structuredCountries
    : countryOnlyLocation ? locationCountries : []
  const conflictingScope = scopedCountries.length > 0 && explicitScope.length > 0
    && (regionsInText(explicitScope.join("\n")).length > 0 || explicitCountries.some((country) => !scopedCountries.includes(country)))
  const scopedText = explicitScope.length ? explicitScope.join("\n") : locationText || text
  const allowedCountries = scopedCountries.length ? scopedCountries : countriesInText(scopedText)
  const allowedRegions = scopedCountries.length ? [] : regionsInText(scopedText)
  const timezoneRestrictions = unique([
    ...stringList(job.timezoneRestrictions),
    ...([...text.matchAll(/\b(?:UTC|GMT)\s*[+-]\s*\d{1,2}\b/gi)].map((m) => m[0])),
    ...([...text.matchAll(/\b(?:EST|CST|PST|CET|CEST|EET|GMT)\b/g)].map((m) => m[0])),
  ])
  const cityRestrictions = unique(COUNTRY_ALIASES.filter(([, , pattern]) => rawLocation ? pattern.test(rawLocation) : false).map(([, name]) => name))
  return {
    rawLocation,
    conflictingScope,
    worldwide: allowedRegions.includes("Worldwide"),
    allowedCountries,
    allowedRegions,
    excludedCountries: [],
    cityRestrictions,
    timezoneRestrictions,
    relocationRequired: /\brelocat(?:e|ion) required\b/i.test(text),
    evidence: [...evidence("location", rawLocation), ...evidence("title", String(job.title ?? "")), ...evidence("locationRestrictions", stringList(job.locationRestrictions).join(", ")), ...explicitScope.flatMap((part) => evidence("description", part, "remote_scope"))],
  }
}

function extractWorkAuthorization(text: string): JobRequirements["workAuthorization"] {
  const snippets = [
    ...text.matchAll(/.{0,80}(authorized to work|work authorization|sponsor|sponsorship|visa|citizenship|u\.s\. citizen|us citizen|security clearance|clearance required).{0,120}/gi),
  ].map((m) => m[0])
  const joined = snippets.join("\n")
  return {
    requiredCountries: countriesInText(joined),
    requiredRegions: regionsInText(joined),
    sponsorshipAvailable: /\bsponsorship (?:is )?available|visa sponsorship\b/i.test(joined) ? true : undefined,
    sponsorshipUnavailable: /\bdo not sponsor|no sponsorship|sponsorship unavailable|do not currently sponsor\b/i.test(joined) ? true : undefined,
    explicitAuthorizationRequired: /\bauthorized to work|work authorization|citizenship|u\.s\. citizen|us citizen|security clearance|clearance required\b/i.test(joined),
    evidence: snippets.map((text) => ({ field: "description", text, source: "work_authorization", confidence: 0.95 })),
  }
}

function extractLanguages(text: string): JobRequirements["languages"] {
  const languages: JobRequirements["languages"] = []
  const specs = [
    ["German", /\b(german[-\s]?speaking|fluent german|native german|c1\/c2 german|c1 german|c2 german|german (?:language )?(?:is )?(?:required|essential|must))\b/gi, "required"],
    ["German", /\b(german (?:preferred|is a plus|advantageous)|knowledge of german advantageous)\b/gi, "preferred"],
    ["English", /\b(fluent english|c1\/c2 english|c1 english|c2 english|english (?:language )?(?:is )?(?:required|essential|must))\b/gi, "required"],
  ] as const
  for (const [language, pattern, importance] of specs) {
    for (const match of text.matchAll(pattern)) {
      languages.push({
        language,
        importance,
        proficiency: /c1|c2|fluent|native/i.exec(match[0])?.[0],
        evidence: [{ field: "description", text: match[0], source: "language", confidence: importance === "required" ? 1 : 0.85 }],
      })
    }
  }
  return languages
}

function inferSeniority(title: string): Seniority {
  if (/\b(internship|intern\b)\b/i.test(title)) return "intern"
  if (/\bgraduate\b/i.test(title)) return "graduate"
  if (/\bjunior\b|entry[-\s]?level/i.test(title)) return "junior"
  if (/\bchief\b|\bciso\b|vice president|\bvp\b/i.test(title)) return "executive"
  if (/\bhead of\b/i.test(title)) return "head"
  if (/\bdirector\b/i.test(title)) return "director"
  if (/\bmanager\b/i.test(title)) return "manager"
  if (/\bprincipal\b/i.test(title)) return "principal"
  if (/\bstaff\b/i.test(title)) return "staff"
  if (/\blead\b/i.test(title)) return "lead"
  if (/\bsenior\b|\bsr\.?\b/i.test(title)) return "senior"
  if (/\bassociate\b/i.test(title)) return "mid"
  return "unknown"
}

function inferCareerTrack(title: string, text: string): CareerTrack {
  if (/\bchief\b|\bciso\b|vice president|\bvp\b/i.test(title)) return "executive"
  if (/\bhead of\b|\bdirector\b|\bmanager\b/i.test(title)) return "people_manager"
  if (/\blead\b|team lead|tech lead/i.test(title)) return /\bhiring|performance reviews|people management|line management\b/i.test(text) ? "people_manager" : "hands_on_lead"
  if (/\bengineer|architect|consultant|specialist|responder|analyst\b/i.test(title)) return "individual_contributor"
  return "unknown"
}

function inferRoleFamilies(title: string, text: string): string[] {
  const source = `${title}\n${text}`
  const coreAppProduct = /\b(appsec|application security|secure sdlc|product security|software security)\b/i.test(source)
  const families: Array<[string, RegExp]> = [
    ["application_security", /\b(appsec|application security|secure sdlc)\b/i],
    ["product_security", /\bproduct security\b/i],
    ["cloud_security", coreAppProduct && !/\bcloud security\b/i.test(title) ? /\b(?!)\b/ : /\bcloud security|cspm|aws security|azure security|gcp security\b/i],
    ["security_engineering", /\bsecurity engineer|cybersecurity engineer|cyber security engineer|information security engineer\b/i],
    ["vulnerability_management", /\bvulnerability|patch management\b/i],
    ["security_architecture", /\bsecurity architect|cyber security architect|cybersecurity architect\b/i],
    ["soc_analyst", /\bsoc analyst|security analyst|cyber security analyst|information security analyst|threat intelligence analyst|vulnerability management analyst\b/i],
    ["soc_detection", /\bsoc|security operations|detection engineer|threat detection|siem|incident responder|incident response\b/i],
    ["iam", /\biam|identity and access|entra id|active directory\b/i],
    ["grc", /\bgrc|governance|compliance|audit|isms|iso 27001|information security lead\b/i],
    ["security_management", /\bsecurity manager|information security manager|security lead|security tech lead|information security lead\b/i],
    ["network_security", /\bnetwork security|firewall|ids\/ips\b/i],
    ["sales_gtm", /\bterritory manager|gtm leader|go-to-market|sales\b/i],
  ]
  return unique([
    ...families.filter(([family, pattern]) => pattern.test(["soc_analyst", "cloud_security", "sales_gtm"].includes(family) ? title : source)).map(([family]) => family),
    ...(isSecurityLeadershipTitle(title) ? ["security_management"] : []),
    ...(requiresDeepCloudSpecialization(title, text) ? ["cloud_security"] : []),
  ])
}

function inferEmploymentType(job: NormalizedJob, text: string): EmploymentType {
  const explicit = job.employmentType ?? job.jobType
  const employmentLines = text.split(/[\n.!]/).filter((line) => /\b(?:employment|engagement|contract type|contract arrangement|contract role|contract position|contract basis|fixed.term|freelance|full.time|part.time|independent contractor)\b/i.test(line)).join("\n")
  const raw = String(explicit ?? `${job.title ?? ""}\n${employmentLines}`).toLowerCase().replace(/smart[- ]contracts?/g, "")
  if (/\binternship|intern\b/.test(raw)) return "internship"
  if (/\b(contract|contractor|freelance)\b/.test(raw) || /\bb2b (?:contract|arrangement|engagement)\b/.test(raw)) return "contract"
  if (/\bpart[-\s]?time\b/.test(raw)) return "part_time"
  if (/\btemporary|fixed[-\s]?term\b/.test(raw)) return "temporary"
  if (/\bfull[-\s]?time\b/.test(raw) || raw.includes("fulltime")) return "full_time"
  return "unknown"
}

export function extractJobRequirements(job: NormalizedJob): JobRequirements {
  const text = textForJob(job)
  const title = String(job.title ?? "")
  const workplace = inferWorkplace(job)
  return {
    schemaVersion: 1,
    workplace,
    geography: extractGeography(job, text),
    workAuthorization: extractWorkAuthorization(text),
    languages: extractLanguages(text),
    seniority: inferSeniority(title),
    careerTrack: inferCareerTrack(title, text),
    roleFamilies: inferRoleFamilies(title, text),
    employmentType: inferEmploymentType(job, text),
    evidence: [...evidence("title", title), ...evidence("location", job.location)],
  }
}

function candidateCountry(candidate: CandidateProfile): string | null {
  return candidate.location?.country ? normalizeCountry(candidate.location.country) : null
}

function canWorkRemote(candidate: CandidateProfile, req: JobRequirements): boolean {
  const country = candidateCountry(candidate)
  if (!country) return false
  const candidateCountries = unique([country, ...(candidate.location?.acceptableRemoteCountries ?? []).map((item) => normalizeCountry(item)).filter(Boolean) as string[]])
  if (req.geography.allowedCountries.some((jobCountry) => candidateCountries.includes(jobCountry))) return true
  if (req.geography.allowedCountries.length > 0 && req.geography.allowedRegions.length === 0) return false
  if (req.geography.allowedCountries.length > 0 && req.geography.rawLocation && countriesInText(req.geography.rawLocation).length > 0) return false
  const acceptedRegions = candidate.location?.acceptableRemoteRegions ?? []
  if (req.geography.allowedRegions.some((region) => region !== "Worldwide" && acceptedRegions.includes(region) && regionContainsCountry(region, country))) return true
  return req.geography.worldwide && req.geography.allowedCountries.length === 0
}

function languageRank(level: string | undefined): number {
  const raw = String(level ?? "").toLowerCase()
  if (/native|bilingual|c2/.test(raw)) return 5
  if (/c1|fluent|full professional|professional/.test(raw)) return 4
  if (/b2|working/.test(raw)) return 3
  if (/b1|intermediate/.test(raw)) return 2
  if (/a1|a2|basic|beginner/.test(raw)) return 1
  return 0
}

function requiredLanguageRank(proficiency: string | undefined): number {
  const raw = String(proficiency ?? "").toLowerCase()
  if (/native/.test(raw)) return 5
  if (/c1|c2|fluent/.test(raw)) return 4
  return 3
}

function candidateMeetsLanguage(candidate: CandidateProfile, language: string, requiredProficiency?: string): boolean {
  const entry = (candidate.languages ?? []).find((item) => item.language.toLowerCase() === language.toLowerCase())
  return Boolean(entry) && languageRank(entry?.level) >= requiredLanguageRank(requiredProficiency)
}

function locationFinding(dimension: EligibilityDimension, reason: string, candidate: CandidateProfile, req: JobRequirements, confidence = 1): EligibilityFinding {
  return {
    dimension,
    candidateValue: { country: candidate.location?.country, city: candidate.location?.city, remoteRegions: candidate.location?.acceptableRemoteRegions },
    jobValue: { workplace: req.workplace, countries: req.geography.allowedCountries, regions: req.geography.allowedRegions, rawLocation: req.geography.rawLocation },
    reason,
    evidence: req.geography.evidence,
    confidence,
  }
}

export function evaluateCandidateEligibility(candidate: CandidateProfile | null, req: JobRequirements): EligibilityResult {
  if (!candidate) {
    return {
      status: "not_evaluated",
      eligible: null,
      confidence: 0,
      hardFailures: [],
      unknowns: [{ dimension: "not_evaluated", reason: "candidate profile not supplied", confidence: 1 }],
      preferences: [],
      reasons: ["not_evaluated"],
      notes: ["candidate profile not supplied"],
    }
  }

  const hardFailures: EligibilityFinding[] = []
  const unknowns: EligibilityFinding[] = []
  const preferences: EligibilityFinding[] = []
  const country = candidateCountry(candidate)

  if (req.workplace === "remote") {
    if (req.geography.conflictingScope) {
      unknowns.push(locationFinding("uncertain_location", "explicit country restriction conflicts with remote scope; verify hiring eligibility", candidate, req, 0.9))
    } else if (req.geography.allowedCountries.length || req.geography.allowedRegions.length || req.geography.worldwide) {
      if (!canWorkRemote(candidate, req)) hardFailures.push(locationFinding("location", "remote work is restricted outside the candidate's accepted countries/regions", candidate, req))
    } else {
      unknowns.push(locationFinding("uncertain_location", "remote role has no explicit geographic eligibility scope", candidate, req, 0.8))
    }
  } else if (req.workplace === "hybrid") {
    const city = candidate.location?.city?.toLowerCase()
    const hybridCities = (candidate.location?.hybridCities ?? []).map((item) => item.toLowerCase())
    const raw = req.geography.rawLocation?.toLowerCase() ?? ""
    if (!city || (!raw.includes(city) && !hybridCities.some((allowed) => raw.includes(allowed)))) {
      hardFailures.push(locationFinding("location", "hybrid role is not in an accepted candidate city", candidate, req))
    }
  } else if (req.workplace === "onsite") {
    if (req.geography.allowedCountries.length && country && req.geography.allowedCountries.includes(country)) {
      const raw = req.geography.rawLocation?.toLowerCase() ?? ""
      const city = candidate.location?.city?.toLowerCase()
      if (raw && city && !raw.includes(city) && candidate.location?.relocation !== true) hardFailures.push(locationFinding("location", "onsite role is outside the candidate's city and relocation is not enabled", candidate, req))
    } else if (candidate.location?.relocation !== true) {
      hardFailures.push(locationFinding("location", "job location is outside the candidate's location and no compatible remote scope is present", candidate, req))
    }
  } else if (req.geography.allowedCountries.length && !req.geography.allowedRegions.length
    && !req.geography.worldwide && country && !req.geography.allowedCountries.includes(country)) {
    hardFailures.push(locationFinding("location", "job location is outside the candidate's location and no compatible remote scope is present", candidate, req))
  } else {
    unknowns.push(locationFinding("uncertain_location", "job location/workplace scope is insufficient", candidate, req, 0.7))
  }

  if (req.workAuthorization.explicitAuthorizationRequired && req.workAuthorization.requiredCountries.length) {
    const allowed = country ? req.workAuthorization.requiredCountries.includes(country) : false
    if (!allowed) {
      hardFailures.push({
        dimension: "workAuthorization",
        candidateValue: country,
        jobValue: req.workAuthorization.requiredCountries,
        reason: "job has an explicit work-authorization country requirement",
        evidence: req.workAuthorization.evidence,
        confidence: 1,
      })
    }
  } else if (req.workAuthorization.explicitAuthorizationRequired && req.workAuthorization.evidence.some((item) => /security clearance|clearance required/i.test(item.text))) {
    hardFailures.push({
      dimension: "workAuthorization",
      candidateValue: country,
      jobValue: "security clearance",
      reason: "job explicitly requires security clearance",
      evidence: req.workAuthorization.evidence,
      confidence: 0.95,
    })
  }

  for (const language of req.languages.filter((item) => item.importance === "required")) {
    if (!candidateMeetsLanguage(candidate, language.language, language.proficiency)) {
      hardFailures.push({
        dimension: "language",
        candidateValue: candidate.languages,
        jobValue: language,
        reason: `${language.language} is required by the job at a higher proficiency than the candidate profile supports`,
        evidence: language.evidence,
        confidence: 1,
      })
    }
  }

  const excludedRoles = new Set(candidate.rolePreferences?.excludedRoles ?? [])
  const excludedRole = req.roleFamilies.find((family) => excludedRoles.has(family))
  if (excludedRole) {
    hardFailures.push({
      dimension: "roleMismatch",
      candidateValue: [...excludedRoles],
      jobValue: req.roleFamilies,
      reason: `role family '${excludedRole}' is explicitly excluded by the candidate profile`,
      evidence: req.evidence,
      confidence: 0.95,
    })
  }

  if ((candidate.seniority?.excluded ?? []).includes(req.seniority)) {
    hardFailures.push({
      dimension: "seniority",
      candidateValue: candidate.seniority,
      jobValue: req.seniority,
      reason: "job seniority is explicitly excluded by the candidate profile",
      evidence: req.evidence,
      confidence: 0.95,
    })
  }

  const excludedTracks = new Set(candidate.careerTrack?.excluded ?? [])
  if (excludedTracks.has(req.careerTrack) || (req.careerTrack === "people_manager" && candidate.careerTrack?.allowPeopleManagement === false)) {
    hardFailures.push({
      dimension: "management",
      candidateValue: candidate.careerTrack,
      jobValue: req.careerTrack,
      reason: "job career track is explicitly excluded by the candidate profile",
      evidence: req.evidence,
      confidence: 0.9,
    })
  }

  const acceptedEmployment = candidate.employmentTypes ?? []
  if (req.employmentType !== "unknown" && acceptedEmployment.length > 0 && !acceptedEmployment.includes(req.employmentType)) {
    hardFailures.push({
      dimension: "employmentType",
      candidateValue: acceptedEmployment,
      jobValue: req.employmentType,
      reason: "job employment type is not accepted by the candidate profile",
      evidence: req.evidence,
      confidence: 0.9,
    })
  }

  for (const family of req.roleFamilies) {
    if (!(candidate.rolePreferences?.targetRoles ?? []).includes(family) && req.roleFamilies.length > 0) {
      preferences.push({
        dimension: "roleMismatch",
        candidateValue: candidate.rolePreferences?.targetRoles,
        jobValue: req.roleFamilies,
        reason: "role family is outside explicit target roles but not excluded",
        evidence: req.evidence,
        confidence: 0.4,
      })
      break
    }
  }

  if (hardFailures.length > 0) {
    const reasons = unique(hardFailures.map((failure) => failure.dimension))
    return {
      status: "fail",
      eligible: false,
      confidence: Math.max(...hardFailures.map((failure) => failure.confidence)),
      hardFailures,
      unknowns,
      preferences,
      reasons,
      notes: hardFailures.map((failure) => failure.reason),
    }
  }
  if (unknowns.length > 0) {
    return {
      status: "unknown",
      eligible: null,
      confidence: Math.max(...unknowns.map((unknown) => unknown.confidence)),
      hardFailures,
      unknowns,
      preferences,
      reasons: unique(unknowns.map((unknown) => unknown.dimension)),
      notes: unknowns.map((unknown) => unknown.reason),
    }
  }
  return {
    status: "pass",
    eligible: true,
    confidence: 0.95,
    hardFailures,
    unknowns,
    preferences,
    reasons: ["none"],
    notes: ["hard eligibility gates passed"],
  }
}
