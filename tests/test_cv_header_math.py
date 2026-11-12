import json

import pytest

import matching.tailored_cv as tailoring


BROKEN_HEADER = r"""\documentclass{article}
\begin{document}
\begin{center}
$CYBER SECURITY MANAGER
\end{center}
Delivered security improvements worth $100.
\end{document}
"""


def test_cross_header_math_failure_is_reproduced_then_sanitized(tmp_path, monkeypatch):
    monkeypatch.setattr(tailoring, "_COMPILATION_DIAGNOSTICS", tmp_path / "failures")
    with pytest.raises(tailoring.TailoredCVError, match=r"invalid in math mode"):
        tailoring.compile_latex(BROKEN_HEADER)
    sanitized = tailoring.sanitize_latex_source(BROKEN_HEADER)
    assert r"\$CYBER SECURITY MANAGER" in sanitized
    assert r"worth \$100" in sanitized
    assert tailoring.compile_latex(sanitized).startswith(b"%PDF-")
    assert tailoring.sanitize_latex_source(sanitized) == sanitized


def test_math_pairs_ignore_escaped_dollars_and_keep_valid_math():
    source = r"""\documentclass{article}
\begin{document}
Unmatched $ amount \$120.

Version $x_1$ and \(x_2\).
\end{document}
"""
    result = tailoring.sanitize_latex_source(source)
    assert r"Unmatched \$ amount \$120" in result
    assert r"$x_1$" in result and r"\(x_2\)" in result


def test_failure_preserves_exact_source_and_explicit_diagnostics(tmp_path, monkeypatch):
    monkeypatch.setattr(tailoring, "_COMPILATION_DIAGNOSTICS", tmp_path / "failures")
    monkeypatch.setenv("OPENAI_API_KEY", "dummy-do-not-save")
    def fail(source, *, diagnostics):
        diagnostics.update(compiler="lualatex", returncode=1, log="synthetic compiler error")
        raise tailoring.TailoredCVError("synthetic error")
    monkeypatch.setattr(tailoring, "_compile_latex_isolated", fail)
    with pytest.raises(tailoring.TailoredCVError, match="Offline debugging files"):
        tailoring.compile_latex(BROKEN_HEADER)
    directory, = (tmp_path / "failures").iterdir()
    assert (directory / "source.tex").read_text() == BROKEN_HEADER
    error = json.loads((directory / "error.json").read_text())
    assert error["returncode"] == 1
    assert "dummy-do-not-save" not in (directory / "error.json").read_text()
    assert (directory.stat().st_mode & 0o777) == 0o700
    assert ((directory / "source.tex").stat().st_mode & 0o777) == 0o600
