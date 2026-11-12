import { describe, expect, test } from "bun:test"
import { makeCliSourceRunnerWithCommand } from "../tools/job_pipeline"

describe("discovery query provenance", () => {
  test("retains every query that returned the same deduplicated source job", async () => {
    const commands: string[][] = []
    const runner = makeCliSourceRunnerWithCommand("fixture-source", (query) => ["search", query])

    const result = await runner({
      discoveryQueries: ["Security Lead", "Cloud Security"],
      commandRunner: async (_command, args) => {
        commands.push(args)
        return {
          code: 0,
          stdout: JSON.stringify({ results: [{ id: "job-1", title: "Security Lead", company: "Example", url: "https://example.test/jobs/1" }] }),
          stderr: "",
          timedOut: false,
        }
      },
    })

    expect(commands).toEqual([["search", "Security Lead"], ["search", "Cloud Security"]])
    expect(result.jobs).toHaveLength(1)
    expect((result.jobs[0].metadata as Record<string, unknown>).acquisitionQueries).toEqual(["Security Lead", "Cloud Security"])
  })
})
