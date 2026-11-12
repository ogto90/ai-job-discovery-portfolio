---
name: weworkremotely-search
version: 1.0.0
description: >
  Search live remote job listings from We Work Remotely's public RSS feed and
  fetch postings from the feed. Use for We Work Remotely, WWR, remote jobs,
  remote security jobs, appsec remote, product security remote, cybersecurity
  remote, and worldwide remote roles.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/weworkremotely-search/cli/src/cli.ts *)
---

# We Work Remotely Search Skill

Search We Work Remotely's public RSS feed. WWR asks users of the public feed to
attribute links back to We Work Remotely; the CLI preserves the WWR job URL and
sets the source accordingly.

## Commands

```bash
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts search [flags]
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Search flags:
- `--query <text>` / `-q <text>` - client-side keyword search over feed fields.
- `--location <text>` / `-l <text>` - client-side location filter; `Europe`,
  `EU`, and `EMEA` use heuristic matching.
- `--jobage <days>` - client-side `pubDate` filter.
- `--page <n>` - client-side page over filtered RSS items.
- `--limit <n>` / `-n <n>` - page size.
- `--format json|table|plain` - default `json`.

Examples:

```bash
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts search -q "application security" -l Europe --jobage 14 --limit 20 --format table
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts search -q "security engineer" -l Remote --format json
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts search -q "product security" --limit 5 --format plain
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts detail https://weworkremotely.com/remote-jobs/example --format json
```

## Notes

- Data source: `https://weworkremotely.com/remote-jobs.rss`.
- The authenticated WWR JSON API is for employer/posting integrations and is not used.
- Feed search, location filtering, job age, pagination, and limit are client-side.
- The feed includes recent public jobs only; older postings may not be resolvable by `detail`.
