import { describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { preserveConfirmedActiveLifecycle, writeEvidenceBatchArtifact } from "../tools/process_pending_job_evidence"

describe("bounded evidence run traceability", () => {
  test("transient verification does not overwrite a previously active lifecycle", () => {
    expect(preserveConfirmedActiveLifecycle("active", "validation_failed")).toBe(true)
    expect(preserveConfirmedActiveLifecycle("active", "unknown")).toBe(true)
    expect(preserveConfirmedActiveLifecycle("active", "uncertain")).toBe(true)
    expect(preserveConfirmedActiveLifecycle("active", "expired")).toBe(false)
    expect(preserveConfirmedActiveLifecycle("active", "active")).toBe(false)
    expect(preserveConfirmedActiveLifecycle("validation_failed", "unknown")).toBe(false)
  })

  test("artifact preserves exact run, owner/profile, cohort, timestamp, and stage", async () => {
    const directory = `/tmp/evidence-batch-${Date.now()}`
    const input = {
      runId: "run-123",
      userId: "user-123",
      searchProfileId: 17,
      jobIds: [2, 8, 13],
      timestamp: "2026-10-05T08:00:00.000Z",
      stage: "liveness_and_jd_hydration",
      result: { actionable: 2 },
    }
    const path = await writeEvidenceBatchArtifact(input, directory)
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(input)
    await rm(directory, { recursive: true, force: true })
  })
})
