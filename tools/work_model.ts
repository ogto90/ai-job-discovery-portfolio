export type WorkModel = "remote" | "hybrid" | "onsite" | "unknown"

export interface WorkModelEvidence {
  title?: string | null
  location?: string | null
  remoteScope?: string | null
  description?: string | null
  structuredWorkModel?: string | null
}

function roleStatements(value: string): Set<WorkModel> {
  const models = new Set<WorkModel>()
  const text = value.replace(/<[^>]*>/g, " ")
    .replace(/\bThis (?:is )?a (?:Full|Fully|100%)? ?Remote job,? the offer is available from:/gi, "")
  if (/\b(?:hybrid (?:role|position|job|working model)|hybrid (?:in|based in) [A-Z][^.!?\n]{0,60}|(?:role|position|job|work(?:ing)? model|workplace type)\s*(?::|is|—|-)\s*hybrid|\d+\s+days?\s+in(?: the)? office[^.!?\n]{0,80}\d+\s+days?\s+remote)\b/i.test(text)) models.add("hybrid")
  if (/\b(?:on[- ]?site (?:role|position|job|in\b)|office[- ]based (?:role|position|job)|(?:role|position|job|work(?:ing)? model|workplace type)\s*(?::|is|—|-)\s*(?:on[- ]?site|in[- ]?office)|must work from (?:our|the) [^.!?\n]{0,60}office)\b/i.test(text)) models.add("onsite")
  if (/\b(?:(?:fully|100%|completely|entirely) remote\b|remote[- ]first (?:role|position|job)\b|remote (?:role|position|job)\b|(?:role|position|job|work(?:ing)? model|workplace type|location)\s*(?::|is|—|-)\s*(?:fully )?remote\b|remote (?:within|across|throughout|in|from)\b|work remotely from\b|(?:role|position|job) can be performed remotely from\b|work from anywhere\b)/i.test(text)) models.add("remote")
  return models
}

function sourceModel(value: string): WorkModel {
  const text = value.trim()
  if (/^(?:hybrid|hybrid work(?:ing)?|hybrid[ ,/-].+)$/i.test(text)) return "hybrid"
  if (/^(?:on[- ]?site|in[- ]?office|office[- ]based)(?:[ ,/-].*)?$/i.test(text)) return "onsite"
  if (/^(?:remote|fully remote|full remote|100% remote)(?:[ ,/-].*)?$/i.test(text)) return "remote"
  if (/(?:\s[-—]\s|\s\/\s)(?:fully |full |100% )?remote$/i.test(text)) return "remote"
  return "unknown"
}

export function classifyWorkModel(evidence: WorkModelEvidence): WorkModel {
  const structured = sourceModel(evidence.structuredWorkModel ?? "")
  if (structured !== "unknown") return structured
  const exact = roleStatements(`${evidence.title ?? ""}\n${evidence.description ?? ""}`)
  if (/\bhybrid\b/i.test(evidence.title ?? "")) exact.add("hybrid")
  if (/\b(?:on[- ]?site|in[- ]?office)\b/i.test(evidence.title ?? "")) exact.add("onsite")
  if (/\bremote\b/i.test(evidence.title ?? "")) exact.add("remote")
  if (exact.size > 1) return "unknown"
  if (exact.size === 1) return [...exact][0]
  const scope = sourceModel(evidence.remoteScope ?? "")
  if (scope !== "unknown") return scope
  return sourceModel(evidence.location ?? "")
}
