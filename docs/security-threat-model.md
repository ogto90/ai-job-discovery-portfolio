# Security overview

[Project overview](../README.md) · [Security checks](security-implementation-plan.md)

PairRole is a personal, server-configured application. It handles CVs, application records, external job pages and generated documents. This overview describes repository controls and their limits; it is not a certification or an audit of a hosted deployment.

## Deployment boundary

The app has no built-in login and must remain behind private access controls. Its owner identity comes from server configuration. The server uses a privileged Supabase credential, so application-level ownership checks remain essential even where database row-level security is configured.

Credentials, CVs and application history belong in private deployment storage. The public portfolio copy uses synthetic candidate evidence. Local diagnostic files can contain personal data and must remain private.

## Main risks and controls

| Boundary | Approach | Verification limit |
| --- | --- | --- |
| External job URLs and responses | The shared [HTTP client](../tools/safe_http.ts) validates destinations and redirects and limits response processing. | New fetch paths must use the same controls. |
| Uploaded and generated LaTeX | The [compiler sandbox](../matching/latex_sandbox.py) restricts filesystem, network and resource access and fails closed. | Real isolation depends on host support; see [document operations](cv-artifact-safety.md). |
| User records and documents | Owner-scoped application checks, database constraints and row-level security protect data access. | Disposable database tests do not establish hosted Auth or Storage behavior. |
| AI-generated content | Typed responses and evidence-reference checks reject invalid results before downstream actions. | These checks do not prove factual accuracy or resistance to prompt injection. |
| Repository and delivery | Secret scans, source/dependency checks and security regressions run in CI. | Scanners have limited coverage; temporary dependency exceptions remain explicit and time-bound. |

## AI data and review

CV parsing and tailoring send CV content to OpenAI. Role evaluation sends job information and candidate evidence; gap analysis sends relevant assessment or profile context. Interview preparation can send saved candidate, job and interview context and the confirmed submitted CV.

Interview-pack generation requires an explicit consent checkbox. Its separate public-research request sends company and role information and enables bounded web search. Other AI workflows start from the corresponding user action without that same checkbox.

Model generation does not have direct database, shell or storage tools. Application code validates responses before saving results or invoking the sandboxed compiler. This limits side effects but does not make untrusted content safe or eliminate misleading output. No live-model resistance or accuracy evaluation is claimed.

Provider retention, processing location and account settings must be checked for each deployment; they are not established by the repository. Profiles, assessments and generated documents may be retained by the application.

## Operational limits

- **Access:** private ingress is required. Public multi-user hosting needs a separate authentication and authorization design.
- **Retention:** general artifact-expiry rules exist, but an automatic cleanup caller has not been established. Storage deletion is separate from database deletion; complete erasure and backup retention are not verified.
- **Host security:** local files, diagnostics, backups and the runtime host require their own access and retention controls. Git ignore rules are not a substitute.
- **Delivery:** branch and environment protections are GitHub settings that operators must verify. A single-owner repository does not provide independent review merely by using CODEOWNERS.

For runnable checks and dependency exception policies, see [security checks](security-implementation-plan.md). Report suspected vulnerabilities through the [security policy](../SECURITY.md).
