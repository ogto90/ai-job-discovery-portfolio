import { SEARCH_API_URL, fetchJson, parseApi, sameJob, validateDetailInput, type JobResult } from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

function formatPlain(job: JobResult): string {
  return `${job.title}\n${job.company ?? "Unknown"}\n${job.location ?? "Remote"} · ${job.date ?? "date unknown"}\n${job.url}\n\n${job.description ?? job.excerpt ?? ""}\n`
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = validateDetailInput(opts.id)
  const url = new URL(SEARCH_API_URL)
  url.searchParams.set("q", id)
  const direct = parseApi(await fetchJson(url.toString())).find((job) => sameJob(job, id))
  if (direct) {
    if (opts.format === "json") process.stdout.write(JSON.stringify(direct, null, 2) + "\n")
    else process.stdout.write(formatPlain(direct))
    return 0
  }

  for (let page = 1; page <= 5; page++) {
    const browse = new URL(SEARCH_API_URL)
    browse.searchParams.set("page", String(page))
    const fallback = parseApi(await fetchJson(browse.toString())).find((job) => sameJob(job, id))
    if (fallback) {
      if (opts.format === "json") process.stdout.write(JSON.stringify(fallback, null, 2) + "\n")
      else process.stdout.write(formatPlain(fallback))
      return 0
    }
  }
  return 1
}
