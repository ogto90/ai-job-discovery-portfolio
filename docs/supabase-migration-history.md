# Supabase Migration History

## Current Reconciled Layout

As of 2026-10-11, the production ledger and active local chain contain the
same eight migrations, in version order:

1. `20261006170000_cleanroom_baseline.sql`
2. `20261007184407_user_job_lifecycle_and_gap_generalization.sql`
3. `20261008120000_unify_archive_decisions.sql`
4. `20261008133000_add_jobs_updated_at.sql`
5. `20261008150000_user_job_work_model_verifications.sql`
6. `20261009120000_user_job_language_verifications.sql`
7. `20261009130000_user_job_location_verifications.sql`
8. `20261010105237_user_job_employment_type_verifications.sql`

The baseline SHA-256 is
`6b8d8b750815dd039dab65465dbc92cf0481530fb61cc72af53d89a59107cfe2`.
The `jobs_updated_at` migration was applied on 2026-10-11 after a fresh backup
and isolated restore rehearsal. Its function revoke includes `PUBLIC`, `anon`,
and `authenticated`; the live index, trigger, timestamps, and service-only
function access were verified. A subsequent `db push --dry-run --include-all
--skip-vault` showed no pending active migrations.

## Historical SQL

The 30 migrations older than the baseline are preserved byte-for-byte in
`supabase/migrations_archive/pre_cleanroom_baseline/`. They are provenance and
clean-room legacy-replay inputs, not part of the active deployment chain and
must not be marked individually applied in production: the baseline squashes
their resulting state.

Phase 1E physical-job-identity work is not deployed or part of this active
migration chain. It requires a new forward version and production-data restore
rehearsal before any separately approved deployment.

## Earlier Audit Notes Superseded

Older diagnostics described 31 individually applied historical migrations,
version/name drift, and a live-only
`20261004002147_enforce_server_side_access` entry. Those observations describe
an earlier migration ledger and are superseded by the current production
baseline ledger. They are not instructions to repair or rewrite migration
history. No historical SQL has been fabricated, no applied migration source
has been rewritten, and no migration-ledger repair was performed as part of the
repository reconciliation.

## Security And Clean-Room Evidence

The baseline preserves the established server-only model: RLS on application
tables, no browser-facing policies or `anon`/`authenticated` application-table
privileges, and service-role access. Provider-managed Storage catalog/ACL
differences are not copied into this application migration chain.

Legacy historical replay must explicitly use
`supabase/migrations_archive/pre_cleanroom_baseline/` as its source.
