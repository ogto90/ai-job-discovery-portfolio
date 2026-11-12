---
name: euremotejobs-search
version: 1.0.0
description: >
  Search EU Remote Jobs for Europe, EMEA, and worldwide remote roles using its
  public WordPress REST job listing endpoint. Use for EU Remote Jobs, Europe
  remote jobs, Austria remote jobs, appsec Europe, product security remote,
  cybersecurity remote, and remote security management roles.
context: fork
enabled: false
allowed-tools: Bash(bun run .agents/skills/euremotejobs-search/cli/src/cli.ts *)
---

# EU Remote Jobs Search Skill

Search EU Remote Jobs through its public WordPress REST `job-listings` endpoint.
This portal is currently disabled because the endpoint returns `403 Forbidden` to
the honest CLI User-Agent used by this repository's scraper contract. The public
HTML and REST endpoint can be inspected manually, but enabling this would require
browser impersonation or similar header workarounds that this workspace avoids.

## Commands

```bash
bun run .agents/skills/euremotejobs-search/cli/src/cli.ts search [flags]
bun run .agents/skills/euremotejobs-search/cli/src/cli.ts detail <id|slug|url> [--format json|plain]
```

Search flags:
- `--query <text>` / `-q <text>` - maps to WordPress `search` and is also checked client-side.
- `--location <text>` / `-l <text>` - client-side location filter; `Europe`, `EU`, and
  `EMEA` use heuristic matching.
- `--jobage <days>` - client-side publication date filter.
- `--page <n>` - maps to WordPress `page`.
- `--limit <n>` / `-n <n>` - maps to WordPress `per_page`, capped at 100.
- `--format json|table|plain` - default `json`.

Examples:

```bash
bun run .agents/skills/euremotejobs-search/cli/src/cli.ts search -q "application security" -l Europe --jobage 14 --limit 20 --format table
bun run .agents/skills/euremotejobs-search/cli/src/cli.ts search -q "security engineer" -l EMEA --format json
bun run .agents/skills/euremotejobs-search/cli/src/cli.ts detail senior-backend-engineer-8 --format plain
```

## Notes

- Data source: `https://euremotejobs.com/wp-json/wp/v2/job-listings`.
- Search and pagination are server-side. Location and job-age filters are client-side.
- Company/location extraction is heuristic because the WordPress REST object exposes
  title/content directly but not every taxonomy as a simple field.
- Public query-string search pages are disallowed by `robots.txt`; this skill uses the
  REST endpoint instead.
