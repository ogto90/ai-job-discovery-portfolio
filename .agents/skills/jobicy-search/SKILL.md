---
name: jobicy-search
version: 1.0.0
description: >
  Search Jobicy's public remote jobs API for current remote technology roles,
  preserving full descriptions, salary fields, source URLs, and remote scope
  metadata for downstream security filtering and deduplication.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/jobicy-search/cli/src/cli.ts *)
---

# Jobicy Search Skill

Search Jobicy's documented public remote jobs API. This skill is intentionally
generic: acquisition stays broad, and the repository's shared security relevance,
eligibility, and deduplication layers decide which jobs survive.

## Attribution And Access

Jobicy's public API does not require authentication. Keep request volume low,
preserve the canonical Jobicy URL, and do not poll excessively.

## Commands

```bash
bun run .agents/skills/jobicy-search/cli/src/cli.ts search [flags]
bun run .agents/skills/jobicy-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Search flags:
- `--query <text>` / `-q <text>` - keyword search using Jobicy's `tag` parameter,
  followed by client-side filtering.
- `--location <text>` / `-l <text>` - maps `Europe`, `EU`, and `EMEA` to Jobicy's
  `europe` geo slug; `Remote`, `Worldwide`, `Global`, and `Anywhere` map to
  `anywhere`.
- `--jobage <days>` - client-side publication date filter.
- `--page <n>` - 1-indexed local page over filtered results.
- `--limit <n>` / `-n <n>` - result cap/page size.
- `--format json|table|plain` - default `json`.

## Notes

- Data source: `https://jobicy.com/api/v2/remote-jobs`.
- `jobDescription` is treated as a full HTML description and normalized to text.
- `jobExcerpt` is preserved separately as an excerpt.
- Missing salary or optional metadata remains nullable; values are not invented.
