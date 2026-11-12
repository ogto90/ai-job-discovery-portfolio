---
name: remoteok-search
version: 1.0.0
description: >
  Use this skill to search Remote OK for remote job listings, especially global,
  Europe-friendly, EMEA, software, security engineering, application security,
  product security, DevSecOps, and cloud security roles. Trigger phrases include:
  remote jobs, Remote OK, remote developer jobs, remote security jobs, appsec
  remote, product security remote, remote Europe jobs, worldwide remote jobs.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/remoteok-search/cli/src/cli.ts *)
---

# Remote OK Search Skill

Search live job listings from Remote OK's public JSON feed. No authentication or
API key is required. Remote OK asks API users to credit Remote OK and link back
to the job URL; this skill preserves the Remote OK posting URL in every result.

## When To Use This Skill

- Search for remote-first technology jobs
- Find application security, product security, DevSecOps, cloud security, and
  software security postings that may allow work from Europe
- Fetch the description for a specific Remote OK posting already returned by search

## Commands

### Search Job Listings

```bash
bun run .agents/skills/remoteok-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` - keyword search over title, company, tags,
  location, and description.
- `--location <text>` / `-l <text>` - optional client-side location filter, e.g.
  `Europe`, `Worldwide`, `EMEA`, `CET`.
- `--jobage <days>` - posted within N days.
- `--remote <mode>` - supports `remote`; `hybrid` and `onsite` return no results
  because Remote OK is remote-only.
- `--page <n>` - accepted for the portal contract; Remote OK exposes one current
  feed, so pages other than 1 return an empty result set.
- `--limit <n>` / `-n <n>` - cap results emitted.
- `--format json|table|plain` - default `json`.

### Fetch Full Job Detail

```bash
bun run .agents/skills/remoteok-search/cli/src/cli.ts detail <id|slug|url> [--format json|plain]
```

## Examples

```bash
bun run .agents/skills/remoteok-search/cli/src/cli.ts search -q "application security" --jobage 14 --format table
bun run .agents/skills/remoteok-search/cli/src/cli.ts search -q "product security" -l "Europe" --limit 10 --format table
bun run .agents/skills/remoteok-search/cli/src/cli.ts search -q "DevSecOps" --remote remote --format json
bun run .agents/skills/remoteok-search/cli/src/cli.ts detail remote-example-123456 --format plain
```

## Output Formats

| Format | Best for |
|--------|----------|
| `json` | Programmatic use by `/scrape` |
| `table` | Quick terminal scan |
| `plain` | Readable detail output |

Search JSON is `{ "meta": { "count", "page", "total" }, "results": [...] }`.
Each result carries `id`, `title`, `company`, `location`, `date`, `deadline`,
`url`, and `description`.

## Notes

- Data source: `https://remoteok.com/api`
- The API is a single newest-jobs feed rather than a deep historical search API.
  Filtering is client-side, so keep runs bounded and modest.
- The first API object is legal/feed metadata, not a job; the CLI skips it.
