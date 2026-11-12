import { sanitizeTraceUrl, traceRetentionDays } from "../tools/discovery_candidate_tracing"

type TraceRow = {
  observed_at: string
  source: string
  source_query_reference: string | null
  source_job_id: string | null
  ats_provider: string | null
  ats_board_id: string | null
  ats_requisition_id: string | null
  source_url: string | null
  canonical_url: string | null
  candidate_identity: string
  original_title: string | null
  original_company: string | null
  stage: string
  decision: string
  reason_code: string
  reason_codes: string[]
  evidence_status: string
  physical_job_id: number | null
  final_outcome: string
  metadata: Record<string, unknown>
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === "--help" || key === "-h") {
      process.stdout.write("Usage: bun run scripts/query_discovery_candidate_traces.ts --run-id ID|--source NAME|--company TEXT|--url URL|--query-reference HASH|--reason-code CODE|--final-outcome VALUE|--ats-provider NAME|--ats-board ID [--since-days N] [--limit 1..100]\n")
      process.exit(0)
    }
    if (!key.startsWith("--") || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("Each filter requires a value; use --help for usage")
    result[key.slice(2)] = argv[++index]
  }
  return result
}

function safeSearchText(value: string): string {
  return value.replace(/[^a-zA-Z0-9 .&'_-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100)
}

function postgrestQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`
}

export function buildTraceQueryUrl(base: string, filters: Record<string, string>, limit: number): URL {
  const url = new URL(`${base.replace(/\/$/, "")}/rest/v1/discovery_candidate_traces`)
  url.searchParams.set("select", "observed_at,source,source_query_reference,source_job_id,ats_provider,ats_board_id,ats_requisition_id,source_url,canonical_url,candidate_identity,original_title,original_company,stage,decision,reason_code,reason_codes,evidence_status,physical_job_id,final_outcome,metadata")
  url.searchParams.set("order", "observed_at.desc")
  url.searchParams.set("limit", String(limit))
  if (filters["run-id"]) url.searchParams.set("search_run_id", `eq.${filters["run-id"]}`)
  if (filters.source) url.searchParams.set("source", `eq.${safeSearchText(filters.source)}`)
  if (filters["query-reference"]) url.searchParams.set("source_query_reference", `eq.${filters["query-reference"]}`)
  if (filters.company) url.searchParams.set("original_company", `eq.${safeSearchText(filters.company)}`)
  if (filters["reason-code"]) url.searchParams.set("reason_codes", `cs.{${filters["reason-code"]}}`)
  if (filters["final-outcome"]) url.searchParams.set("final_outcome", `eq.${safeSearchText(filters["final-outcome"])}`)
  if (filters["ats-provider"]) url.searchParams.set("ats_provider", `eq.${safeSearchText(filters["ats-provider"])}`)
  if (filters["ats-board"]) url.searchParams.set("ats_board_id", `eq.${safeSearchText(filters["ats-board"])}`)
  if (filters.url) {
    const target = sanitizeTraceUrl(filters.url)
    if (!target) throw new Error("--url must be a valid HTTP(S) URL")
    url.searchParams.set("or", `(source_url.eq.${postgrestQuoted(target)},canonical_url.eq.${postgrestQuoted(target)})`)
  }
  return url
}

function formatRow(row: TraceRow): string[] {
  const lines = [
    `${row.original_title ?? "Untitled role"} at ${row.original_company ?? "Unknown company"}`,
    `  Source: ${row.source}${row.source_job_id ? ` | source ID: ${row.source_job_id}` : ""}`,
    `  Trace: ${row.candidate_identity.slice(0, 16)} | ${row.stage} | ${row.decision} | ${row.reason_code} | evidence: ${row.evidence_status}`,
    ...(row.source_query_reference ? [`  Query reference fingerprint: ${row.source_query_reference}`] : []),
    `  Outcome: ${row.final_outcome}${row.physical_job_id ? ` | physical job: ${row.physical_job_id}` : ""}`,
    `  Observed: ${row.observed_at}`,
  ]
  const ats = row.metadata?.ats
  if (ats && typeof ats === "object") {
    const item = ats as Record<string, unknown>
    lines.push(`  ATS: ${String(item.provider ?? "unknown")} / ${String(item.board_identifier ?? "unknown")} | snapshot complete: ${String(item.snapshot_complete ?? "unknown")} | board: ${String(item.board_status ?? "unknown")}`)
  }
  if (row.source_url) lines.push(`  Listing: ${row.source_url}`)
  const history = Array.isArray(row.metadata?.stage_history) ? row.metadata.stage_history as Array<Record<string, unknown>> : []
  for (const event of history) lines.push(`    ${String(event.stage)}: ${String(event.reasonCode)} (${String(event.decision)})`)
  return lines
}

async function main(): Promise<void> {
  const filters = parseArgs(process.argv.slice(2))
  const allowed = new Set(["run-id", "source", "company", "url", "query-reference", "reason-code", "final-outcome", "ats-provider", "ats-board", "since-days", "limit"])
  if (Object.keys(filters).some((key) => !allowed.has(key))) throw new Error("Unknown filter; use --help for usage")
  const lookupFilters = ["run-id", "source", "company", "url", "query-reference", "reason-code", "final-outcome", "ats-provider", "ats-board"]
  if (!lookupFilters.some((key) => filters[key])) throw new Error("Provide at least one specific lookup filter; use --help for usage")
  if (filters["run-id"] && !/^\d+$/.test(filters["run-id"])) throw new Error("--run-id must be numeric")
  if (filters["reason-code"] && !/^[A-Z][A-Z0-9_]{1,79}$/.test(filters["reason-code"])) throw new Error("--reason-code has an invalid format")
  if (filters["query-reference"] && !/^[a-f0-9]{64}$/.test(filters["query-reference"])) throw new Error("--query-reference must be a 64-character SHA-256 fingerprint")
  const requestedLimit = filters.limit ? Number(filters.limit) : 100
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new Error("--limit must be between 1 and 100")
  const sinceDays = filters["since-days"] ? Number(filters["since-days"]) : traceRetentionDays()
  if (!Number.isSafeInteger(sinceDays) || sinceDays < 1 || sinceDays > 365) throw new Error("--since-days must be between 1 and 365")
  const base = process.env.SUPABASE_URL?.trim()
  const secret = process.env.SUPABASE_SECRET_KEY?.trim()
  if (!base || !secret) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required")
  const queryUrl = buildTraceQueryUrl(base, filters, requestedLimit)
  queryUrl.searchParams.set("observed_at", `gte.${new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()}`)
  if (filters["run-id"]) {
    const summaryUrl = new URL(`${base.replace(/\/$/, "")}/rest/v1/search_runs`)
    summaryUrl.searchParams.set("select", "id,stats")
    summaryUrl.searchParams.set("id", `eq.${filters["run-id"]}`)
    summaryUrl.searchParams.set("limit", "1")
    const summaryResponse = await fetch(summaryUrl, { headers: { apikey: secret, Authorization: `Bearer ${secret}`, Accept: "application/json" } })
    if (summaryResponse.ok) {
      const [run] = await summaryResponse.json() as Array<{ stats?: Record<string, unknown> }>
      if (run?.stats?.candidate_traces) process.stdout.write(`Run trace summary: ${JSON.stringify(run.stats.candidate_traces)}\n`)
    }
  }
  const response = await fetch(queryUrl, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, Accept: "application/json", Prefer: "count=exact" },
  })
  if (!response.ok) throw new Error(`Trace lookup failed with HTTP ${response.status}; verify that the unapplied tracing migration has been deployed to the target environment.`)
  const rows = await response.json() as TraceRow[]
  if (!rows.length) {
    process.stdout.write("NOT OBSERVED IN AVAILABLE DISCOVERY TRACES\n")
    return
  }
  const total = Number(response.headers.get("content-range")?.split("/")[1])
  process.stdout.write(`Returned ${rows.length} of ${Number.isFinite(total) ? total : "an unknown number of"} source observation(s) within ${sinceDays} days (newest first, limit ${requestedLimit}).\n`)
  for (const row of rows) process.stdout.write(`${formatRow(row).join("\n")}\n`)
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Trace lookup failed"}\n`)
  process.exitCode = 1
})
