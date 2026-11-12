#!/usr/bin/env bun
import { disabledMessage, writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [key: string]: string | boolean | string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("-")) {
      const key = arg.replace(/^-+/, "")
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

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const cmd = flags._[0]
  if (!cmd || flags.help || flags.h) {
    process.stdout.write(`cybersecurityjobsite-cli - disabled portal placeholder\n\nUSAGE\n  bun run src/cli.ts search [flags]\n  bun run src/cli.ts detail <id|url> [--format json|plain]\n`)
    return cmd ? 0 : 1
  }
  if (cmd === "search" || cmd === "detail") {
    writeError(disabledMessage())
    return 1
  }
  writeError(`Unknown command "${cmd}"`, "BAD_CMD")
  return 1
}

main().then((code) => process.exit(code)).catch((error) => {
  writeError(error instanceof Error ? error.message : String(error), "INTERNAL_ERROR")
  process.exit(1)
})
