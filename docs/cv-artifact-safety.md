# CV artifact safety

The application's shared CV compiler runs system TeX in Bubblewrap on Linux.
It exposes read-only system libraries, TeX and font configuration, and an isolated
temporary work directory. Application files and home directories are not mounted.
The environment is allowlisted, network and PID namespaces are isolated, shell
escape is disabled, and CPU, memory, file-size, descriptor and wall-time limits
apply. Missing sandbox tools or denied namespace creation fail closed; there is
no direct compiler fallback. Existing cached PDFs do not require recompilation.

Install `bubblewrap` and `util-linux` alongside system TeX. Bubblewrap must
support `--size` for the temporary filesystem limit. Ubuntu 22.04's older
package does not support that option and fails closed. The security CI uses a
checksum-verified, non-setuid Bubblewrap 0.13.1 build on Ubuntu 22.04; see the
[security implementation plan](security-implementation-plan.md). Host security policy
must permit Bubblewrap namespaces; do not disable sandboxing to work around a
deployment failure. Run the real isolation regression on the deployment host:

```bash
.venv/bin/pytest -q tests/test_cv_artifact_safety.py
```

Generation attempts use unique Storage object paths, independent of the shared
tailoring cache fingerprint. On an uncertain database insert, the application
reads back the matching generation. It reuses a committed winner and never
deletes that row's objects. If reconciliation is unavailable or no row is yet
visible, it retains uploaded objects and reports an uncertain save. This can
leave unreferenced objects: inspect their database references before any manual
cleanup, and never delete them solely because the original request failed.
Historical artifacts and cache fingerprints are not rewritten.

## Compilation failures

Failed compilation preserves the exact compiler input (`source.tex`) and a
bounded compiler log (`error.json`) in `.diagnostics/cv-compilation/<attempt>/`.
The error identifies that local directory. It is gitignored; attempt directories
are private (0700), files are private (0600), and no environment/client objects
are serialized. These files contain CV personal data and should remain local.
They permit offline sanitizer/compilation replay without another AI request.
Failures predating this diagnostic capture cannot be recovered from it.

## Single-host expiration coordination

Cleanup and application writes through `SupabaseRestClient` share a per-project
OS file lock. Run Streamlit and the cleanup command on the same host, under the
same OS account and from the same repository checkout. Cleanup locks one CV at a
time, rereads that CV and its exact user/job application, and holds the lock
through Storage deletion and the final database update. CV enumeration uses
keyset pagination; application checks never rely on a truncated global list.

An application request with an uncertain outcome leaves a `.pending` safety
marker beside the lock in ignored `.diagnostics/artifact-locks/`.
Cleanup refuses deletion while that marker exists.
Do not clear it automatically or based only on elapsed time. Stop cleanup,
confirm all application writes have completed and reconcile their database
state before an operator removes the marker. A successful unrelated write does
not clear it. Preserve this directory across app restarts while recovery is pending.

This is **not distributed/database-level protection**. Another host, OS account,
direct SQL, or a client bypassing this REST client does not participate. Do not
schedule concurrent cleanup in such a deployment until database coordination is
implemented. No migration or scheduler is installed by this application-only fix.
