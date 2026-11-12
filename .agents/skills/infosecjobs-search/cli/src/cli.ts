#!/usr/bin/env bun
import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail } from "./commands/detail.js"
import { writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [key: string]: string | boolean | string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  const alias: Record<string, string> = { q: "query", l: "location", n: "limit" }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("--") || arg.startsWith("-")) {
      const key = alias[arg.replace(/^-+/, "")] ?? arg.replace(/^-+/, "")
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) flags[key] = true
      else {
        flags[key] = next
        i++
      }
    } else flags._.push(arg)
  }
  return flags
}

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "location", "jobage", "page", "limit", "format", "help", "h"]),
  detail: new Set(["format", "help", "h"]),
}

const HELP = `infosecjobs-cli - search InfoSec Job Board jobs

USAGE
  bun run src/cli.ts search [--query <text>] [--location <text>] [--jobage <days>] [--page <n>] [--limit <n>] [--format json|table|plain]
  bun run src/cli.ts detail <id|url> [--format json|plain]
`

function parsePositiveInt(name: string, raw: string | boolean | string[] | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(value) || value < 1) throw new Error(`--${name} must be a positive number`)
  return value
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const cmd = flags._[0]
  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }
  const known = KNOWN_FLAGS[cmd]
  if (known) {
    for (const key of Object.keys(flags)) {
      if (key !== "_" && !known.has(key)) {
        writeError(`unknown flag --${key} for '${cmd}'`, "UNKNOWN_FLAG")
        return 1
      }
    }
  }
  const format = String(flags.format ?? "json")
  if (!["json", "table", "plain"].includes(format)) {
    writeError(`unsupported format "${format}"`, "BAD_ARG")
    return 1
  }
  if (cmd === "search") {
    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query : undefined,
      location: typeof flags.location === "string" ? flags.location : undefined,
      jobage: parsePositiveInt("jobage", flags.jobage),
      page: parsePositiveInt("page", flags.page) ?? 1,
      limit: parsePositiveInt("limit", flags.limit),
      format: format as SearchOpts["format"],
    }
    return runSearch(opts)
  }
  if (cmd === "detail") {
    const id = flags._[1]
    if (!id) {
      writeError("detail requires an <id|url>", "NO_ID")
      return 1
    }
    return runDetail({ id, format: format === "plain" ? "plain" : "json" })
  }
  writeError(`Unknown command "${cmd}"`, "BAD_CMD")
  return 1
}

main().then((code) => process.exit(code)).catch((error) => {
  writeError(error instanceof Error ? error.message : String(error), "INTERNAL_ERROR")
  process.exit(1)
})
