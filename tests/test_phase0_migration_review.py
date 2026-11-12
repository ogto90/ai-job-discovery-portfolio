import hashlib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"


class Phase0MigrationReviewTests(unittest.TestCase):
    def test_active_migrations_preserve_lineage_and_include_interview_phases(self):
        expected = [
            "20261006170000_cleanroom_baseline.sql",
            "20261007184407_user_job_lifecycle_and_gap_generalization.sql",
            "20261008120000_unify_archive_decisions.sql",
            "20261008133000_add_jobs_updated_at.sql",
            "20261008150000_user_job_work_model_verifications.sql",
            "20261009120000_user_job_language_verifications.sql",
            "20261009130000_user_job_location_verifications.sql",
            "20261010105237_user_job_employment_type_verifications.sql",
            "20261012101824_user_job_preference_overrides.sql",
            "20261016101211_gap_improvement_plan_runs.sql",
            "20261016103910_user_job_duplicate_reviews.sql",
            "20261018164703_ats_board_registry.sql",
        ]
        actual = sorted(path.name for path in MIGRATIONS.glob("*.sql"))
        later_migrations = [
            "20261019141642_discovery_candidate_traces.sql",
            "20261022220000_interview_preparations.sql",
            "20261027120937_interview_preparation_packs.sql",
            "20261031120000_bounded_dashboard_summaries.sql",
            "20261031144518_dashboard_needs_attention_queue.sql",
            "20261031144519_dashboard_attention_exclude_handled.sql",
            "20261031150542_tighten_needs_attention_to_unaddressed.sql",
            "20261031152534_exclude_ready_jobs_from_attention.sql",
            "20261101210829_dashboard_summary_selected_batch.sql",
            "20261102114054_dashboard_page_defer_card_hydration.sql",
            "20261102122635_global_listing_acceptance.sql",
            "20261102123857_fix_dashboard_summary_version_write.sql",
            "20261102135010_needs_attention_exclude_known_mismatch.sql",
            "20261102135836_attention_reuse_current_state.sql",
            "20261102152154_dashboard_summary_content_revision.sql",
        ]
        self.assertEqual(actual, expected + later_migrations)
        versions = [name.split("_", 1)[0] for name in actual]
        self.assertEqual(versions, sorted(set(versions)))

    def test_approved_baseline_is_unchanged(self):
        baseline = MIGRATIONS / "20261006170000_cleanroom_baseline.sql"
        self.assertEqual(
            hashlib.sha256(baseline.read_bytes()).hexdigest(),
            "6b8d8b750815dd039dab65465dbc92cf0481530fb61cc72af53d89a59107cfe2",
        )

    def test_global_listing_acceptance_is_a_forward_only_summary_version_change(self):
        migration = (MIGRATIONS / "20261102122635_global_listing_acceptance.sql").read_text()
        self.assertIn("add constraint user_job_preference_overrides_preferences_check", migration)
        self.assertIn("'role', 'location', 'work_model', 'language'", migration)
        self.assertIn("dashboard_job_attention_page", migration)
        self.assertIn("summary_algorithm_version <> 2", migration)
        self.assertIn("summary_algorithm_version = 2", migration)
        self.assertIn("or m.summary->>'static_reason_code' in (", migration)
        self.assertIn("drop trigger if exists dashboard_work_model_revision", migration)
        self.assertIn("drop trigger if exists dashboard_language_revision", migration)
        self.assertIn("pg_catalog.pg_get_functiondef", migration)
        self.assertNotRegex(migration, r"(?i)\b(drop\s+table|truncate|delete\s+from)\b")

    def test_summary_store_writes_the_current_algorithm_version(self):
        migration = (MIGRATIONS / "20261102123857_fix_dashboard_summary_version_write.sql").read_text()
        self.assertIn("dashboard_summary_store_batch(uuid,jsonb)", migration)
        self.assertIn("(r->>'job_revision')::bigint, 1,", migration)
        self.assertIn("(r->>'job_revision')::bigint, 2,", migration)
        self.assertIn("Expected exactly one hard-coded dashboard summary version literal", migration)

    def test_new_catalogue_is_global_rls_protected_and_service_role_only(self):
        sql = (MIGRATIONS / "20261018164703_ats_board_registry.sql").read_text()
        self.assertIn("CREATE TABLE public.ats_board_registry", sql)
        self.assertIn("GENERATED ALWAYS AS (lower(btrim(board_identifier))) STORED", sql)
        self.assertIn("UNIQUE (provider, normalized_board_identifier, region)", sql)
        self.assertIn("ENABLE ROW LEVEL SECURITY", sql)
        self.assertIn("FROM PUBLIC, anon, authenticated, service_role", sql)
        self.assertIn("TO service_role", sql)
        self.assertNotRegex(sql, r"(?i)\buser_id\b|candidate_profile|application_id")
        self.assertNotRegex(sql, r"(?i)\bGRANT\b[^;]*\bTO\s+(anon|authenticated)\b")
        self.assertNotRegex(sql, r"(?i)\b(UPDATE|DELETE|TRUNCATE)\s+public\.(jobs|applications)\b")

    def test_importer_is_dry_run_first_and_never_deletes_rows(self):
        importer = (ROOT / "scripts/import_ats_board_registry.ts").read_text()
        registry = (ROOT / "tools/ats_board_registry.ts").read_text()
        self.assertIn("let apply = false", importer)
        self.assertIn('args[i] === "--apply"', importer)
        self.assertIn("company.ats.verified && company.ats.status === \"verified\"", registry)
        self.assertIn("resolution=ignore-duplicates", registry)
        self.assertNotRegex(registry, r"(?i)method\s*:\s*[\"']DELETE[\"']")
        self.assertNotRegex(registry, r"(?i)DELETE\s+FROM\s+public\.(jobs|applications)")


if __name__ == "__main__":
    unittest.main()
