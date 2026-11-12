export interface SearchProfileSourceContext {
  definition?: Record<string, unknown> | null
}

export interface SourceCapability {
  generic: boolean
  domains: string[]
}

export interface SourceSelectionDiagnostic {
  provider: string
  enabledByConfig: boolean
  credentialStatus: "available" | "missing_credentials"
  missingCredentials: string[]
  capability: SourceCapability
  profileApplicable: boolean
  selected: boolean
  reason: string
}

const CYBERSECURITY_ALIASES = [
  /\bcyber\s*security\b/i,
  /\binformation\s+security\b/i,
  /\binfosec\b/i,
  /\bsecurity\b/i,
  /\bappsec\b/i,
]

const PROFILE_FIELDS = [
  "target_titles", "targetTitles", "target_terms", "targetTerms",
  "target_adjacent_terms", "role_families", "roleFamilies",
  "positive_concepts", "positiveConcepts", "industries_or_domains",
  "industriesOrDomains",
]

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
}

export function parseSourceCapability(frontmatter: string): SourceCapability {
  const domainLine = frontmatter.match(/^source_domains:\s*\[([^\]]*)\]\s*$/m)?.[1]
  const domains = domainLine
    ? domainLine.split(",").map((value) => value.trim().replace(/^['"]|['"]$/g, "").toLocaleLowerCase()).filter(Boolean)
    : []
  // Missing metadata is intentionally generic for backward compatibility.
  return { generic: domains.length === 0, domains }
}

export function profileMatchesSourceDomain(profile: SearchProfileSourceContext | null | undefined, domain: string): boolean {
  const definition = profile?.definition
  if (!definition || typeof definition !== "object") return false
  const concepts = PROFILE_FIELDS.flatMap((field) => stringValues(definition[field]))
  const text = concepts.join(" ")
  if (domain === "cybersecurity") return CYBERSECURITY_ALIASES.some((pattern) => pattern.test(text))
  const normalizedDomain = domain.replace(/[-_]+/g, " ").trim()
  if (!normalizedDomain) return false
  const escaped = normalizedDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\b${escaped}\\b`, "i").test(text)
}

export function evaluateSourceApplicability(
  provider: string,
  capability: SourceCapability,
  enabledByConfig: boolean,
  missingCredentials: string[],
  profile?: SearchProfileSourceContext | null,
): SourceSelectionDiagnostic {
  const profileApplicable = !profile || capability.generic || capability.domains.some((domain) => profileMatchesSourceDomain(profile, domain))
  const credentialStatus = missingCredentials.length ? "missing_credentials" : "available"
  const selected = enabledByConfig && !missingCredentials.length && profileApplicable
  const reason = !enabledByConfig ? "disabled_by_config"
    : missingCredentials.length ? "missing_credentials"
    : !profileApplicable ? "profile_domain_mismatch"
    : capability.generic ? "generic_provider"
    : "profile_domain_match"
  return { provider, enabledByConfig, credentialStatus, missingCredentials, capability, profileApplicable, selected, reason }
}
