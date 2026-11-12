---
name: infosecjobs-search
version: 1.0.0
description: >
  Search public cybersecurity listings from InfoSec Job Board, especially remote
  AppSec, product security, security engineering, GRC, vulnerability management,
  incident response, and security-management roles.
context: fork
enabled: false  # Temporarily disabled after repeated upstream HTTP 429 responses.
source_domains: [cybersecurity]
allowed-tools: Bash(bun run .agents/skills/infosecjobs-search/cli/src/cli.ts *)
---

# InfoSec Jobs Search Skill

Search InfoSec Job Board's public, server-rendered cybersecurity listing pages.

## Commands

```bash
bun run .agents/skills/infosecjobs-search/cli/src/cli.ts search [flags]
bun run .agents/skills/infosecjobs-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Search flags:
- `--query <text>` / `-q <text>` - selects the closest public category page and
  filters cards client-side.
- `--location <text>` / `-l <text>` - client-side location filter; `Europe`, `EU`,
  and `EMEA` use heuristic matching.
- `--jobage <days>` - client-side posted-date filter.
- `--page <n>` - appends `?page=<n>` where supported.
- `--limit <n>` / `-n <n>` - result cap.
- `--format json|table|plain` - default `json`.

Examples:

```bash
bun run .agents/skills/infosecjobs-search/cli/src/cli.ts search -q "application security" -l Europe --jobage 14 --limit 20 --format table
bun run .agents/skills/infosecjobs-search/cli/src/cli.ts search -q "security engineer" -l Remote --format json
bun run .agents/skills/infosecjobs-search/cli/src/cli.ts search -q "grc" --limit 10 --format plain
bun run .agents/skills/infosecjobs-search/cli/src/cli.ts detail 8769103002 --format json
```

## Notes

- Data source: `https://www.infosecjobboard.com/remote-cybersecurity-jobs` and
  related public category pages such as `/remote-appsec-jobs`.
- The developer page exposes aggregate APIs and MCP tools, but not a raw public
  REST job dump. This CLI therefore parses public HTML cards.
- Detail pages are public `/job/<id>` pages.
- Keep attribution to InfoSec Job Board by preserving listing URLs and source metadata.
