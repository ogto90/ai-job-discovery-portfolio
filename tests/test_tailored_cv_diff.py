import pytest

from matching.tailored_cv_diff import compare_cv_sources, extract_cv_units, render_word_changes
from matching.candidate_profile_persistence import ActiveBaseCV, PersistenceError
from ui.cv_diff import load_diff_context


BASE = r"""\documentclass{article}
\begin{document}
\begin{center}
  \NameStyle{EXAMPLE CANDIDATE}\\[2pt]
  \TaglineStyle{SENIOR SECURITY ENGINEER | APPLICATION SECURITY | DEVSECOPS}
\end{center}
\cvsection{Summary}
Experienced security engineer building reliable security programs.\par
\cvsection{Experience}
\roleblock{Security Engineer}{2020--2024}{Acme}{Remote}{}
\begin{itemize}
\item Integrated security tooling into development workflows.
\item Mentored engineering stakeholders.
\end{itemize}
\cvsection{Skills}
\skillrow{Security}{SAST, SCA}
\end{document}"""


def test_identical_sources_have_no_changes():
    diff = compare_cv_sources(BASE, BASE)
    assert diff.changes == ()
    assert diff.base_sha256 == diff.tailored_sha256


def test_header_tagline_change_is_shown_as_a_header_section_change():
    tailored = BASE.replace(
        "SENIOR SECURITY ENGINEER | APPLICATION SECURITY | DEVSECOPS",
        "CYBERSECURITY ENGINEER | VULNERABILITY MANAGEMENT | SECURE SDLC | INCIDENT RESPONSE",
    )
    diff = compare_cv_sources(BASE, tailored)
    header = next(change for change in diff.changes if change.section == "Header")
    assert header.kind == "modified"
    assert any("APPLICATION SECURITY" in unit.text for unit in header.base_units)
    assert any("INCIDENT RESPONSE" in unit.text for unit in header.tailored_units)


def test_header_extraction_removes_latex_layout_and_spacing_commands():
    header = next(unit for unit in extract_cv_units(BASE) if unit.section == "Header")
    assert "EXAMPLE CANDIDATE" in header.text
    assert "SENIOR SECURITY ENGINEER | APPLICATION SECURITY | DEVSECOPS" in header.text
    assert "center" not in header.text
    assert r"\;" not in header.text


def test_identical_header_is_not_reported_as_changed():
    diff = compare_cv_sources(BASE, BASE.replace("security programs", r"\textbf{security programs}"))
    assert "Header" not in diff.sections


def test_modified_bullet_has_word_level_changes():
    tailored = BASE.replace(
        "Integrated security tooling into development workflows.",
        "Integrated Coverity SAST into CI/CD development workflows.",
    )
    diff = compare_cv_sources(BASE, tailored)
    assert diff.counts == {"modified": 1, "added": 0, "removed": 0, "reordered": 0}
    modified = diff.changes[0]
    assert modified.section == "Experience"
    assert any("Coverity SAST" in unit.text for unit in modified.tailored_units)
    assert any("security tooling" in unit.text for unit in modified.base_units)


def test_added_and_removed_units_are_classified():
    tailored = BASE.replace("Mentored engineering stakeholders.\n", "").replace(
        "\\skillrow{Security}{SAST, SCA}",
        "\\skillrow{Security}{SAST, SCA}\n\\skillrow{Leadership}{Mentoring}",
    )
    diff = compare_cv_sources(BASE, tailored)
    assert diff.counts == {"modified": 2, "added": 0, "removed": 0, "reordered": 0}
    experience = next(change for change in diff.changes if change.section == "Experience")
    skills = next(change for change in diff.changes if change.section == "Skills")
    assert any("Mentored" in unit.text for unit in experience.base_units)
    assert any("Leadership" in unit.text for unit in skills.tailored_units)


def test_inserted_bullet_marks_section_modified_without_reorder_noise():
    tailored = BASE.replace(
        "\\item Integrated security tooling into development workflows.",
        "\\item New tailored priority.\n\\item Integrated security tooling into development workflows.",
    )
    diff = compare_cv_sources(BASE, tailored)
    assert diff.counts == {"modified": 1, "added": 0, "removed": 0, "reordered": 0}
    assert all(change.kind != "reordered" for change in diff.changes)


def test_formatting_noise_is_ignored_and_full_units_are_retained():
    tailored = BASE.replace("security programs", r"\textbf{security programs}")
    diff = compare_cv_sources(BASE, tailored)
    assert diff.changes == ()
    assert len(diff.base_units) == len(diff.tailored_units)
    assert any("Experienced security engineer" in unit.text for unit in diff.tailored_units)


def test_word_renderer_escapes_content_and_marks_changes():
    rendered = render_word_changes((("removed", "old <text>"), ("added", "new")))
    assert "&lt;text&gt;" in rendered
    assert "diff-removed" in rendered
    assert "diff-added" in rendered


class FakeDiffClient:
    def __init__(self, tailored_user="user-1", source_user="user-1", deleted=None, metadata_override=None):
        self.tailored_user = tailored_user
        self.source_user = source_user
        self.deleted = deleted
        self.metadata_override = metadata_override
        self.downloads = []

    def resolve_active_base_cv(self):
        return ActiveBaseCV(2, "user-1", "cv-artifacts", "user-1/base/base.tex", True, True)

    def get_json(self, path):
        if "/cv_versions?" in path and "id=eq.10" in path:
            return [{
                "id": 10, "user_id": self.tailored_user, "job_id": 8, "is_base": False,
                "source_cv_version_id": 2, "storage_bucket": "cv-artifacts",
                "tex_file_path": "user-1/tailored/8/a.tex", "pdf_file_path": "user-1/tailored/8/a.pdf",
                "file_path": "user-1/tailored/8/a.pdf", "created_at": "2026-10-04T00:00:00Z",
                "artifacts_deleted_at": self.deleted,
            }]
        if "/cv_versions?" in path and "id=eq.2" in path:
            return [{"id": 2, "user_id": self.source_user, "is_base": True, "storage_bucket": "cv-artifacts", "file_path": "user-1/base/base.tex", "created_at": "2026-01-01T00:00:00Z"}]
        if "/jobs?" in path:
            return [{"company": "Acme", "title": "Security Engineer"}]
        if "/job_metadata_overrides?" in path:
            return [self.metadata_override] if self.metadata_override else []
        raise AssertionError(path)

    def download_storage_object(self, bucket, path):
        self.downloads.append((bucket, path))
        if path.endswith(".pdf"):
            return b"%PDF"
        return BASE.encode()


def test_diff_context_uses_exact_source_lineage():
    context = load_diff_context(FakeDiffClient(), 10)
    assert context.base["id"] == 2
    assert context.tailored["id"] == 10
    assert context.job["company"] == "Acme"
    assert context.base_source == BASE


def test_diff_context_uses_effective_user_title_and_company():
    context = load_diff_context(FakeDiffClient(metadata_override={
        "user_id": "user-1", "job_id": 8,
        "company_override": "Corrected Co", "title_override": "Security Lead",
    }), 10)
    assert context.job == {"company": "Corrected Co", "title": "Security Lead"}


def test_diff_context_rejects_another_users_tailored_cv():
    with pytest.raises(PersistenceError, match="access"):
        load_diff_context(FakeDiffClient(tailored_user="user-2"), 10)


def test_expired_diff_context_does_not_read_storage():
    client = FakeDiffClient(deleted="2026-10-04T00:00:00Z")
    with pytest.raises(PersistenceError, match="expired"):
        load_diff_context(client, 10)
    assert client.downloads == []
