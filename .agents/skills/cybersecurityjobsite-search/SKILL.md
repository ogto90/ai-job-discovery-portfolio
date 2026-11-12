---
name: cybersecurityjobsite-search
version: 1.0.0
description: >
  Disabled portal skill for CyberSecurityJobsite. The public search page currently
  returns 403 to non-browser requests and robots.txt disallows query-string search
  URLs, so this skill documents the limitation rather than scraping through it.
context: fork
enabled: false
allowed-tools: Bash(bun run .agents/skills/cybersecurityjobsite-search/cli/src/cli.ts *)
---

# CyberSecurityJobsite Search Skill

This portal is installed but disabled. Investigation found:

- Search URL tested: `https://www.cybersecurityjobsite.com/jobs/?Keywords=application%20security&Location=remote`
- Response: `403 Access Denied`
- `robots.txt`: disallows `/*?*`, which covers the search query URLs needed for a generic scraper.

The CLI intentionally returns a structured error instead of attempting browser
impersonation, CAPTCHA bypassing, proxying, or other circumvention.
