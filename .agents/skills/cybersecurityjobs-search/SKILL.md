---
name: cybersecurityjobs-search
version: 1.0.0
description: >
  Disabled portal skill for CyberSecurityJobs. The job search subdomain currently
  returns a Cloudflare managed challenge to CLI requests, so this skill documents
  the limitation rather than scraping through it.
context: fork
enabled: false
allowed-tools: Bash(bun run .agents/skills/cybersecurityjobs-search/cli/src/cli.ts *)
---

# CyberSecurityJobs Search Skill

This portal is installed but disabled. Investigation found:

- Search URL tested: `https://jobs.cybersecurityjobs.com/job/search/?q=application%20security&location=remote`
- Response: Cloudflare `Just a moment...` managed challenge with `noindex,nofollow`.
- Main marketing site exposes WordPress content, but live searchable jobs are on the protected jobs subdomain.

The CLI intentionally returns a structured error instead of attempting browser
impersonation, CAPTCHA bypassing, proxying, or other circumvention.
