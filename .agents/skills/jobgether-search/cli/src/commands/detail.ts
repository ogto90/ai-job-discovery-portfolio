import { API_URL, extractId, fetchJson, keywordFromDetailInput, parseApi, validateDetailInput, type JobResult } from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

function sameJob(job: JobResult, id: string): boolean {
  return job.id === id || job.url === id || job.url.includes(id)
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const validated = validateDetailInput(opts.id)
  const id = extractId(validated)
  const keyword = keywordFromDetailInput(validated)
  let job: JobResult | undefined
  for (const term of [keyword, undefined]) {
    for (let page = 1; page <= 10 && !job; page++) {
      const url = new URL(API_URL)
      if (term) url.searchParams.set("keyword", term)
      url.searchParams.set("sort", "date")
      url.searchParams.set("page", String(page))
      url.searchParams.set("limit", "25")
      job = parseApi(await fetchJson(url.toString())).jobs.find((item) => sameJob(item, id))
    }
    if (job) break
  }
  if (!job) return 1
  if (opts.format === "json") process.stdout.write(JSON.stringify(job, null, 2) + "\n")
  else process.stdout.write(`${job.title}\n${job.company ?? "Unknown"}\n${job.location ?? "Remote"} · ${job.date ?? "date unknown"}\n${job.url}\n\n${job.description ?? ""}\n`)
  return 0
}
