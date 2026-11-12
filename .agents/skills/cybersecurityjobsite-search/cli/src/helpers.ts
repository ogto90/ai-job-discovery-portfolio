export const PORTAL = "CyberSecurityJobsite"
export const REASON = "CyberSecurityJobsite search returns 403 and robots.txt disallows query-string search URLs."

export function writeError(error: string, code = "PORTAL_DISABLED", details = REASON): void {
  process.stderr.write(JSON.stringify({ error, code, details }) + "\n")
}

export function disabledMessage(): string {
  return `${PORTAL} scraper is disabled: ${REASON}`
}
