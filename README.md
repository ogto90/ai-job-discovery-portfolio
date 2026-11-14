# PairRole

**A personal workspace for job research and application tracking.**

PairRole brings job discovery, CV-based role comparisons and application tracking into one place. I created it to make my own job search more structured and keep the decisions and documents together.

**Python · TypeScript · Streamlit · PostgreSQL · OpenAI API**

## What it does

<p>
  <img src="assets/readme/workflow.svg" width="100%" alt="Discover listings, check eligibility, review fit and evidence, then track applications. You decide what moves forward.">
</p>

- Collects job listings and flags incomplete or uncertain information for review.
- Compares selected roles with CV evidence and helps prepare application documents.
- Tracks applications and keeps interview preparation with the relevant role.

The user chooses which roles to evaluate and pursue; PairRole does not submit applications.

## My contribution

I defined the product workflows and security requirements and directed development using OpenAI Codex for implementation. The project combines my interests in application security, Python/API automation and practical AI tooling.

Security work includes controls for untrusted inputs, document processing and data access, supported by automated checks. The [security overview](docs/security-threat-model.md) explains their scope and limits.

## Explore or run it

See the [technical guide](docs/technical-guide.md) for a short architecture overview, local setup and test commands. The public copy uses synthetic candidate evidence; running it requires your own database and API credentials.

**Scope:** a personal application with no built-in login. Keep access private and review AI-generated content before using it.

[Report a vulnerability](SECURITY.md) · [MIT License](LICENSE)
