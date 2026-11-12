---
name: jooble-search
version: 1.0.0
description: >
  Search Jooble's official REST API across explicitly configured country
  markets, preserving snippet-only descriptions, salary strings, source URLs,
  update dates, and market provenance for downstream security filtering.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/jooble-search/cli/src/cli.ts *)
---

# Jooble Search Skill

Search Jooble's official REST API. Jooble API keys are country/domain-specific,
so this skill never assumes that one global key covers every market.

## Credentials

Configure markets with environment variables:

```bash
JOOBLE_MARKETS=at,de,uk
JOOBLE_API_KEY_AT=...
JOOBLE_API_KEY_DE=...
JOOBLE_API_KEY_UK=...
```

Optional per-market endpoint override:

```bash
JOOBLE_API_BASE_AT=https://at.jooble.org
```

If no configured market has a key, the CLI exits successfully with an empty JSON
result and `meta.disabled=true`.

## Commands

```bash
bun run .agents/skills/jooble-search/cli/src/cli.ts search [flags]
```

Search flags:
- `--query <text>` / `-q <text>` - query sent as Jooble `keywords`.
- `--location <text>` / `-l <text>` - mapped per market. `Europe`, `EU`, and
  `EMEA` search each configured market's country location.
- `--market <code>` - restrict to one configured market.
- `--jobage <days>` - client-side updated-date filter.
- `--page <n>` - Jooble page number.
- `--limit <n>` / `-n <n>` - per-command result cap.
- `--format json|table|plain` - default `json`.

## Notes

- Jooble provides snippets, not guaranteed full descriptions.
- API failures, authentication failures, and rate limits are surfaced as command
  errors; they are not converted into expired jobs.
