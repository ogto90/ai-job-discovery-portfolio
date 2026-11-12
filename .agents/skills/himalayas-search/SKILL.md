---
name: himalayas-search
version: 1.0.0
description: Search remote jobs using the official Himalayas public jobs API and retrieve individual job details.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/himalayas-search/cli/src/cli.ts *)
---

# Himalayas Search Skill

Search live remote listings from Himalayas through its official public JSON API.
No authentication or API key is required.

## Commands

```bash
bun run .agents/skills/himalayas-search/cli/src/cli.ts search [flags]
bun run .agents/skills/himalayas-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Search flags:
- `--query <text>` / `-q <text>` - maps to Himalayas `q`.
- `--location <text>` / `-l <text>` - uses native country/worldwide filters when
  possible and client-side matching for broad regions such as `Europe`, `EU`, and
  `EMEA`.
- `--jobage <days>` - filters by the normalized `pubDate`.
- `--page <n>` - maps to the Himalayas search API's 1-based page.
- `--limit <n>` / `-n <n>` - result cap. The browse API caps at 20, and the CLI
  keeps search runs bounded to the same default.
- `--format json|table|plain` - default `json`.

Examples:

```bash
bun run .agents/skills/himalayas-search/cli/src/cli.ts search --query "application security" --location "Europe" --jobage 14 --limit 20 --format json
bun run .agents/skills/himalayas-search/cli/src/cli.ts search -q "security manager" -l Worldwide --format table
bun run .agents/skills/himalayas-search/cli/src/cli.ts detail <guid-or-himalayas-url> --format json
```

## Notes

- Data source: `https://himalayas.app/jobs/api/search`.
- Search uses the public API rather than HTML scraping.
- Himalayas data is rate limited and refreshed approximately every 24 hours, so
  keep scrape volume modest.
- Himalayas requires displayed job data to mention Himalayas as the source and
  link back to the original listing. This CLI preserves Himalayas application
  links and sets `source: "Himalayas"`.
