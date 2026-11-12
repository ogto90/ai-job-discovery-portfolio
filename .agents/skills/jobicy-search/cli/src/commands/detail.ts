import { fetchJson, parseApi, validateDetailInput, type JobResult } from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

function formatPlain(job: JobResult): string {
  return `${job.title} - ${job.company ?? "Unknown"}\n${job.location ?? "Remote"} · ${job.date ?? "date unknown"}\n${job.url}\n\n${job.description ?? job.excerpt ?? ""}`.trim()
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const input = validateDetailInput(opts.id)
  const data = await fetchJson("https://jobicy.com/api/v2/remote-jobs?count=200")
  const jobs = parseApi(data)
  const job = jobs.find((item) => item.id === input || item.url === input)
  if (!job) return 1
  if (opts.format === "json") process.stdout.write(JSON.stringify(job, null, 2) + "\n")
  else process.stdout.write(formatPlain(job) + "\n")
  return 0
}
