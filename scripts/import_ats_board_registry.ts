import { DEFAULT_REGISTRY_PATH, JsonCompanyRegistry } from "../tools/company_registry"
import { importVerifiedAtsBoards, SupabaseAtsBoardRepository } from "../tools/ats_board_registry"

function parseArgs(args: string[]): { apply: boolean; registryPath: string } {
  let apply = false
  let registryPath = DEFAULT_REGISTRY_PATH
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true
    else if (args[i] === "--registry" && args[i + 1]) registryPath = args[++i]
    else throw new Error("Usage: bun run scripts/import_ats_board_registry.ts [--registry PATH] [--apply]")
  }
  return { apply, registryPath }
}

async function main(): Promise<number> {
  const { apply, registryPath } = parseArgs(process.argv.slice(2))
  const url = process.env.SUPABASE_URL?.trim()
  const secret = process.env.SUPABASE_SECRET_KEY?.trim()
  if (!url || !secret) throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY to inspect the durable registry. No import was performed.")

  const registry = await JsonCompanyRegistry.load(registryPath)
  const repository = new SupabaseAtsBoardRepository(url, secret)
  const result = await importVerifiedAtsBoards({ companies: registry.listCompanies(), repository, apply })
  process.stdout.write(`${JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    localCompanies: registry.listCompanies().length,
    verifiedSourceMappings: result.verifiedSourceCount,
    importableMappings: result.rows.length,
    ignoredUnverifiedMappings: result.ignoredUnverifiedCount,
    invalidVerifiedMappings: result.invalidVerifiedCount,
    duplicates: result.duplicateCount,
    conflicts: result.conflicts,
    existingDurableBoards: result.existingCount,
    resultingDurableBoards: result.afterCount,
    imported: result.importedCount,
    writesPerformed: result.importedCount,
  }, null, 2)}\n`)
  return result.conflicts.length ? 2 : 0
}

if (import.meta.main) main().then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
