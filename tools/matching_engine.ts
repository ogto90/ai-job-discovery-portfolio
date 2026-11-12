import type { NormalizedJob } from "./company_registry"
import { extractJobRequirements, type CandidateProfile, type EligibilityResult, type Evidence, type JobRequirements } from "./eligibility_engine"

export const MATCHER_VERSION = 3

export type MatchRecommendation = "excellent" | "strong" | "review" | "weak"
export type MatchDimensionName =
  | "roleFit"
  | "technicalDomainFit"
  | "skillFit"
  | "experienceFit"
  | "seniorityFit"
  | "careerDirectionFit"
  | "certificationGovernanceFit"
  | "industryFit"
  | "salaryFit"

export interface JobMatchFeatures {
  schemaVersion: number
  roleFamilies: string[]
  primaryRoleFamilies?: string[]
  requiredExpertise?: Array<{ group: string; minimumScore: number; evidence: string }>
  skills: Array<{ skill: string; group: string; importance: "required" | "preferred" | "mentioned"; evidence: Evidence[] }>
  technicalDomains: string[]
  certifications: string[]
  industryContexts: string[]
  salary?: { min?: number; max?: number; currency?: string; raw?: unknown } | null
  flags: {
    salesGtm: boolean
    cloudSpecialist: boolean
    endpointSpecialist: boolean
    socHeavy: boolean
    auditOnly: boolean
    iamHeavy: boolean
    linuxCryptoHeavy: boolean
    federalClearance: boolean
    customerFacing: boolean
    governanceHeavy: boolean
  }
  evidence: Evidence[]
}

export interface MatchDimension {
  score: number
  reason: string
  matched?: string[]
  gaps?: string[]
}

export interface MatchResult {
  matcherVersion: number
  overallScore: number
  recommendation: MatchRecommendation
  dimensions: Record<MatchDimensionName, MatchDimension | null>
  strengths: string[]
  gaps: string[]
  eligibilityStatus: EligibilityResult["status"]
  eligibilityNote?: string
  confidence: number
  features: JobMatchFeatures
}

const WEIGHTS: Record<Exclude<MatchDimensionName, "salaryFit">, number> = {
  roleFit: 0.22,
  technicalDomainFit: 0.20,
  skillFit: 0.18,
  experienceFit: 0.10,
  seniorityFit: 0.10,
  careerDirectionFit: 0.12,
  certificationGovernanceFit: 0.04,
  industryFit: 0.04,
}

const SKILL_GROUPS: Array<[string, RegExp]> = [
  ["offensive_security", /\b(offensive security|red team(?:ing)?|penetration testing|advanced web application testing)\b/i],
  ["manual_code_audit", /\b(manual code audit|source code audit|white.box assessment|manual security code review)\b/i],
  ["identity_automation", /\b(identity automation|joiner.{0,20}leaver automation|MDM automation)\b/i],
  ["application_security", /\b(appsec|application security|software security)\b/i],
  ["secure_sdlc", /\b(secure sdlc|ssdlc|devsecops|secure coding|security in ci\/cd|ci\/cd security)\b/i],
  ["sast", /\b(sast|static analysis|coverity|checkmarx|fortify|semgrep|codeql)\b/i],
  ["sca", /\b(sca|software composition|dependency scanning|black duck|snyk|mend|sonatype)\b/i],
  ["dast", /\b(dast|dynamic analysis|acunetix|burp)\b/i],
  ["vulnerability_management", /\b(vulnerability management|vulnerability triage|vulnerability remediation|patch management|tenable|qualys|rapid7)\b/i],
  ["threat_modeling", /\bthreat model(?:ing|ling)?\b/i],
  ["product_security", /\bproduct security|psirt\b/i],
  ["security_operations", /\bsecurity operations|detection engineering|siem|splunk|incident response|soc\b/i],
  ["cloud_security", /\bcloud security|aws|azure|gcp|kubernetes|container security|platform security|zero trust\b/i],
  ["endpoint_security", /\bendpoint|edr|xdr|device security|mdm\b/i],
  ["iam", /\biam|identity and access|entra id|active directory|sso\b/i],
  ["grc", /\b(grc|governance|compliance|risk|audit|iso 27001|soc 2|is27001|isms)\b/i],
  ["security_architecture", /\bsecurity architecture|security architect|defensible architecture\b/i],
  ["cryptography", /\bcryptography|crypto|c\+\+|linux kernel|low-level|systems programming\b/i],
  ["network_security", /\bnetwork security|firewall|ids\/ips|nids\b/i],
  ["sales_gtm", /\bgtm|go-to-market|sales strategy|field enablement|revenue growth|territory manager\b/i],
  ["federal_clearance", /\bsecurity clearance|federal|dod|government contractor|citizenship required\b/i],
]

function skillImportance(text: string, pattern: RegExp): "required" | "preferred" | "mentioned" {
  const match = text.match(pattern)
  const start = match?.index ?? 0
  const context = text.slice(Math.max(0, start - 120), Math.min(text.length, start + 180))
  if (/\brequired|must have|need(?:s|ed)?\b/i.test(context)) return "required"
  if (/\bpreferred|nice to have|plus\b/i.test(context)) return "preferred"
  return "mentioned"
}

function textForJob(job: NormalizedJob): string {
  return [
    job.title,
    job.company,
    job.location,
    job.description,
    (job.metadata as Record<string, unknown> | undefined)?.descriptionText,
    job.department,
    job.team,
    ...(Array.isArray(job.tags) ? job.tags : []),
    ...(Array.isArray(job.categories) ? job.categories : []),
  ].filter((value) => value !== undefined && value !== null).map(String).join("\n")
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function evidence(field: string, text: string): Evidence[] {
  return text.trim() ? [{ field, text: text.trim().slice(0, 240), source: "match_extraction", confidence: 0.75 }] : []
}

function skillLevelScore(level?: string): number {
  if (level === "strong") return 100
  if (level === "moderate") return 75
  if (level === "weak" || level === "mentioned") return 45
  return 0
}

function candidateSkillGroups(candidate: CandidateProfile): Map<string, number> {
  const groups = new Map<string, number>()
  for (const skill of candidate.skills ?? []) {
    for (const [group, pattern] of SKILL_GROUPS) {
      if (pattern.test(skill.skill)) groups.set(group, Math.max(groups.get(group) ?? 0, skillLevelScore(skill.level)))
    }
  }
  for (const group of candidate.matchPreferences?.strengths ?? []) groups.set(group, Math.max(groups.get(group) ?? 0, 95))
  for (const group of candidate.matchPreferences?.moderate ?? []) groups.set(group, Math.max(groups.get(group) ?? 0, 70))
  return groups
}

function requiredExpertise(job: NormalizedJob): NonNullable<JobMatchFeatures["requiredExpertise"]> {
  const lines = String(job.description ?? "").replace(/<\/(?:p|li|div|h[1-6])\s*>/gi, "\n").replace(/<[^>]*>/g, " ").split(/\n/)
  const requirements: NonNullable<JobMatchFeatures["requiredExpertise"]> = []
  const patterns: Array<[string, number, RegExp]> = [
    ["offensive_security", 90, /(?:expert.level.{0,100}(?:web application|API) security|(?:at least|minimum) [5-9] years.{0,100}offensive security)/i],
    ["manual_code_audit", 75, /(?:practical experience|expertise|required).{0,150}(?:white.{0,3}grey.box|white.box|manual code audit|source code audit)/i],
    ["cloud_security", 75, /(?:you.{0,8}(?:have )?secured|experience (?:securing|hardening)|must.{0,30}(?:secure|harden)).{0,70}(?:AWS|GCP|Azure|cloud environment)/i],
    ["identity_automation", 75, /(?:you.{0,8}(?:have )?owned|experience (?:owning|automating)|must.{0,30}own).{0,100}(?:MDM|joiner.{0,20}leaver|identity automation)/i],
  ]
  let preferredSection = false
  for (const line of lines) {
    if (/^(?:big plus|nice.to.have|preferred qualifications|bonus)/i.test(line.trim())) preferredSection = true
    if (/^(?:required|requirements|what we.re looking for)/i.test(line.trim())) preferredSection = false
    if (preferredSection || /\b(?:nice.to.have|preferred|is a plus|not required|not mandatory|won.t own)\b/i.test(line)) continue
    for (const [group, minimumScore, pattern] of patterns) {
      if (pattern.test(line) && !requirements.some((item) => item.group === group)) requirements.push({ group, minimumScore, evidence: line.trim().slice(0, 500) })
    }
  }
  return requirements
}

function expertiseGaps(candidate: CandidateProfile, features: JobMatchFeatures): string[] {
  const groups = candidateSkillGroups(candidate)
  return (features.requiredExpertise ?? []).filter((requirement) => (groups.get(requirement.group) ?? 0) < requirement.minimumScore)
    .map((requirement) => `Required depth not evidenced in profile: ${requirement.group.replace(/_/g, " ")}`)
}

export function extractJobMatchFeatures(job: NormalizedJob, requirements: JobRequirements = extractJobRequirements(job)): JobMatchFeatures {
  const text = textForJob(job)
  const lower = text.toLowerCase()
  const skills = SKILL_GROUPS
    .filter(([, pattern]) => pattern.test(text))
    .map(([group, pattern]) => ({
      skill: group.replace(/_/g, " "),
      group,
      importance: skillImportance(text, pattern),
      evidence: evidence("job_text", group),
    }))
  const technicalDomains = unique(skills.map((skill) => skill.group))
  const certifications = unique(["CISM", "CISSP", "ISO 27001", "SOC 2"].filter((token) => new RegExp(`\\b${token.replace(" ", "\\s+")}\\b`, "i").test(text)))
  const auditOnly = /\baudit|control testing|evidence collection\b/i.test(text) && !/\bsecure sdlc|application security|product security|engineering|developer|vulnerability management\b/i.test(text)
  const title = String(job.title ?? "")
  const focus = text.length < 400 ? text : text.split(/[.\n]/).filter((line) => /\b(?:primary focus|speciali[sz]|responsible for|own|build|deploy|operate|manage)\b/i.test(line)).join("\n")
  const cloudSpecialist = /\bcloud security|kubernetes|platform security|cloud-native|aws-based|container security\b/i.test(title + " " + focus) && !/\bapplication security|secure sdlc|product security\b/i.test(text)
  const linuxCryptoHeavy = /\blinux kernel|c\+\+|low-level|cryptography implementation|systems programming\b/i.test(text) || (lower.includes("linux") && lower.includes("cryptography"))
  const roleFamilies = unique([
    ...requirements.roleFamilies,
    ...skills.map((skill) => skill.group).filter((group) => {
      if (["sast", "sca", "dast", "threat_modeling", "federal_clearance"].includes(group)) return false
      if (group === "cloud_security") return cloudSpecialist
      if (group === "cryptography") return linuxCryptoHeavy
      return true
    }),
  ])
  return {
    schemaVersion: 1,
    requiredExpertise: requiredExpertise(job),
    roleFamilies,
    primaryRoleFamilies: extractJobRequirements({ title: job.title }).roleFamilies,
    skills,
    technicalDomains,
    certifications,
    industryContexts: unique([
      ...( /\bsoftware|product|engineering|developer|sdlc|platform\b/i.test(text) ? ["product_company"] : []),
      ...( /\bblockchain|web3|defi|crypto protocol\b/i.test(text) ? ["web3"] : []),
      ...( /\bfederal|dod|clearance|government contractor\b/i.test(text) ? ["federal_defense"] : []),
      ...( /\bgtm|go-to-market|sales|revenue\b/i.test(text) ? ["sales"] : []),
    ]),
    salary: typeof job.salary === "object" && job.salary ? job.salary as JobMatchFeatures["salary"] : null,
    flags: {
      salesGtm: /\bgtm|go-to-market|sales strategy|field enablement|revenue growth|territory manager\b/i.test(text),
      cloudSpecialist,
      endpointSpecialist: /\bendpoint|edr|xdr|device security|mdm\b/i.test(title + " " + focus),
      socHeavy: /\bsecurity operations center|\bsoc\b(?!\s*2)|\bl1\b|\bl2 monitoring\b/i.test(text),
      auditOnly,
      iamHeavy: /\biam|identity and access|entra id|active directory\b/i.test(text) && !/\bapplication security|product security\b/i.test(text),
      linuxCryptoHeavy,
      federalClearance: /\bsecurity clearance|federal|dod|citizenship required|government contractor\b/i.test(text),
      customerFacing: /\bcustomer-facing|client-facing|consulting|stakeholder|field\b/i.test(text),
      governanceHeavy: /\biso 27001|soc 2|grc|compliance|audit|risk management|isms\b/i.test(text),
    },
    evidence: evidence("title", String(job.title ?? "")),
  }
}

function scoreRole(candidate: CandidateProfile, features: JobMatchFeatures): MatchDimension {
  const target = new Set(candidate.rolePreferences?.targetRoles ?? [])
  const secondary = new Set(candidate.rolePreferences?.secondaryRoles ?? [])
  const low = new Set([...(candidate.rolePreferences?.lowInterestRoles ?? []), ...(candidate.matchPreferences?.lowInterest ?? [])])
  const targetHits = features.roleFamilies.filter((family) => target.has(family))
  const secondaryHits = features.roleFamilies.filter((family) => secondary.has(family))
  const lowHits = (features.primaryRoleFamilies ?? features.roleFamilies).filter((family) => low.has(family))
  let score = targetHits.length ? 88 : secondaryHits.length ? 70 : 52
  score -= lowHits.length * 20
  if (features.flags.socHeavy && !targetHits.includes("security_operations")) score -= 18
  if (features.flags.auditOnly) score -= 20
  if (features.flags.salesGtm) score = Math.min(score, 22)
  return { score: clamp(score), reason: targetHits.length ? `target role overlap: ${targetHits.join(", ")}` : secondaryHits.length ? `secondary role overlap: ${secondaryHits.join(", ")}` : "limited role-family overlap", matched: [...targetHits, ...secondaryHits], gaps: lowHits }
}

function scoreTechnical(candidate: CandidateProfile, features: JobMatchFeatures): MatchDimension {
  const strengths = new Set(candidate.matchPreferences?.strengths ?? [])
  const moderate = new Set(candidate.matchPreferences?.moderate ?? [])
  const matched = features.technicalDomains.filter((domain) => strengths.has(domain) || moderate.has(domain))
  const lowFlags = [
    features.flags.cloudSpecialist ? "cloud/platform specialization" : null,
    features.flags.endpointSpecialist ? "endpoint specialization" : null,
    features.flags.linuxCryptoHeavy ? "low-level Linux/cryptography depth" : null,
    features.flags.salesGtm ? "sales/GTM orientation" : null,
  ].filter(Boolean) as string[]
  let score = matched.length ? Math.min(94, 62 + matched.length * 9) : 48
  if (matched.includes("secure_sdlc") && features.technicalDomains.includes("application_security")) score += 5
  if (matched.includes("threat_modeling") && features.technicalDomains.includes("product_security")) score += 5
  score -= lowFlags.length * 18
  if (features.flags.salesGtm) score = Math.min(score, 20)
  return { score: clamp(score), reason: matched.length ? `technical overlap with ${matched.join(", ")}` : "limited technical-domain overlap", matched, gaps: lowFlags }
}

function scoreSkills(candidate: CandidateProfile, features: JobMatchFeatures): MatchDimension {
  const groups = candidateSkillGroups(candidate)
  const required = features.skills.filter((skill) => skill.importance === "required")
  const considered = features.skills.length ? features.skills : []
  const scores = considered.map((skill) => groups.get(skill.group) ?? 20)
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 55
  const missingRequired = required.filter((skill) => (groups.get(skill.group) ?? 0) < 50).map((skill) => skill.group)
  return { score: clamp(avg - missingRequired.length * 18), reason: considered.length ? "matched against transferable skill groups" : "few explicit skill requirements extracted", matched: considered.filter((skill) => (groups.get(skill.group) ?? 0) >= 50).map((skill) => skill.group), gaps: missingRequired }
}

function scoreSeniority(candidate: CandidateProfile, req: JobRequirements): MatchDimension {
  if (req.seniority === "unknown") return { score: 68, reason: "seniority not explicit" }
  if ((candidate.seniority?.target ?? []).includes(req.seniority)) return { score: 92, reason: `${req.seniority} is a target seniority` }
  if ((candidate.seniority?.acceptable ?? []).includes(req.seniority)) return { score: 78, reason: `${req.seniority} is acceptable` }
  return { score: 45, reason: `${req.seniority} is not an ideal seniority` }
}

function scoreCareer(candidate: CandidateProfile, req: JobRequirements, features: JobMatchFeatures): MatchDimension {
  let score = 70
  if (req.careerTrack === "individual_contributor") score = candidate.careerTrack?.prefer === "individual_contributor" ? 90 : 84
  if (req.careerTrack === "hands_on_lead") score = candidate.careerTrack?.allowHandsOnLead === false ? 48 : candidate.careerTrack?.prioritizeLeadership ? 94 : 88
  if (req.careerTrack === "people_manager") score = candidate.careerTrack?.allowPeopleManagement === false ? 35 : candidate.careerTrack?.prioritizeLeadership ? 88 : 64
  if (features.flags.salesGtm) score = 18
  return { score: clamp(score), reason: features.flags.salesGtm ? "sales/GTM direction is far from the profile" : `career track: ${req.careerTrack}` }
}

function scoreExperience(features: JobMatchFeatures): MatchDimension {
  let score = 70
  if (features.technicalDomains.includes("vulnerability_management")) score += 8
  if (features.technicalDomains.includes("application_security") || features.technicalDomains.includes("product_security")) score += 10
  if (features.flags.linuxCryptoHeavy) score -= 25
  if (features.flags.endpointSpecialist) score -= 18
  if (features.flags.salesGtm) score -= 35
  return { score: clamp(score), reason: "estimated from extracted responsibility domains" }
}

function scoreGovernance(candidate: CandidateProfile, features: JobMatchFeatures): MatchDimension {
  const hasCert = (candidate.certifications ?? []).some((cert) => /cism|cissp/i.test(cert))
  const relevant = features.flags.governanceHeavy || features.technicalDomains.includes("grc")
  return { score: relevant ? hasCert ? 90 : 68 : 62, reason: relevant ? "governance/compliance responsibilities detected" : "limited governance relevance" }
}

function scoreIndustry(candidate: CandidateProfile, features: JobMatchFeatures): MatchDimension {
  const preferred = new Set(candidate.matchPreferences?.preferredIndustries ?? [])
  const low = new Set(candidate.matchPreferences?.lowerInterestIndustries ?? [])
  const prefHits = features.industryContexts.filter((ctx) => preferred.has(ctx))
  const lowHits = features.industryContexts.filter((ctx) => low.has(ctx))
  let score = prefHits.length ? 82 : 68
  if (features.industryContexts.includes("web3")) score -= 10
  score -= lowHits.length * 22
  return { score: clamp(score), reason: prefHits.length ? `preferred context: ${prefHits.join(", ")}` : "neutral or unclear industry context", matched: prefHits, gaps: lowHits }
}

function scoreSalary(candidate: CandidateProfile, features: JobMatchFeatures): MatchDimension | null {
  const target = candidate.matchPreferences?.salaryTarget
  const salary = features.salary
  if (!target || !salary?.currency || (!salary.min && !salary.max)) return null
  if (salary.currency !== target.currency) return { score: 60, reason: "salary currency differs from target; no FX conversion applied" }
  const value = salary.max ?? salary.min ?? 0
  return { score: value >= target.amount ? 85 : 45, reason: value >= target.amount ? "published salary appears at or above target" : "published salary appears below target" }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function recommendation(score: number): MatchRecommendation {
  if (score >= 90) return "excellent"
  if (score >= 75) return "strong"
  if (score >= 60) return "review"
  return "weak"
}

export function matchCandidateToJob(candidate: CandidateProfile, job: NormalizedJob, eligibility: EligibilityResult, requirements: JobRequirements = extractJobRequirements(job)): MatchResult {
  const features = extractJobMatchFeatures(job, requirements)
  const dimensions = {
    roleFit: scoreRole(candidate, features),
    technicalDomainFit: scoreTechnical(candidate, features),
    skillFit: scoreSkills(candidate, features),
    experienceFit: scoreExperience(features),
    seniorityFit: scoreSeniority(candidate, requirements),
    careerDirectionFit: scoreCareer(candidate, requirements, features),
    certificationGovernanceFit: scoreGovernance(candidate, features),
    industryFit: scoreIndustry(candidate, features),
    salaryFit: scoreSalary(candidate, features),
  }
  const unmetExpertise = expertiseGaps(candidate, features)
  if (unmetExpertise.length) {
    for (const name of ["technicalDomainFit", "skillFit", "experienceFit"] as const) {
      const dimension = dimensions[name]
      dimension.score = clamp(dimension.score - 18 * unmetExpertise.length)
      dimension.gaps = unique([...(dimension.gaps ?? []), ...unmetExpertise])
      dimension.reason += "; required specialist depth is not evidenced in the candidate profile"
    }
  }
  let overall = Object.entries(WEIGHTS).reduce((sum, [name, weight]) => sum + dimensions[name as keyof typeof WEIGHTS].score * weight, 0)
  if (eligibility.status === "unknown") overall -= 6
  const strengths = unique([
    ...Object.values(dimensions).flatMap((dimension) => dimension?.matched ?? []),
    ...(features.flags.governanceHeavy ? ["governance/compliance experience may be relevant"] : []),
  ]).slice(0, 5)
  const gaps = unique([
    ...unmetExpertise,
    ...(requirements.careerTrack === "people_manager" ? ["Verify team size, direct reports, hiring and budget requirements; technical leadership alone does not establish people-management experience."] : []),
    ...Object.values(dimensions).flatMap((dimension) => dimension?.gaps ?? []),
    ...(eligibility.status === "unknown" ? eligibility.notes : []),
  ]).slice(0, 5)
  return {
    matcherVersion: MATCHER_VERSION,
    overallScore: clamp(overall),
    recommendation: recommendation(clamp(overall)),
    dimensions,
    strengths,
    gaps,
    eligibilityStatus: eligibility.status,
    eligibilityNote: eligibility.status === "unknown" ? eligibility.notes.join("; ") : undefined,
    confidence: String(job.description ?? "").replace(/<[^>]*>/g, " ").length < 400 ? 0.5 : eligibility.status === "unknown" ? 0.72 : 0.86,
    features,
  }
}
