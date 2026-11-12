---
name: adzuna-search
version: 1.0.0
description: >
  Search Adzuna's official jobs API across configured European markets for
  remote technology and cybersecurity roles, preserving source URLs, snippets,
  salary fields, market provenance, and quota-conscious request metadata.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/adzuna-search/cli/src/cli.ts *)
---

# Adzuna Search Skill

Search Adzuna through its official JSON API. This source is intentionally broad:
the shared pipeline handles security relevance, eligibility, deduplication, and
candidate matching after acquisition.

## Credentials

Adzuna requires both:

- `ADZUNA_APP_ID`
- `ADZUNA_APP_KEY`

Optional:

- `ADZUNA_MARKETS` - comma-separated market codes. Defaults to `gb,de,at,nl,fr,ie`.
- `ADZUNA_API_BASE` - override for tests or compatible API gateways.

If either required credential is missing, the CLI exits successfully with an
empty disabled JSON result so scheduled runs can continue.

## Commands

```bash
bun run .agents/skills/adzuna-search/cli/src/cli.ts search [flags]
```

Search flags:

- `--query <text>` / `-q <text>` - keyword search.
- `--location <text>` / `-l <text>` - defaults to `remote` in the daily pipeline.
- `--market <code>` - restrict to one configured market.
- `--jobage <days>` - client-side publication date filter.
- `--page <n>` - Adzuna page number, 1-indexed.
- `--limit <n>` / `-n <n>` - per-market result cap, max 50.
- `--format json|table|plain` - default `json`.

## Notes

- Data source: `https://api.adzuna.com/v1/api/jobs/{country}/search/{page}`.
- Descriptions returned by Adzuna are treated as snippets/partial descriptions
  unless the API provides enough text to classify as full downstream.
- Salary fields remain nullable; missing values are not invented.
- The CLI never logs or persists API keys.
