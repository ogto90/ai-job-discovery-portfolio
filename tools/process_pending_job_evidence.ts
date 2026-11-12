/** One bounded liveness + JD-hydration pass for explicitly selected stored jobs. */

import { discoveryKey, evaluateFinalJobEligibility, normalizeDiscoveredJob, createSupabaseDiscoveryStoreFromEnv, verifyAndHydrateDiscoveredJobs } from "./generic_discovery"
import type { NormalizedJob } from "./job_availability_validator"
import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"

export async function writeEvidenceBatchArtifact(input: {
  runId: string
  userId: string
  searchProfileId: number
  jobIds: number[]
  timestamp: string
  stage: string
  result: unknown
}, directory = ".diagnostics/evidence-batches"): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = `${directory}/${input.runId}.json`
  await writeFile(path, `${JSON.stringify(input, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  return path
}

export function preserveConfirmedActiveLifecycle(
  previousStatus: unknown,
  validationStatus: unknown,
): boolean {
  return previousStatus === "active"
    && ["validation_failed", "unknown", "uncertain"].includes(String(validationStatus))
}

function parseIds(argv: string[]): number[] {
  const index = argv.indexOf("--ids")
  if (index < 0 || !argv[index + 1]) throw new Error("usage: bun run tools/process_pending_job_evidence.ts --ids 1,2,3")
  const ids = argv[index + 1].split(",").map((value) => Number(value.trim()))
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length || ids.length > 30) {
    throw new Error("--ids must contain 1 to 30 unique positive job IDs")
  }
  return ids
}

function parseUserId(argv: string[]): string {
  const index = argv.indexOf("--user-id")
  const value = index >= 0 ? argv[index + 1] : process.env.AI_JOB_SEARCH_USER_ID
  if (!value?.trim()) throw new Error("usage: bun run tools/process_pending_job_evidence.ts --user-id <current-user-id> --ids 1,2,3")
  return value.trim()
}

async function main(): Promise<void> {
  const ids = parseIds(process.argv.slice(2))
  const userId = parseUserId(process.argv.slice(2))
  const runId = randomUUID()
  const timestamp = new Date().toISOString()
  const store = await createSupabaseDiscoveryStoreFromEnv()
  const profile = await store.getActiveSearchProfile(userId)
  const rows = await store.loadJobsByIds(ids)
  const byId = new Map(rows.map((row) => [Number(row.id), row]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) throw new Error(`Selected job IDs were not found: ${missing.join(", ")}`)
  const foreignManual = rows.filter((row) => row.manual_owner_user_id && row.manual_owner_user_id !== userId)
  if (foreignManual.length) throw new Error("Selected jobs include a manual listing owned by another user")

  const selected = ids.map((id) => byId.get(id)!)
  const normalizedRows = selected.map((row) => ({ row, job: normalizeDiscoveredJob({
    id: row.source_job_id ?? row.id,
    source: row.source,
    sourceJobId: row.source_job_id,
    sourceUrl: row.source_url,
    applicationUrl: row.application_url,
    company: row.company,
    title: row.title,
    location: row.location,
    remoteScope: row.remote_scope,
    employmentType: row.employment_type,
    description: row.description,
    descriptionKind: row.description_kind,
    postedAt: row.posted_at,
  } as NormalizedJob, String(row.source))! }))
  const jobs = normalizedRows.map(({ job }) => job)

  if (jobs.length !== selected.length) throw new Error("One or more selected database rows could not be normalized; no writes made")
  const result = await verifyAndHydrateDiscoveredJobs(jobs, profile, { forceRevalidate: true })
  const rowsByJobKey = new Map(normalizedRows.map(({ row, job }) => [discoveryKey(job), row]))

  for (const job of result.jobs) {
    const row = rowsByJobKey.get(discoveryKey(job))
    if (!row) throw new Error(`Resolved job lost its source identity; stopping before remaining writes`)
    const preserveLifecycle = preserveConfirmedActiveLifecycle(row.availability_status, job.validation?.status)
    const persisted = await store.upsertJob({
      job: preserveLifecycle ? { ...job, validation: undefined } : job,
      existing: row,
      now: String(row.last_seen_at ?? row.first_seen_at ?? new Date().toISOString()),
    })
    if (persisted.identityConflict || persisted.id === null) {
      throw new Error(`Job ${row.id} has a physical identity conflict; evidence was not attached to a canonical job.`)
    }
  }

  const report = result.jobs.map((job) => {
    const row = rowsByJobKey.get(discoveryKey(job))
    const eligibility = evaluateFinalJobEligibility(job, profile)
    return {
      id: row?.id,
      company: job.company,
      title: job.title,
      availability: job.validation?.status ?? String(row?.availability_status ?? "unknown"),
      persisted_availability: preserveConfirmedActiveLifecycle(row?.availability_status, job.validation?.status)
        ? row?.availability_status
        : job.validation?.status ?? row?.availability_status ?? "unknown",
      prior_active_preserved: preserveConfirmedActiveLifecycle(row?.availability_status, job.validation?.status),
      role: result.roleClassifications.get(discoveryKey(job)) ?? "unclassified",
      eligibility: {
        role: result.roleClassifications.get(discoveryKey(job)) ?? "unclassified",
        actionable: eligibility.actionable,
        location: eligibility.location,
        language: eligibility.language,
        employment_type: eligibility.employmentType,
        seniority: eligibility.seniority,
        reason: eligibility.reason,
      },
      description_kind: job.descriptionKind,
    }
  })
  const artifactPath = await writeEvidenceBatchArtifact({ runId, userId, searchProfileId: profile.id, jobIds: ids, timestamp, stage: "liveness_and_jd_hydration", result: { stats: result.stats, jobs: report } })
  process.stdout.write(`${JSON.stringify({ runId, artifactPath, timestamp, stage: "liveness_and_jd_hydration", jobIds: ids, stats: result.stats, jobs: report }, null, 2)}\n`)
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
