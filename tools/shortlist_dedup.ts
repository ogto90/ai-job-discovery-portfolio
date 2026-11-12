import { atsKeyFromJob } from "./ats_job_ingestor"
import { normalizeCacheUrl } from "./job_availability_validator"
import type { PipelineJob } from "./job_pipeline"

function normalized(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}
function urls(job: PipelineJob): string[] {
  return [job.applicationUrl, job.canonicalUrl, job.url].filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url)).map(normalizeCacheUrl)
}
function vacancyUrls(job: PipelineJob): string[] {
  return urls(job).filter((url) => !/^\/(?:jobs|careers|positions|openings)?\/?$/i.test(new URL(url).pathname))
}
function source(job: PipelineJob): string {
  return String(job.portal ?? job.source ?? (urls(job)[0] ? new URL(urls(job)[0]).hostname : "unknown"))
}

// This is presentation grouping, not an irreversible merge of acquisition history.
export function dedupeShortlist(jobs: PipelineJob[]): PipelineJob[] {
  const groups: PipelineJob[][] = []
  for (const job of jobs) {
    const identity = atsKeyFromJob(job)
    const links = vacancyUrls(job)
    const group = groups.find((members) => {
      const ids = members.map(atsKeyFromJob).filter(Boolean)
      if (identity && ids.some((id) => id !== identity)) return false
      if (identity && ids.includes(identity)) return true
      if (members.some((member) => vacancyUrls(member).some((url) => links.includes(url)))) return true
      if (!normalized(job.company) || !normalized(job.title)) return false
      return members.every((member) => normalized(member.company) === normalized(job.company)
        && normalized(member.title) === normalized(job.title)
        && source(member) !== source(job))
    })
    if (group) group.push(job)
    else groups.push([job])
  }
  return groups.map((members) => {
    if (members.length === 1) return members[0]
    const winner = [...members].sort((a, b) => Number(b.sourceType === "ats") - Number(a.sourceType === "ats")
      || Number(b.validation?.status === "active") - Number(a.validation?.status === "active")
      || String(b.description ?? "").length - String(a.description ?? "").length)[0]
    return { ...winner, metadata: { ...winner.metadata, shortlistDuplicates: members.length - 1,
      sourceUrls: [...new Set(members.flatMap(urls))], seenVia: [...new Set(members.map(source))] } }
  })
}
