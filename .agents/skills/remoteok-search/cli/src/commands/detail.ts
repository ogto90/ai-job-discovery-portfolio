import { API_URL, jsonFetch, parseFeed, type JobResult } from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

function sameJob(job: JobResult, id: string): boolean {
  return job.id === id || job.url === id || job.url.includes(id)
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const job = parseFeed(await jsonFetch(API_URL)).find((item) => sameJob(item, opts.id))
  if (!job) return 1
  if (opts.format === "json") process.stdout.write(JSON.stringify(job, null, 2) + "\n")
  else process.stdout.write(`${job.title}\n${job.company ?? "Unknown"}\n${job.location ?? "Remote"} · ${job.date ?? "date unknown"}\n${job.url}\n\n${job.description ?? ""}\n`)
  return 0
}
