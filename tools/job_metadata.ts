/** Generic, profession-neutral checks for source company/title metadata. */

export type JobMetadataField = "company" | "title"

const PAGE_HEADINGS = new Set([
  "about us", "about the role", "about the company", "the role", "job description",
  "careers", "join us", "who we are", "what you ll do", "what youll do",
  "responsibilities", "requirements", "qualifications", "location", "our company", "our mission",
])

const GENERIC_COMPANY_VALUES = new Set([
  "us", "u s", "usa", "uk", "u k", "eu", "emea", "apac", "remote", "hybrid",
  "on site", "onsite", "location", "careers", "jobs", "worldwide", "anywhere",
  "unknown company", "company not provided", "manual listing", "untitled role",
])

export function normalizeMetadata(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    : ""
}

export function jobMetadataIssues(company: unknown, title: unknown): string[] {
  const companyText = typeof company === "string" ? company.trim() : ""
  const titleText = typeof title === "string" ? title.trim() : ""
  const companyKey = normalizeMetadata(companyText)
  const titleKey = normalizeMetadata(titleText)
  const issues: string[] = []

  if (!companyText) issues.push("company_missing")
  else if (PAGE_HEADINGS.has(companyKey)) issues.push("company_is_page_heading")
  else if (GENERIC_COMPANY_VALUES.has(companyKey)) issues.push("company_is_geographic_or_navigation_token")
  else if (companyText.length > 140) issues.push("company_looks_like_prose")

  if (!titleText) issues.push("title_missing")
  else if (PAGE_HEADINGS.has(titleKey)) issues.push("title_is_page_heading")
  else if (GENERIC_COMPANY_VALUES.has(titleKey)) issues.push("title_is_geographic_or_navigation_token")
  else if (titleText.length > 180 || /[.!?]$/.test(titleText)) issues.push("title_looks_like_prose")

  if (companyKey && titleKey && companyKey === titleKey) issues.push("company_and_title_identical")
  return issues
}

export function discoveredMetadataIsSane(company: unknown, title: unknown): boolean {
  return jobMetadataIssues(company, title).length === 0
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function candidate(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function postingOrganizationName(posting: Record<string, unknown>): unknown {
  const organization = object(posting.hiringOrganization)
  return organization.name
}

/** Resolve only from explicit/structured metadata; never mine arbitrary JD prose. */
export function resolveJobMetadata(raw: Record<string, unknown>): { company: string; title: string; issues: string[] } {
  const metadata = object(raw.metadata)
  const employerMetadata = object(raw.employerMetadata ?? metadata.employer)
  const posting = object(raw.jobPosting ?? raw.jsonLd ?? metadata.jobPosting ?? metadata.jsonLd)
  const ats = object(raw.ats)
  const isAts = raw.sourceType === "ats" || (Boolean(ats.provider) && Boolean(ats.requisitionId))
  const sourceTitle = candidate(raw.title)
  const sourceCompany = candidate(raw.company)
  const titleCandidates = [
    ...(isAts ? [sourceTitle] : []),
    candidate(posting.title),
    candidate(employerMetadata.title),
    ...(!isAts ? [sourceTitle] : []),
    candidate(raw.pageTitle),
  ].filter((value): value is string => value !== null)
  const companyCandidates = [
    ...(isAts ? [sourceCompany] : []),
    candidate(postingOrganizationName(posting)),
    candidate(employerMetadata.company ?? employerMetadata.name),
    ...(!isAts ? [sourceCompany] : []),
  ].filter((value): value is string => value !== null)
  const firstSane = (values: string[], field: "company" | "title") =>
    values.find((value) => field === "company"
      ? !jobMetadataIssues(value, "Role placeholder").some((issue) => issue.startsWith("company_"))
      : !jobMetadataIssues("Company placeholder", value).some((issue) => issue.startsWith("title_")))
  const title = firstSane(titleCandidates, "title") ?? titleCandidates[0] ?? ""
  const company = firstSane(companyCandidates, "company") ?? companyCandidates[0] ?? ""
  return { company, title, issues: jobMetadataIssues(company, title) }
}
