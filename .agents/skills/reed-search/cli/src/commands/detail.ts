import { apiKey, fetchReed, toResult, type JobResult, type ReedDetailJob } from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

function formatPlain(job: JobResult): string {
  return `${job.title} - ${job.company ?? "Unknown"}\n${job.location ?? "Remote"} · ${job.date ?? "date unknown"}\n${job.url}\n\n${job.description ?? job.excerpt ?? ""}`.trim()
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  if (!apiKey()) {
    process.stdout.write(JSON.stringify({ meta: { disabled: true, missingEnv: ["REED_API_KEY"] }, result: null }, null, 2) + "\n")
    return 0
  }
  const data = await fetchReed(`/jobs/${encodeURIComponent(opts.id)}`) as ReedDetailJob
  const job = toResult(data, "full")
  if (!job) return 1
  if (opts.format === "json") process.stdout.write(JSON.stringify(job, null, 2) + "\n")
  else process.stdout.write(formatPlain(job) + "\n")
  return 0
}
