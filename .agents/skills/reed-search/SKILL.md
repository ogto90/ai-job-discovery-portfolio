---
name: reed-search
version: 1.0.0
description: >
  Search Reed's official Jobseeker API for UK and remote security-related roles,
  preserving search metadata, salary fields, contract data, expiration dates,
  external URLs, and full descriptions only when details are fetched.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/reed-search/cli/src/cli.ts *)
---

# Reed Search Skill

Search Reed's official Jobseeker API. This source is UK-skewed and is included as
a controlled experiment, not as a general EU remote replacement.

## Credentials

Configure:

```bash
REED_API_KEY=...
```

The API key is sent with HTTP Basic Auth as the username and an empty password.
If `REED_API_KEY` is missing, the CLI exits successfully with an empty JSON result
and `meta.disabled=true`.

## Commands

```bash
bun run .agents/skills/reed-search/cli/src/cli.ts search [flags]
bun run .agents/skills/reed-search/cli/src/cli.ts detail <id> [--format json|plain]
```

Search flags:
- `--query <text>` / `-q <text>` - Reed `keywords`.
- `--location <text>` / `-l <text>` - maps `Europe`, `EU`, `EMEA`, and `Remote`
  to `Remote`; otherwise passed through as `locationName`.
- `--jobage <days>` - client-side date filter when dates are available.
- `--page <n>` - 1-indexed page mapped to Reed `resultsToSkip`.
- `--limit <n>` / `-n <n>` - result cap/page size.
- `--details <n>` - maximum details to fetch after cheap filtering; default 10.
- `--format json|table|plain` - default `json`.

## Notes

- Search results are treated as partial unless detail enrichment succeeds.
- Details are fetched only after cheap local filtering and capped by `--details`.
- Missing credentials, timeouts, rate limits, and API failures are never treated as
  expired listings.
