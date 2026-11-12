export function isSecurityLeadershipTitle(title: unknown): boolean {
  const text = String(title ?? "").toLowerCase().replace(/[-_/,:()]+/g, " ").replace(/\s+/g, " ")
  if (/\b(physical security|security guard|loss prevention|product manager|product management|program manager|project manager|account manager|sales manager)\b/.test(text)) return false
  return /\b(security|cybersecurity|infosec|appsec)\b/.test(text)
    && /\b(lead|leader|manager|head|director)\b/.test(text)
}

export function requiresDeepCloudSpecialization(title: unknown, description: unknown): boolean {
  const text = String(description ?? "").replace(/<\/(?:p|li|div|h[1-6])\s*>/gi, "\n").replace(/<[^>]*>/g, " ")
  return /\bcloud security\b/i.test(String(title ?? ""))
    || /\b(?:deep|extensive|expert|hands.on) (?:experience|expertise|familiarity)[^.!;\n]{0,85}(?:attacking cloud|hardening cloud|cloud.native environments|cloud infrastructure)/i.test(text)
    || /\bprimary (?:focus|responsibility)[^.!\n]{0,40}cloud (?:security|infrastructure)/i.test(text)
}
