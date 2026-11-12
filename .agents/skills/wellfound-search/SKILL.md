---
name: wellfound-search
version: 1.0.0
description: >
  Disabled portal skill for Wellfound. Wellfound search requires sign-in or protected
  JavaScript flows for reliable market-wide results, so this skill documents the
  limitation rather than scraping through it.
context: fork
enabled: false
allowed-tools: Bash(bun run .agents/skills/wellfound-search/cli/src/cli.ts *)
---

# Wellfound Search Skill

This portal is installed but disabled. Investigation found:

- Search URL tested: `https://wellfound.com/jobs`
- Support documentation says job search begins by signing in to an account.
- `robots.txt` disallows several job/search parameter surfaces including `/*?jobId=*`, `/*?role=*`, `/_jobs/`, and `/search`.

The CLI intentionally returns a structured error instead of attempting browser
automation, authentication bypassing, anti-bot bypassing, proxying, or other circumvention.
