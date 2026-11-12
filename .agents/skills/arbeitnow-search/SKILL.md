---
name: arbeitnow-search
version: 1.0.0
description: >
  Use this skill to search Arbeitnow for Europe-focused job listings, including
  remote and visa-friendly tech roles in Germany, Austria, the EU, and Europe.
  Trigger phrases include: Arbeitnow, Europe jobs, EU remote jobs, Austria remote
  jobs, Germany tech jobs, remote Europe security jobs, appsec Europe.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/arbeitnow-search/cli/src/cli.ts *)
---

# Arbeitnow Search Skill

Search live listings from Arbeitnow's public job board API. No authentication or
API key is required.

## When To Use This Skill

- Search for Europe-focused technology roles
- Find remote or EU-friendly security engineering, AppSec, product security, and
  DevSecOps jobs
- Look up a posting already returned by search

## Commands

### Search Job Listings

```bash
bun run .agents/skills/arbeitnow-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` - keyword search over title, company, tags,
  location, and description.
- `--location <text>` / `-l <text>` - optional client-side location filter.
- `--jobage <days>` - posted within N days.
- `--remote <mode>` - `remote`, `hybrid`, or `onsite`. Arbeitnow exposes a
  boolean remote field; `remote` requires it, `onsite` excludes it, and `hybrid`
  searches text for hybrid wording.
- `--page <n>` - 1-indexed API page.
- `--limit <n>` / `-n <n>` - cap results emitted.
- `--format json|table|plain` - default `json`.

### Fetch Full Job Detail

```bash
bun run .agents/skills/arbeitnow-search/cli/src/cli.ts detail <slug|url> [--format json|plain]
```

## Examples

```bash
bun run .agents/skills/arbeitnow-search/cli/src/cli.ts search -q "application security" --remote remote --jobage 14 --format table
bun run .agents/skills/arbeitnow-search/cli/src/cli.ts search -q "product security" -l "Europe" --limit 10 --format table
bun run .agents/skills/arbeitnow-search/cli/src/cli.ts search -q "DevSecOps" -l "Austria" --format json
bun run .agents/skills/arbeitnow-search/cli/src/cli.ts detail example-slug --format plain
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

- Data source: `https://www.arbeitnow.com/api/job-board-api`
- Arbeitnow does not provide server-side keyword filtering in this public
  endpoint, so this CLI applies query filters client-side to the selected page.
