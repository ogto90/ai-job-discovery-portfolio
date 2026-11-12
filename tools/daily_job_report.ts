import { dedupeShortlist } from "./shortlist_dedup"
import { normalizeCacheUrl } from "./job_availability_validator"
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { connect as tlsConnect, type TLSSocket } from "node:tls"
import { connect as netConnect, type Socket } from "node:net"
import { runJobPipeline, uniqueKey, type PipelineArtifact, type PipelineJob, type PipelineOptions } from "./job_pipeline"
import { buildSearchQueries, createSupabaseDiscoveryStoreFromEnv, normalizeDiscoveredJob, type SearchProfileRecord } from "./generic_discovery"

export interface DailyReportOptions {
  pipelineRunner?: typeof runJobPipeline
  threshold?: number
  top?: number
  outDir?: string
  recipient?: string
  sender?: string
  subject?: string
  compileCv?: boolean
  masterCvPath?: string
  send?: boolean
  sendmailPath?: string
  smtp?: SmtpOptions
  candidateProfilePath?: string | null
  source?: string
  limit?: number
  includeUnvalidated?: boolean
  disableEnrichment?: boolean
  trackerPath?: string
  shortlistPath?: string
  now?: Date
  userId?: string
  profileLoader?: (userId: string) => Promise<SearchProfileRecord>
  suppressionChecker?: PipelineOptions["suppressionChecker"]
}

export interface GeneratedCv {
  jobKey: string
  texPath: string
  pdfPath?: string
  compileStatus: "compiled" | "failed" | "skipped"
  compileError?: string
}

export interface DailyReportResult {
  artifact: PipelineArtifact
  artifactPath?: string
  outDir: string
  htmlPath: string
  textPath: string
  emlPath: string
  generatedCvs: GeneratedCv[]
  topJobs: PipelineJob[]
  sent: boolean
  sendError?: string
}

export interface SmtpOptions {
  host: string
  port: number
  user: string
  password: string
  secure?: boolean
}

const DEFAULT_THRESHOLD = 80
const DEFAULT_TOP = 10
const MASTER_CV = "cv/main_example.tex"
const DEFAULT_TRACKER = "job_search_tracker.csv"

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function score(job: PipelineJob): number {
  return job.pipeline?.match?.overallScore ?? 0
}

function jobUrl(job: PipelineJob): string {
  return String(job.applicationUrl ?? job.canonicalUrl ?? job.url ?? "")
}

function stableJobKey(job: PipelineJob): string {
  return `${String(job.company ?? "unknown")}-${String(job.title ?? "role")}-${jobUrl(job)}`.toLowerCase()
}

function normalizeTrackerValue(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export function trackerJobKey(company: unknown, role: unknown): string {
  return `${normalizeTrackerValue(company)}::${normalizeTrackerValue(role)}`
}

export function isTrackedJob(job: PipelineJob, keys: Set<string>): boolean {
  return keys.has(trackerJobKey(job.company, job.title)) || [job.url, job.canonicalUrl, job.applicationUrl].some((url) => typeof url === "string" && keys.has(`url:${normalizeCacheUrl(url)}`))
}

function slug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "job"
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function escapeLatex(value: unknown): string {
  return String(value ?? "")
    .replace(/[\\#$%&_{}^~]/g, (character) => ({
      "\\": "\\textbackslash{}", "#": "\\#", "$": "\\$", "%": "\\%", "&": "\\&", "_": "\\_",
      "{": "\\{", "}": "\\}", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}",
    })[character])
}

function wrapText(items: string[], fallback: string): string {
  const clean = items.map((item) => item.replace(/_/g, " ")).filter(Boolean)
  if (clean.length === 0) return fallback
  if (clean.length === 1) return clean[0]
  return `${clean.slice(0, -1).join(", ")} and ${clean.at(-1)}`
}

export function selectTopJobs(artifact: PipelineArtifact, threshold = DEFAULT_THRESHOLD, top = DEFAULT_TOP, excludedTrackerKeys: Set<string> = new Set()): PipelineJob[] {
  return dedupeShortlist(artifact.jobs
    .filter((job) => !job.pipeline?.excluded)
    .filter((job) => !isTrackedJob(job, excludedTrackerKeys))
    .filter((job) => dailyReportExclusionReason(job) === null)
    .filter((job) => job.pipeline?.searchEligibility?.actionable === true))
    .filter((job) => score(job) >= threshold)
    .sort((a, b) => score(b) - score(a) || String(a.company ?? "").localeCompare(String(b.company ?? "")))
    .slice(0, top)
}


export function dailyReportExclusionReason(job: PipelineJob): string | null {
  if (job.pipeline?.suppressed) return "already applied to, closed, or ignored by this user"
  const result = job.pipeline?.searchEligibility
  if (!result) return "SearchProfile eligibility is unresolved"
  if (result.actionable) return null
  if (["unrelated", "excluded"].includes(result.role)) return "SearchProfile role preference not met"
  const failedDimension = Object.entries(result).find(([key, value]) => key !== "actionable" && value === "ineligible")?.[0]
  return failedDimension ? `SearchProfile ${failedDimension} preference not met` : "SearchProfile eligibility is unresolved"
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ""
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\""
        index++
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === "," && !quoted) {
      cells.push(current)
      current = ""
      continue
    }
    current += char
  }
  cells.push(current)
  return cells
}

export async function loadExcludedTrackerKeys(trackerPath: string): Promise<Set<string>> {
  if (!existsSync(trackerPath)) return new Set()
  const text = await readFile(trackerPath, "utf8")
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) return new Set()
  const header = parseCsvLine(lines[0]).map((item) => item.trim().toLowerCase())
  const companyIndex = header.indexOf("company")
  const roleIndex = header.indexOf("role")
  if (companyIndex < 0 || roleIndex < 0) return new Set()
  const keys = new Set<string>()
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    const key = trackerJobKey(cells[companyIndex], cells[roleIndex])
    const status = cells[header.indexOf("status")]?.toLowerCase()
    const source = cells[header.indexOf("source")] ?? ""
    const url = source.match(/https?:\/\/[^\s]+/)?.[0]
    if (url) keys.add(`url:${normalizeCacheUrl(url)}`)
    // Expiry is vacancy-specific. Explicit dismissals retain the existing role-level scope.
    if (key !== "::" && (status !== "expired" || !url)) keys.add(key)
  }
  return keys
}

function tailorCv(master: string, job: PipelineJob): string {
  const strengths = wrapText(job.pipeline?.match?.strengths ?? [], "application security, vulnerability management and security program ownership")
  const title = String(job.title ?? "this role")
  const company = String(job.company ?? "the company")
  const summary = escapeLatex(
    `CISM-certified Senior Security Engineer targeting ${title} at ${company}. Strongest alignment: ${strengths}. Brings application security, vulnerability management, secure SDLC, incident response coordination, and security program ownership experience, with a pragmatic focus on developer enablement, risk-based prioritization, and measurable remediation outcomes.`,
  )
  const replacement = `\\small{${summary}}`
  const summarySection = /\\cvsection\{Summary\}\s*\{\s*\\BodyStyle\\RaggedRight[\s\S]*?\\par\s*\}/
  if (summarySection.test(master)) {
    return master.replace(summarySection, `\\cvsection{Summary}\n{\\BodyStyle\\RaggedRight\n${summary}\\par}`)
  }
  const legacySummary = /\\small\{[\s\S]*?\}\n\n\\section\{Core Competencies\}/
  if (legacySummary.test(master)) {
    return master.replace(legacySummary, `${replacement}\n\n\\section{Core Competencies}`)
  }
  throw new Error("The base CV has no recognized summary section; refusing to emit an untailored copy.")
}

async function compilePdf(texPath: string): Promise<{ pdfPath?: string; error?: string }> {
  const cwd = dirname(texPath)
  const helper = resolve("tools/compile_latex_sandbox.py")
  const target = texPath.replace(/\.tex$/i, ".pdf")
  return await new Promise((resolvePromise) => {
    const child = spawn("python3", [helper, texPath, target], {
      cwd,
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    const timeout = setTimeout(() => child.kill("SIGKILL"), 100_000)
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2000) })
    child.on("close", (code) => {
      clearTimeout(timeout)
      resolvePromise(code === 0
        ? { pdfPath: target }
        : { error: (stderr || `sandboxed lualatex failed with exit code ${String(code)}`).slice(0, 2000) })
    })
    child.on("error", (error) => {
      clearTimeout(timeout)
      resolvePromise({ error: `sandboxed lualatex could not start: ${error.message}`.slice(0, 2000) })
    })
  })
}

export async function generateCvs(jobs: PipelineJob[], outDir: string, compileCv: boolean, masterCvPath = MASTER_CV): Promise<GeneratedCv[]> {
  const cvDir = resolve(outDir, "cv")
  await mkdir(cvDir, { recursive: true })
  const master = await readFile(masterCvPath, "utf8")
  const generated: GeneratedCv[] = []
  for (const job of jobs) {
    const key = slug(`${String(job.company ?? "company")}-${String(job.title ?? "role")}`)
    const texPath = resolve(cvDir, `main_${key}.tex`)
    await writeFile(texPath, tailorCv(master, job), "utf8")
    if (!compileCv) {
      generated.push({ jobKey: stableJobKey(job), texPath, compileStatus: "skipped" })
      continue
    }
    const compiled = await compilePdf(texPath)
    generated.push({
      jobKey: stableJobKey(job),
      texPath,
      pdfPath: compiled.pdfPath,
      compileStatus: compiled.pdfPath ? "compiled" : "failed",
      compileError: compiled.error,
    })
  }
  return generated
}

function missing(job: PipelineJob): string[] {
  return [
    ...(job.pipeline?.match?.gaps ?? []),
    ...(job.pipeline?.eligibility.status === "unknown" ? job.pipeline.eligibility.notes : []),
  ].slice(0, 5)
}

export function renderHtml(artifact: PipelineArtifact, jobs: PipelineJob[], cvs: GeneratedCv[], generatedAt: Date): string {
  const cvByKey = new Map(cvs.map((cv) => [cv.jobKey, cv]))
  const cards = jobs.map((job, index) => {
    const cv = cvByKey.get(stableJobKey(job))
    const url = jobUrl(job)
    const strengths = job.pipeline?.match?.strengths ?? []
    const gaps = missing(job)
    return `
      <section style="border:1px solid #d8dee9;border-radius:8px;padding:16px;margin:14px 0;background:#fff">
        <h2 style="margin:0 0 4px;font-size:18px">${index + 1}. ${escapeHtml(job.title)} at ${escapeHtml(job.company)}</h2>
        <p style="margin:0 0 8px;color:#4b5563">${escapeHtml(job.location)} · Score <strong>${score(job)}</strong> · ${escapeHtml(job.pipeline?.match?.recommendation ?? "review")}</p>
        <p><a href="${escapeHtml(url)}">Open listing</a></p>
        <h3 style="font-size:14px;margin-bottom:4px">Why it is a good pick</h3>
        <ul>${(strengths.length ? strengths : ["Strong enough match to review manually"]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        <h3 style="font-size:14px;margin-bottom:4px">Realistic gaps / checks</h3>
        <ul>${(gaps.length ? gaps : ["No major deterministic gap detected; still verify the live listing before applying."]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        <p style="color:#4b5563">CV: ${cv?.pdfPath ? escapeHtml(basename(cv.pdfPath)) : cv?.texPath ? escapeHtml(basename(cv.texPath)) : "not generated"}</p>
      </section>`
  }).join("\n")
  return `<!doctype html>
<html>
<body style="margin:0;background:#f6f7f9;color:#111827;font-family:Arial,sans-serif">
  <main style="max-width:860px;margin:0 auto;padding:24px">
    <h1 style="margin-bottom:4px">Daily Job Search Report · ${escapeHtml(ymd(generatedAt))}</h1>
    <p style="color:#4b5563">Found ${artifact.counts.finalCandidates} actionable roles. Selected ${jobs.length} matching the configured score threshold.</p>
    <p style="color:#4b5563">Acquisition: ${acquisitionHealth(artifact)}. Unavailable configured sources: ${escapeHtml(artifact.sourceCoverage?.filter((item) => item.state === "missing_credentials").map((item) => item.name).join(", ") || "none")}.</p>
    <p style="color:#4b5563">Sources: ${artifact.sources.successful}/${artifact.sources.attempted} successful · Jobs processed: ${artifact.counts.rawJobs} · Validation failures retained: ${artifact.counts.validationFailed}</p>
    ${cards || "<p>No roles met the report selection criteria today.</p>"}
  </main>
</body>
</html>
`
}

export function renderText(artifact: PipelineArtifact, jobs: PipelineJob[], generatedAt: Date): string {
  const lines = [
    `Daily Job Search Report - ${ymd(generatedAt)}`,
    `Visible candidates: ${artifact.counts.finalCandidates}`,
    `Sources: ${artifact.sources.successful}/${artifact.sources.attempted} successful`,
    "",
  ]
  jobs.forEach((job, index) => {
    lines.push(`${index + 1}. ${job.title} at ${job.company} - ${score(job)}`)
    lines.push(`   ${jobUrl(job)}`)
    lines.push(`   Good pick: ${(job.pipeline?.match?.strengths ?? []).join("; ") || "review manually"}`)
    lines.push(`   Gaps/checks: ${missing(job).join("; ") || "none detected"}`)
    lines.push("")
  })
  if (jobs.length === 0) lines.push("No roles met the report selection criteria today.")
  return lines.join("\n")
}

async function readBase64(path: string): Promise<string> {
  const data = await readFile(path)
  return data.toString("base64").replace(/.{1,76}/g, "$&\n").trim()
}

export async function buildEml(params: {
  to: string
  from: string
  subject: string
  html: string
  text: string
  attachments: Array<{ path: string; filename?: string; contentType: string }>
}): Promise<string> {
  const mixed = `mixed-${randomUUID()}`
  const alt = `alt-${randomUUID()}`
  const attachmentParts = []
  for (const attachment of params.attachments) {
    attachmentParts.push([
      `--${mixed}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename ?? basename(attachment.path)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.filename ?? basename(attachment.path)}"`,
      "",
      await readBase64(attachment.path),
    ].join("\r\n"))
  }
  return [
    `To: ${params.to}`,
    `From: ${params.from}`,
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    params.text,
    `--${alt}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    params.html,
    `--${alt}--`,
    ...attachmentParts,
    `--${mixed}--`,
    "",
  ].join("\r\n")
}

async function sendWithSendmail(path: string, sendmailPath: string): Promise<{ sent: boolean; error?: string }> {
  if (!existsSync(sendmailPath)) return { sent: false, error: `${sendmailPath} does not exist` }
  const input = await readFile(path)
  return await new Promise((resolvePromise) => {
    const child = spawn(sendmailPath, ["-t"], { cwd: process.cwd() })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", (error) => resolvePromise({ sent: false, error: String(error) }))
    child.on("close", (code) => resolvePromise({ sent: code === 0, error: code === 0 ? undefined : stderr || `sendmail exited ${code}` }))
    child.stdin.end(input)
  })
}

function smtpOptionsFromEnv(): SmtpOptions | null {
  const host = process.env.DAILY_REPORT_SMTP_HOST
  const user = process.env.DAILY_REPORT_SMTP_USER
  const password = process.env.DAILY_REPORT_SMTP_PASSWORD
  if (!host || !user || !password) return null
  return {
    host,
    port: Number(process.env.DAILY_REPORT_SMTP_PORT || "465"),
    user,
    password,
    secure: process.env.DAILY_REPORT_SMTP_SECURE !== "false",
  }
}

async function sendWithSmtp(emlPath: string, smtp: SmtpOptions): Promise<{ sent: boolean; error?: string }> {
  const message = await readFile(emlPath, "utf8")
  const socket = await new Promise<Socket | TLSSocket>((resolvePromise, reject) => {
    const connectFn = smtp.secure === false ? netConnect : tlsConnect
    const conn = connectFn({ host: smtp.host, port: smtp.port }, () => resolvePromise(conn))
    const timer = setTimeout(() => {
      conn.destroy()
      reject(new Error(`SMTP connection to ${smtp.host}:${smtp.port} timed out`))
    }, 15_000)
    conn.once("connect", () => clearTimeout(timer))
    conn.once("secureConnect", () => clearTimeout(timer))
    conn.once("error", reject)
  })
  socket.setTimeout(15_000, () => socket.destroy(new Error("SMTP socket timed out waiting for server response")))
  socket.setEncoding("utf8")
  let buffer = ""
  const readLine = async (): Promise<string> => await new Promise((resolvePromise, reject) => {
    const onData = (chunk: string) => {
      buffer += chunk
      const match = buffer.match(/^(.*?\r?\n)/)
      if (!match) return
      socket.off("data", onData)
      socket.off("error", reject)
      const line = match[1]
      buffer = buffer.slice(line.length)
      resolvePromise(line.trimEnd())
    }
    socket.on("data", onData)
    socket.once("error", reject)
  })
  const readResponse = async (): Promise<string> => {
    const lines = [await readLine()]
    while (/^\d{3}-/.test(lines.at(-1) ?? "")) lines.push(await readLine())
    return lines.join("\n")
  }
  const command = async (line: string, expected: RegExp): Promise<string> => {
    socket.write(`${line}\r\n`)
    const response = await readResponse()
    if (!expected.test(response)) throw new Error(`${line.split(" ")[0]} failed: ${response}`)
    return response
  }
  try {
    await readResponse()
    await command(`EHLO localhost`, /^250[\s-]/)
    if (smtp.secure === false) {
      await command("STARTTLS", /^220[\s-]/)
      throw new Error("STARTTLS mode is not implemented; use port 465 with DAILY_REPORT_SMTP_SECURE=true")
    }
    const auth = Buffer.from(`\0${smtp.user}\0${smtp.password}`, "utf8").toString("base64")
    await command(`AUTH PLAIN ${auth}`, /^235[\s-]/)
    await command(`MAIL FROM:<${smtp.user}>`, /^250[\s-]/)
    const toHeader = message.match(/^To:\s*(.+)$/mi)?.[1]?.trim()
    const recipients = (toHeader ? toHeader.split(/,\s*/) : []).map((item) => item.match(/<([^>]+)>/)?.[1] ?? item).filter(Boolean)
    for (const recipient of recipients) await command(`RCPT TO:<${recipient}>`, /^(250|251)[\s-]/)
    await command("DATA", /^354[\s-]/)
    socket.write(`${message.replace(/\r?\n\./g, "\n..")}\r\n.\r\n`)
    const dataResponse = await readResponse()
    if (!/^250[\s-]/.test(dataResponse)) throw new Error(`DATA failed: ${dataResponse}`)
    await command("QUIT", /^221[\s-]/)
    socket.end()
    return { sent: true }
  } catch (error) {
    socket.destroy()
    return { sent: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function sendWithCurlSmtp(emlPath: string, smtp: SmtpOptions, to: string, from: string): Promise<{ sent: boolean; error?: string }> {
  const config = [
    `url = "smtps://${smtp.host}:${smtp.port}"`,
    "ssl-reqd",
    "silent",
    "show-error",
    `mail-from = "${from}"`,
    `mail-rcpt = "${to}"`,
    `user = "${smtp.user}:${smtp.password}"`,
    `upload-file = "${emlPath}"`,
  ].join("\n")
  return await new Promise((resolvePromise) => {
    const child = spawn("curl", ["--config", "-"], { cwd: process.cwd() })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", (error) => resolvePromise({ sent: false, error: String(error) }))
    child.on("close", (code) => resolvePromise({ sent: code === 0, error: code === 0 ? undefined : stderr || `curl exited ${code}` }))
    child.stdin.end(config)
  })
}

export async function sendEmailDraft(emlPath: string, options: { smtp?: SmtpOptions; sendmailPath?: string } = {}): Promise<{ sent: boolean; error?: string }> {
  const smtp = options.smtp ?? smtpOptionsFromEnv()
  if (!smtp) return await sendWithSendmail(emlPath, options.sendmailPath ?? process.env.DAILY_REPORT_SENDMAIL ?? "/usr/sbin/sendmail")
  const message = await readFile(emlPath, "utf8")
  const to = message.match(/^To:\s*(.+)$/mi)?.[1]?.trim()
  const from = message.match(/^From:\s*(.+)$/mi)?.[1]?.trim() ?? smtp.user
  if (to && process.env.DAILY_REPORT_SMTP_USE_CURL !== "false") {
    const curlResult = await sendWithCurlSmtp(emlPath, smtp, to, from)
    if (curlResult.sent || !/ENOENT|not found/i.test(curlResult.error ?? "")) return curlResult
  }
  return await sendWithSmtp(emlPath, smtp)
}

export function acquisitionHealth(artifact: PipelineArtifact): "healthy" | "degraded" | "failed" {
  const successful = (artifact.sources.successful > 0 || artifact.sources.details.some((source) => source.jobsReturned > 0)) || artifact.ats.successful > 0
  if (!successful) return "failed"
  return artifact.sources.failed || artifact.ats.failed ? "degraded" : "healthy"
}

export function retainUnansweredJobs(jobs: PipelineJob[], now: Date): PipelineJob[] {
  return jobs.filter((job) => {
    const discovered = String((job.metadata as Record<string, unknown> | undefined)?.lastDiscoveredAt ?? "")
    const age = now.getTime() - Date.parse(discovered)
    return job.sourceType !== "ats" && job.validation?.status !== "expired" && Number.isFinite(age) && age >= 0 && age <= 30 * 86400_000
  }).slice(0, 500)
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
  await rename(temporary, path)
}

export async function createDailyReport(options: DailyReportOptions = {}): Promise<DailyReportResult> {
  const now = options.now ?? new Date()
  const userId = options.userId?.trim() || process.env.AI_JOB_SEARCH_USER_ID?.trim()
  if (!userId) throw new Error("Daily report requires --user-id or AI_JOB_SEARCH_USER_ID to resolve the active SearchProfile")
  const discoveryStore = options.profileLoader ? undefined : await createSupabaseDiscoveryStoreFromEnv()
  const profile = await (options.profileLoader ?? (async (id: string) => discoveryStore!.getActiveSearchProfile(id)))(userId)
  if (profile.user_id !== userId) throw new Error("Resolved SearchProfile does not belong to the requested user")
  const suppressionChecker = options.suppressionChecker ?? (discoveryStore ? async (job: PipelineJob) => {
    const normalized = normalizeDiscoveredJob(job, String(job.source ?? "unknown"))
    return normalized ? await discoveryStore.isSuppressed({ userId, job: normalized }) : false
  } : undefined)
  const threshold = options.threshold ?? Number(process.env.DAILY_REPORT_SCORE_THRESHOLD || profile.min_fit_score || DEFAULT_THRESHOLD)
  const top = options.top ?? Number(process.env.DAILY_REPORT_TOP || DEFAULT_TOP)
  const outDir = resolve(options.outDir ?? process.env.DAILY_REPORT_DIR ?? `reports/daily/${ymd(now)}`)
  await mkdir(outDir, { recursive: true })
  const shortlistPath = resolve(options.shortlistPath ?? "job_scraper/daily_shortlist.json")
  let previous: PipelineJob[] = []
  try { previous = JSON.parse(await readFile(shortlistPath, "utf8")) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const retainedJobs = retainUnansweredJobs(previous, now)
  const pipeline = await (options.pipelineRunner ?? runJobPipeline)({
    retainedJobs,
    searchProfile: profile,
    suppressionChecker,
    discoveryQueries: buildSearchQueries(profile, "broad"),
    candidateProfilePath: options.candidateProfilePath ?? ".claude/skills/job-application-assistant/01-candidate-profile.md",
    source: options.source,
    limit: options.limit,
    includeUnvalidated: options.includeUnvalidated,
    disableEnrichment: options.disableEnrichment,
    artifactDir: resolve(outDir, "artifacts"),
    now,
  })
  const health = acquisitionHealth(pipeline.artifact)
  if (health === "failed") throw new Error(`Acquisition failed across all sources; prior shortlist preserved. Diagnostic artifact: ${pipeline.artifactPath}`)
  const acquired = pipeline.artifact.jobs.map((job) => ({ ...job, metadata: { ...job.metadata, lastDiscoveredAt: (job.metadata as Record<string, unknown>)?.lastDiscoveredAt ?? now.toISOString() } }))
  await writeJsonAtomic(shortlistPath, retainUnansweredJobs(acquired, now))
  const trackerKeys = await loadExcludedTrackerKeys(options.trackerPath ?? DEFAULT_TRACKER)
  const topJobs = selectTopJobs(pipeline.artifact, threshold, top, trackerKeys)
  const selectedKeys = new Set(topJobs.map(uniqueKey))
  const selectedDuplicateUrls = new Set(topJobs.flatMap((job) => Array.isArray(job.metadata?.sourceUrls) ? job.metadata.sourceUrls as string[] : []))
  await writeJsonAtomic(resolve(outDir, "selection-decisions.json"), {
    runId: pipeline.artifact.runId,
    userId,
    searchProfileId: profile.id,
    stage: pipeline.artifact.cohort?.stage ?? "source_validation_enrichment_search_profile_eligibility",
    processedAt: pipeline.artifact.cohort?.timestamp ?? pipeline.artifact.completedAt,
    processedJobIds: pipeline.artifact.cohort?.processedJobIds ?? pipeline.artifact.jobs.map(uniqueKey),
    health, sourceCoverage: pipeline.artifact.sourceCoverage,
    shortlistGroups: topJobs.map((job) => ({ key: uniqueKey(job), company: job.company, title: job.title, sourceUrls: job.metadata?.sourceUrls ?? [jobUrl(job)] })),
    jobs: pipeline.artifact.jobs.map((job) => ({
      key: uniqueKey(job), company: job.company, title: job.title, url: jobUrl(job),
      score: score(job),
      eligibility: job.pipeline?.searchEligibility, enrichment: (job.metadata as Record<string, unknown>)?.detailEnrichment,
      decision: job.pipeline?.excluded ? "pipeline_excluded" : isTrackedJob(job, trackerKeys) ? "tracker_excluded" : dailyReportExclusionReason(job) ?? (selectedKeys.has(uniqueKey(job)) ? "selected" : selectedDuplicateUrls.has(normalizeCacheUrl(jobUrl(job))) ? "duplicate_shortlist" : score(job) < threshold ? "below_threshold" : "report_limit"),
    })),
  })
  const generatedCvs = await generateCvs(topJobs, outDir, options.compileCv ?? process.env.DAILY_REPORT_COMPILE_CV !== "false", options.masterCvPath)
  const html = renderHtml(pipeline.artifact, topJobs, generatedCvs, now)
  const text = renderText(pipeline.artifact, topJobs, now)
  const htmlPath = resolve(outDir, "daily-job-report.html")
  const textPath = resolve(outDir, "daily-job-report.txt")
  const emlPath = resolve(outDir, "daily-job-report.eml")
  await writeFile(htmlPath, html, "utf8")
  await writeFile(textPath, text, "utf8")
  const recipient = options.recipient ?? process.env.DAILY_REPORT_EMAIL_TO ?? "your.email@example.com"
  const sender = options.sender ?? process.env.DAILY_REPORT_EMAIL_FROM ?? recipient
  const subject = options.subject ?? `Daily job search report - ${ymd(now)}`
  const attachments = generatedCvs.map((cv) => cv.pdfPath
    ? { path: cv.pdfPath, contentType: "application/pdf" }
    : { path: cv.texPath, contentType: "application/x-tex" })
  const eml = await buildEml({ to: recipient, from: sender, subject, html, text, attachments })
  await writeFile(emlPath, eml, "utf8")
  let sent = false
  let sendError: string | undefined
  if (options.send ?? process.env.DAILY_REPORT_SEND === "true") {
    await writeJsonAtomic(resolve("job_scraper/pending-daily-email.json"), { date: ymd(now), emlPath })
    const result = await sendEmailDraft(emlPath, { smtp: options.smtp, sendmailPath: options.sendmailPath })
    sent = result.sent
    sendError = result.error
    if (sent) await unlink(resolve("job_scraper/pending-daily-email.json")).catch(() => {})
  }
  return { artifact: pipeline.artifact, artifactPath: pipeline.artifactPath, outDir, htmlPath, textPath, emlPath, generatedCvs, topJobs, sent, sendError }
}

function parseArgs(argv: string[]): Record<string, string | boolean> & { _: string[] } {
  const parsed: Record<string, string | boolean> & { _: [] } = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      parsed._.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (["threshold", "top", "out-dir", "recipient", "sender", "source", "limit", "sendmail", "user-id"].includes(key)) parsed[key] = argv[++i]
    else parsed[key] = true
  }
  return parsed
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args._[0] === "send-eml") {
    const emlPath = args._[1]
    if (!emlPath) {
      process.stderr.write("usage: bun run tools/daily_job_report.ts send-eml <path-to-eml>\n")
      return 2
    }
    const result = await sendEmailDraft(emlPath, { sendmailPath: typeof args.sendmail === "string" ? args.sendmail : undefined })
    process.stdout.write(`Sent: ${result.sent}${result.error ? ` (${result.error})` : ""}\n`)
    return result.sent ? 0 : 1
  }
  if (args._[0] !== "run") {
    process.stderr.write("usage: bun run tools/daily_job_report.ts run --user-id <uuid> [--threshold 80] [--top 10] [--out-dir path] [--recipient email] [--sender email] [--compile-cv] [--send]\n       bun run tools/daily_job_report.ts send-eml <path-to-eml>\n")
    return 2
  }
  try {
    const pending = JSON.parse(await readFile("job_scraper/pending-daily-email.json", "utf8"))
    if (pending.date === ymd(new Date()) && (Boolean(args.send) || process.env.DAILY_REPORT_SEND === "true")) {
      const sent = await sendEmailDraft(pending.emlPath)
      if (sent.sent) await unlink("job_scraper/pending-daily-email.json")
      process.stdout.write(`Pending email retry: ${sent.sent ? "sent" : sent.error}\n`)
      return sent.sent ? 0 : 1
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const result = await createDailyReport({
    threshold: typeof args.threshold === "string" ? Number(args.threshold) : undefined,
    top: typeof args.top === "string" ? Number(args.top) : undefined,
    outDir: typeof args["out-dir"] === "string" ? args["out-dir"] : undefined,
    recipient: typeof args.recipient === "string" ? args.recipient : undefined,
    sender: typeof args.sender === "string" ? args.sender : undefined,
    userId: typeof args["user-id"] === "string" ? args["user-id"] : undefined,
    source: typeof args.source === "string" ? args.source : undefined,
    limit: typeof args.limit === "string" ? Number(args.limit) : undefined,
    compileCv: Boolean(args["compile-cv"]) || process.env.DAILY_REPORT_COMPILE_CV === "true",
    send: Boolean(args.send) || process.env.DAILY_REPORT_SEND === "true",
    sendmailPath: typeof args.sendmail === "string" ? args.sendmail : undefined,
  })
  process.stdout.write([
    `Report: ${result.htmlPath}`,
    `Email draft: ${result.emlPath}`,
    `Top jobs: ${result.topJobs.length}`,
    `CVs: ${result.generatedCvs.length}`,
    `Sent: ${result.sent}${result.sendError ? ` (${result.sendError})` : ""}`,
  ].join("\n") + "\n")
  return result.sendError && (Boolean(args.send) || process.env.DAILY_REPORT_SEND === "true") ? 1 : 0
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exit(1)
  })
}
