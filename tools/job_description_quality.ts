const BLOCK_TAG = /<\/?(?:address|article|br|dd|div|dl|dt|h[1-6]|li|ol|p|section|table|td|th|tr|ul)\b[^>]*>/gi
const SCRIPT_STYLE = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const TAG = /<[^>]+>/g
const BOILERPLATE = /\b(cookie (?:policy|preferences)|privacy policy|terms of (?:use|service)|all rights reserved|sign in|log in|create an account|browse (?:all )?jobs|job alerts|subscribe to|newsletter|accessibility statement|equal opportunity employer|equal employment opportunity|reasonable accommodation|©\s*\d{4})\b/gi
const SECTION_HEADING = /\b(responsibilities|what you(?:'|’)ll do|what you will do|requirements|qualifications|what you(?:'|’)ll bring|what we(?:'|’)re looking for|about the role|about you|your impact|the opportunity|role overview|who you are)\b/gi
const ACTION_TERM = /\b(build|design|develop|drive|implement|lead|manage|own|partner|protect|review|secure|support|operate|assess|respond|establish|deliver|maintain|create|collaborate)\b/gi

export function normalizedJobDescription(value: unknown): string {
  const raw = typeof value === "string" ? value : ""
  const flattened = raw.replace(SCRIPT_STYLE, " ").replace(BLOCK_TAG, "\n").replace(TAG, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#160|#39);/gi, (_entity, name: string) => ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#160": " ", "#39": "'" })[name.toLowerCase() as "nbsp" | "amp" | "lt" | "gt" | "quot" | "apos" | "#160" | "#39"])
  return flattened.split(/\r?\n/)
    .map((line) => line.replace(BOILERPLATE, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean).join("\n")
}

export function isUsableFullJobDescription(value: unknown): boolean {
  const text = normalizedJobDescription(value)
  const words = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? []
  if (words.length < 40) return false
  const uniqueRatio = new Set(words.map((word) => word.toLocaleLowerCase())).size / words.length
  if (uniqueRatio < 0.25) return false
  const headings = text.match(SECTION_HEADING)?.length ?? 0
  const actions = text.match(ACTION_TERM)?.length ?? 0
  return words.length >= 100 || (headings >= 1 && actions >= 3)
}

export function classifyJobDescription(value: unknown): "full" | "snippet" | "missing" {
  if (!normalizedJobDescription(value)) return "missing"
  return isUsableFullJobDescription(value) ? "full" : "snippet"
}
