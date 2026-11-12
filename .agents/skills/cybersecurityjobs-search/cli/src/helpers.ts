export const PORTAL = "CyberSecurityJobs"
export const REASON = "CyberSecurityJobs search is behind a Cloudflare managed challenge on jobs.cybersecurityjobs.com."

export function writeError(error: string, code = "PORTAL_DISABLED", details = REASON): void {
  process.stderr.write(JSON.stringify({ error, code, details }) + "\n")
}

export function disabledMessage(): string {
  return `${PORTAL} scraper is disabled: ${REASON}`
}
