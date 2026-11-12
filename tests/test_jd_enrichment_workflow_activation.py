import re
import unittest
from pathlib import Path


WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/job-discovery.yml"
PILOT_EXPRESSION = "github.event_name == 'workflow_dispatch' && inputs.enable_jd_enrichment_60_pilot == true && '60' || '30'"
TRACING_EXPRESSION = "github.event_name == 'workflow_dispatch' && inputs.enable_candidate_tracing == true"


def selected_settings(event_name, inputs):
    manual = event_name == "workflow_dispatch"
    return (
        "60" if manual and inputs.get("enable_jd_enrichment_60_pilot") is True else "30",
        manual and inputs.get("enable_candidate_tracing") is True,
    )


class JdEnrichmentWorkflowActivationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        start = cls.workflow.index("      - name: Run broad discovery\n")
        end = cls.workflow.index("      - name: Summarize run\n", start)
        cls.discovery_step = cls.workflow[start:end]

    def test_optional_boolean_input_is_off_by_default(self):
        self.assertRegex(
            self.workflow,
            re.compile(
                r"enable_jd_enrichment_60_pilot:\n"
                r"\s+description: ['\"]Use up to 60 JD enrichment attempts for this manual discovery run only\.['\"]\n"
                r"\s+required: false\n\s+type: boolean\n\s+default: false"
            ),
        )

    def test_exact_activation_is_scoped_to_discovery_step(self):
        self.assertIn(
            f"AI_JOB_SEARCH_JD_ENRICHMENT_MAX_ATTEMPTS: ${{{{ {PILOT_EXPRESSION} }}}}",
            self.discovery_step,
        )
        self.assertEqual(self.workflow.count("AI_JOB_SEARCH_JD_ENRICHMENT_MAX_ATTEMPTS:"), 1)
        self.assertIn(f"AI_JOB_SEARCH_TRACING_ENABLED: ${{{{ {TRACING_EXPRESSION} }}}}", self.discovery_step)
        self.assertIn("inputs.enable_candidate_tracing == true && '500' || '5000'", self.discovery_step)
        self.assertIn('JD enrichment: budget=', self.workflow)
        self.assertNotIn("  schedule:", self.workflow)

    def test_event_and_input_combinations(self):
        cases = [
            ("schedule", {"enable_jd_enrichment_60_pilot": True, "enable_candidate_tracing": True}, "30", False),
            ("workflow_dispatch", {}, "30", False),
            ("workflow_dispatch", {"enable_jd_enrichment_60_pilot": False, "enable_candidate_tracing": False}, "30", False),
            ("workflow_dispatch", {"enable_jd_enrichment_60_pilot": False, "enable_candidate_tracing": True}, "30", True),
            ("workflow_dispatch", {"enable_jd_enrichment_60_pilot": True, "enable_candidate_tracing": False}, "60", False),
            ("workflow_dispatch", {"enable_jd_enrichment_60_pilot": True, "enable_candidate_tracing": True}, "60", True),
            ("push", {"enable_jd_enrichment_60_pilot": True, "enable_candidate_tracing": True}, "30", False),
        ]
        for event, inputs, budget, tracing in cases:
            with self.subTest(event=event, inputs=inputs):
                self.assertEqual(selected_settings(event, inputs), (budget, tracing))


if __name__ == "__main__":
    unittest.main()
