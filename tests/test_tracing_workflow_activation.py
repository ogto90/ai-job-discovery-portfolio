import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/job-discovery.yml"
ACTIVATION_EXPRESSION = "github.event_name == 'workflow_dispatch' && inputs.enable_candidate_tracing == true"


def resolve_tracing_activation(event_name, inputs):
    return event_name == "workflow_dispatch" and inputs.get("enable_candidate_tracing") is True


class TracingWorkflowActivationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        start = cls.workflow.index("      - name: Run broad discovery\n")
        end = cls.workflow.index("      - name: Summarize run\n", start)
        cls.discovery_step = cls.workflow[start:end]

    def test_dispatch_input_is_optional_boolean_and_defaults_off(self):
        self.assertRegex(
            self.workflow,
            re.compile(
                r"workflow_dispatch:\n\s+inputs:\n\s+enable_candidate_tracing:\n"
                r"\s+description: ['\"]Enable candidate-level discovery tracing for this manual run only\.['\"]\n"
                r"\s+required: false\n\s+type: boolean\n\s+default: false",
            ),
        )

    def test_activation_and_fixed_cap_are_scoped_to_discovery_step(self):
        self.assertIn(
            f"AI_JOB_SEARCH_TRACING_ENABLED: ${{{{ {ACTIVATION_EXPRESSION} }}}}",
            self.discovery_step,
        )
        self.assertIn(
            "AI_JOB_SEARCH_TRACE_MAX_CANDIDATES: ${{ github.event_name == 'workflow_dispatch' && inputs.enable_candidate_tracing == true && '500' || '5000' }}",
            self.discovery_step,
        )
        self.assertEqual(self.workflow.count("AI_JOB_SEARCH_TRACING_ENABLED:"), 1)
        self.assertEqual(self.workflow.count("AI_JOB_SEARCH_TRACE_MAX_CANDIDATES:"), 1)
        self.assertIn('Candidate-level tracing enabled for this manual run (diagnostic cap: 500).', self.discovery_step)
        self.assertIn('Candidate-level tracing disabled for this run.', self.discovery_step)

    def test_manual_only_portfolio_workflow_settings_are_preserved(self):
        self.assertNotIn("  schedule:", self.workflow)
        self.assertIn("  workflow_dispatch:\n", self.workflow)
        self.assertIn('environment: "Job search"', self.workflow)
        self.assertIn("AI_JOB_SEARCH_ATS_ROTATION_SLOT: \"${{ github.run_number }}\"", self.discovery_step)
        self.assertIn("python scripts/run_dashboard_discovery.py \\", self.discovery_step)

    def test_run_summary_emits_bounded_trace_write_counters(self):
        for field in [
            "selected_for_persistence",
            "records_persisted",
            "records_failed_write",
            "records_outcome_unknown",
            "records_not_attempted",
            "records_skipped_after_failure",
            "records_skipped_due_budget",
            "omitted_by_cap",
            "batches_prepared",
            "batches_attempted",
            "batches_succeeded",
            "batches_failed",
            "batches_not_attempted",
            "write_duration_ms",
            "write_budget_exhausted",
            "write_failure_kind",
            "write_http_status",
            "write_error_code",
        ]:
            with self.subTest(field=field):
                self.assertIn(field, self.workflow)

    def test_event_truth_table_fails_closed(self):
        scenarios = [
            ("schedule", {"enable_candidate_tracing": True}, False),
            ("workflow_dispatch", {"enable_candidate_tracing": False}, False),
            ("workflow_dispatch", {"enable_candidate_tracing": True}, True),
            ("workflow_dispatch", {}, False),
            ("unexpected_event", {"enable_candidate_tracing": True}, False),
        ]
        for event_name, inputs, expected in scenarios:
            with self.subTest(event=event_name, inputs=inputs):
                self.assertIs(resolve_tracing_activation(event_name, inputs), expected)

    def test_candidate_cap_is_fixed_for_opt_in_and_diagnostics_only(self):
        for event_name, inputs, expected in [
            ("schedule", {}, "5000"),
            ("workflow_dispatch", {}, "5000"),
            ("workflow_dispatch", {"enable_candidate_tracing": False}, "5000"),
            ("workflow_dispatch", {"enable_candidate_tracing": True}, "500"),
        ]:
            enabled = resolve_tracing_activation(event_name, inputs)
            self.assertEqual("500" if enabled else "5000", expected)


if __name__ == "__main__":
    unittest.main()
