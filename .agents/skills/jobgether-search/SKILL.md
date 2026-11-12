---
name: jobgether-search
version: 1.0.0
description: >
  Search live remote and hybrid job listings from Jobgether's public Job Search
  API. Use for Jobgether, remote jobs, remote Europe jobs, application security,
  product security, security engineer, cybersecurity, vulnerability management,
  and security management roles.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/jobgether-search/cli/src/cli.ts *)
---

# Jobgether Search Skill

Search Jobgether's documented public `/api/v1/jobs` endpoint. The CLI keeps
Jobgether listing URLs, uses server-side keyword/location/date sorting where possible,
and applies local filters for the shared portal contract.

## Commands

```bash
bun run .agents/skills/jobgether-search/cli/src/cli.ts search [flags]
bun run .agents/skills/jobgether-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Search flags:
- `--query <text>` / `-q <text>` - maps to Jobgether `keyword`.
- `--location <text>` / `-l <text>` - maps common values like `Europe`, `Austria`,
  `Germany`, `UK`, and `Worldwide` to Jobgether location slugs, then verifies client-side.
- `--jobage <days>` - client-side publication date filter.
- `--page <n>` - maps to Jobgether `page`.
- `--limit <n>` / `-n <n>` - maps to Jobgether `limit`, capped by the API at 25.
- `--format json|table|plain` - default `json`.

Examples:

```bash
bun run .agents/skills/jobgether-search/cli/src/cli.ts search -q "application security" -l Europe --jobage 14 --limit 20 --format table
bun run .agents/skills/jobgether-search/cli/src/cli.ts search -q "product security" -l Austria --format json
bun run .agents/skills/jobgether-search/cli/src/cli.ts search -q "security manager" -l EMEA --limit 10 --format plain
bun run .agents/skills/jobgether-search/cli/src/cli.ts detail 65f1a2b3c4d5e6f7a8b9c0d1 --format json
```

## Notes

- Data source: `https://jobgether.com/api/v1/jobs`.
- Jobgether caps results at 25 per page and page at 10.
- All jobs are remote-friendly by default; the CLI requests `remoteType=full-remote`.
- `detail` resolves IDs/URLs through the same public search API because the API
  response carries the normalized listing fields.
- Keep request volume reasonable; Jobgether documents edge rate limits and no API key.
