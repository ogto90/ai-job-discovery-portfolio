---
name: remotive-search
version: 1.0.0
description: >
  Search live remote job listings from Remotive's public remote jobs API and
  fetch individual postings. Use for remote jobs, Remotive, remote security jobs,
  appsec remote, product security remote, cybersecurity remote, and worldwide or
  Europe-friendly remote roles.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/remotive-search/cli/src/cli.ts *)
---

# Remotive Search Skill

Search Remotive's public remote jobs API. The CLI is generic and accepts arbitrary
queries, but it is useful for remote cybersecurity, application security, product
security, security engineering, and security-management searches.

## Attribution And Access

Remotive's public API documentation permits use with attribution and asks consumers
to link back to Remotive job URLs. It also asks clients to keep request volume low
(normally only a few requests per day; excessive requests may be blocked). The
current `robots.txt` disallows `/api/*`, so this skill uses only the documented
public API, keeps volume low, preserves Remotive URLs, and identifies Remotive as
the source.

## Commands

```bash
bun run .agents/skills/remotive-search/cli/src/cli.ts search [flags]
bun run .agents/skills/remotive-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Search flags:
- `--query <text>` / `-q <text>` - client-side keyword match over normalized fields.
- `--location <text>` / `-l <text>` - client-side location match; `Europe`, `EU`, and
  `EMEA` use a heuristic list of European countries plus broad remote terms.
- `--jobage <days>` - client-side publication date filter.
- `--page <n>` - 1-indexed page over filtered results.
- `--limit <n>` / `-n <n>` - result cap/page size.
- `--format json|table|plain` - default `json`.

Examples:

```bash
bun run .agents/skills/remotive-search/cli/src/cli.ts search -q "application security" -l Europe --jobage 14 --limit 20 --format table
bun run .agents/skills/remotive-search/cli/src/cli.ts search -q "product security" -l Remote --format json
bun run .agents/skills/remotive-search/cli/src/cli.ts search -q "vulnerability management" --limit 5 --format plain
bun run .agents/skills/remotive-search/cli/src/cli.ts detail 123456 --format json
```

## Notes

- Data source: `https://remotive.com/api/remote-jobs`.
- Search parameters are not trusted because API caching can ignore query strings;
  this CLI fetches a bounded feed and filters client-side.
- Remotive jobs are remote by definition; geographic restrictions appear in
  `candidate_required_location`.
- Dates are normalized from `publication_date` to `YYYY-MM-DD`.
- `detail` validates Remotive URLs before fetching and resolves details from the API feed.
