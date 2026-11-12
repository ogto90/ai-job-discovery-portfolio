export const PORTAL = "Wellfound"
export const REASON = "Wellfound search is not available as a reliable unauthenticated public CLI source; support docs describe search as a signed-in workflow and robots.txt disallows key search surfaces."

export function writeError(error: string, code = "PORTAL_DISABLED", details = REASON): void {
  process.stderr.write(JSON.stringify({ error, code, details }) + "\n")
}

export function disabledMessage(): string {
  return `${PORTAL} scraper is disabled: ${REASON}`
}
