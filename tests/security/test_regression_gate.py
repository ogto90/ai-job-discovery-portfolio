"""Prevent an empty or skipped security suite from becoming a green CI check."""
import pytest

from scripts.security.run_regressions import verify_report


@pytest.mark.parametrize("content", [
    '<testsuites><testsuite tests="0" /></testsuites>',
    '<testsuites><testsuite><testcase name="isolation"><skipped /></testcase></testsuite></testsuites>',
    '<testsuites><testsuite><testcase name="isolation"><failure /></testcase></testsuite></testsuites>',
    '<testsuites><testsuite><testcase name="isolation"><error /></testcase></testsuite></testsuites>',
    '<testsuites><testsuite><testcase name="unrelated" /></testsuite></testsuites>',
])
def test_incomplete_security_evidence_is_rejected(tmp_path, content):
    report = tmp_path / "results.xml"
    report.write_text(content)
    with pytest.raises(ValueError):
        verify_report(report, {"isolation"})


def test_executed_required_case_is_accepted(tmp_path):
    report = tmp_path / "results.xml"
    report.write_text('<testsuites><testsuite><testcase name="isolation[param]" /></testsuite></testsuites>')
    assert verify_report(report, {"isolation"}) == 1
