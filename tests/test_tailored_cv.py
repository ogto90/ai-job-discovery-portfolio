import hashlib
import json

import pytest
from pydantic import ValidationError
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

from matching.candidate_profile import representative_profile
from matching.holistic_matcher import DEFAULT_MODEL, VerifiedJob, candidate_projection_sha256
from matching.candidate_profile_persistence import ActiveBaseCV
from matching.tailored_cv import (
    TailoredCVError,
    TailoredCVOutput,
    TailoringInput,
    TAILORED_CV_FINGERPRINT_VERSION,
    TAILORED_CV_REASONING_EFFORT,
    TAILORED_CV_REASONING_MODE,
    TAILORING_PROMPT,
    TAILORED_CV_VERSION,
    build_tailoring_input,
    compile_latex,
    generate_tailored_latex,
    generate_or_reuse_tailored_cv,
    tailoring_fingerprint,
    sanitize_latex_source,
    validate_tailored_latex,
)


BASE = r"""\documentclass{article}
\usepackage{hyperref}
\usepackage{xcolor}
\definecolor{accent}{HTML}{3B50D5}
\newcommand{\NameStyle}[1]{#1}
\newcommand{\skillrow}[2]{#1: #2\par}
\begin{document}
\NameStyle{EXAMPLE CANDIDATE}
\href{mailto:test@example.com}{test@example.com}
\end{document}
"""
_DEFAULT_TAILORED_OUTPUT = object()
JOB = VerifiedJob(
    title="Security Engineer",
    company="Acme",
    description="Build secure systems and improve application security.",
    source_url="https://example.test/jobs/1",
)


def test_tailoring_strategy_is_preservation_first_and_versioned():
    assert TAILORED_CV_VERSION == "tailored_cv_v4"
    assert "Preserve it by\ndefault" in TAILORING_PROMPT
    assert "preserve it exactly" in TAILORING_PROMPT
    assert "8+ years" in TAILORING_PROMPT
    assert "move it\nhigher rather than rewriting it" in TAILORING_PROMPT
    assert "page-space" in TAILORING_PROMPT
    assert "Never expose internal" in TAILORING_PROMPT
    assert "public_display_name" in TAILORING_PROMPT
    assert "skills-level knowledge" in TAILORING_PROMPT
    assert "professional evidence" in TAILORING_PROMPT
    assert "Older roles should usually remain textually unchanged" in TAILORING_PROMPT
    assert "10-20%" in TAILORING_PROMPT
    assert "1. hard requirements" in TAILORING_PROMPT
    assert "5. remove only when space is genuinely needed" in TAILORING_PROMPT
    assert "Never invent employment" in TAILORING_PROMPT


def test_tailoring_fingerprint_is_stable_and_changes_for_new_inputs():
    profile = representative_profile()
    tailoring_input = build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=JOB)
    first = tailoring_fingerprint(tailoring_input=tailoring_input, source_cv_version_id=2)
    assert first == tailoring_fingerprint(tailoring_input=tailoring_input, source_cv_version_id=2)
    assert first != tailoring_fingerprint(
        tailoring_input=build_tailoring_input(base_cv_text=BASE + "% changed\n", candidate_profile=profile, job=JOB),
        source_cv_version_id=2,
    )
    changed_job = VerifiedJob(
        title=JOB.title,
        company=JOB.company,
        description="Different role.",
        source_url=JOB.source_url,
    )
    assert first != tailoring_fingerprint(
        tailoring_input=build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=changed_job),
        source_cv_version_id=2,
    )
    assert first != tailoring_fingerprint(tailoring_input=tailoring_input, source_cv_version_id=2, model="gpt-6.1-sol")
    assert first != tailoring_fingerprint(tailoring_input=tailoring_input, source_cv_version_id=2, version="tailored_cv_v1")
    assert first != tailoring_fingerprint(tailoring_input=tailoring_input, source_cv_version_id=2, reasoning_effort="high")
    assert first != tailoring_fingerprint(tailoring_input=tailoring_input, source_cv_version_id=2, reasoning_mode="pro")
    assert first != tailoring_fingerprint(tailoring_input=tailoring_input, source_cv_version_id=3)
    assert TAILORED_CV_FINGERPRINT_VERSION == "tailored_cv_fingerprint_v2"
    metadata_only_profile = profile.model_copy(update={"schema_version": "unrelated-parser-schema", "source_cv_version_id": 88})
    assert first == tailoring_fingerprint(
        tailoring_input=build_tailoring_input(base_cv_text=BASE, candidate_profile=metadata_only_profile, job=JOB),
        source_cv_version_id=2,
    )


def legacy_tailoring_fingerprint(profile, job, *, base_cv_bytes=BASE.encode(), version=TAILORED_CV_VERSION, model=DEFAULT_MODEL):
    payload = {
        "base_cv_sha256": hashlib.sha256(base_cv_bytes).hexdigest(),
        "candidate_projection_sha256": candidate_projection_sha256(profile),
        "jd_sha256": job.description_sha256,
        "tailoring_version": version,
        "model": model,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def test_tailoring_input_uses_title_and_jd_but_excludes_company_and_discovery_metadata():
    profile = representative_profile()
    original = build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=JOB)
    assert original.job_projection.model_dump(mode="json") == {
        "title": JOB.title,
        "description": JOB.description,
    }
    baseline = tailoring_fingerprint(tailoring_input=original, source_cv_version_id=2)
    for changed in (
        JOB.model_copy(update={"company": "Different prestige signal"}),
        JOB.model_copy(update={"source_url": "https://different.example/job"}),
        JOB.model_copy(update={"location": "Vienna", "remote_scope": "Hybrid"}),
    ):
        projected = build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=changed)
        assert tailoring_fingerprint(tailoring_input=projected, source_cv_version_id=2) == baseline
    assert tailoring_fingerprint(
        tailoring_input=build_tailoring_input(
            base_cv_text=BASE, candidate_profile=profile,
            job=JOB.model_copy(update={"title": "Security Engineering Manager"}),
        ),
        source_cv_version_id=2,
    ) != baseline


def test_pliant_title_repair_invalidates_but_company_only_repair_does_not():
    profile = representative_profile()
    common = {
        "description": "The same complete Pliant security job description.",
        "source_url": "https://jobs.ashbyhq.com/pliant/a0b4660b-2bc6-4e40-addf-cf64072bf3ce",
    }
    malformed = VerifiedJob(title="ABOUT US", company="US", **common)
    corrected = VerifiedJob(
        title="Security Engineer *EU/UK remote* (m/f/d)", company="Pliant", **common
    )
    malformed_key = tailoring_fingerprint(
        tailoring_input=build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=malformed),
        source_cv_version_id=2,
    )
    corrected_key = tailoring_fingerprint(
        tailoring_input=build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=corrected),
        source_cv_version_id=2,
    )
    company_only = VerifiedJob(title=malformed.title, company="Pliant", **common)
    company_only_key = tailoring_fingerprint(
        tailoring_input=build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=company_only),
        source_cv_version_id=2,
    )
    assert malformed_key != corrected_key
    assert malformed_key == company_only_key


def test_tailoring_candidate_projection_tracks_public_labels_and_evidence_only():
    profile = representative_profile()
    original = build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=JOB)
    baseline = tailoring_fingerprint(tailoring_input=original, source_cv_version_id=2)
    candidate = original.candidate_projection
    changed_display = candidate.model_copy(update={
        "capabilities": [
            item.model_copy(update={"public_display_name": "Public wording changed"})
            if index == 0 else item
            for index, item in enumerate(candidate.capabilities)
        ]
    })
    assert tailoring_fingerprint(
        tailoring_input=original.model_copy(update={"candidate_projection": changed_display}),
        source_cv_version_id=2,
    ) != baseline
    changed_evidence = profile.model_copy(update={
        "summary": profile.summary + " Additional evidence."})
    assert tailoring_fingerprint(
        tailoring_input=build_tailoring_input(base_cv_text=BASE, candidate_profile=changed_evidence, job=JOB),
        source_cv_version_id=2,
    ) != baseline
    changed_capabilities = profile.model_copy(update={
        "capabilities": [
            item.model_copy(update={"evidence_level": int(item.evidence_level) + 1})
            if index == 0 else item
            for index, item in enumerate(profile.capabilities)
        ]
    })
    assert tailoring_fingerprint(
        tailoring_input=build_tailoring_input(base_cv_text=BASE, candidate_profile=changed_capabilities, job=JOB),
        source_cv_version_id=2,
    ) != baseline


def test_search_and_application_state_are_not_tailoring_inputs():
    profile = representative_profile()
    baseline = tailoring_fingerprint(
        tailoring_input=build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=JOB),
        source_cv_version_id=2,
    )
    # Preferences, review, and lifecycle fields cannot enter this strict schema.
    assert set(TailoringInput.model_fields) == {"base_cv_text", "candidate_projection", "job_projection"}
    assert baseline == tailoring_fingerprint(
        tailoring_input=build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=JOB),
        source_cv_version_id=2,
    )


def test_latex_validation_preserves_identity_and_structure():
    result = validate_tailored_latex(BASE, BASE)
    assert result.endswith("\n")


def test_latex_validation_repairs_literal_newline_before_header_spacing():
    broken = BASE.replace(
        r"\end{document}",
        r"\TaglineStyle{SECURITY ENGINEER \n[1.5pt] AUTOMATION}" + "\n" + r"\end{document}",
    )
    repaired = validate_tailored_latex(broken, BASE)
    assert r"SECURITY ENGINEER \\[1.5pt] AUTOMATION" in repaired
    assert r"SECURITY ENGINEER \n[1.5pt] AUTOMATION" not in repaired


def test_latex_validation_replaces_invisible_control_characters():
    broken = BASE.replace("EXAMPLE CANDIDATE", "EXAMPLE\x10CANDIDATE")
    sanitized = sanitize_latex_source(broken)
    assert "\x10" not in sanitized
    assert "EXAMPLE CANDIDATE" in sanitized
    assert validate_tailored_latex(broken, BASE).endswith("\n")


def test_reserved_latex_characters_are_escaped_only_in_visible_text():
    source = BASE.replace(
        "\\end{document}",
        r"\skillrow{Identity, Infrastructure & Cloud Security}{SOC 2 & ISO 27001, R&D, C#, user_name, 50% reduction}" + "\n"
        + r"\href{https://example.test/user_name?q=50%25&tag=#frag}{Profile_user_name}" + "\n"
        + r"\textbf{Version $x_1$ and already escaped R\&D}" + "\n"
        + "\\end{document}",
    )

    sanitized = sanitize_latex_source(source)

    assert r"Identity, Infrastructure \& Cloud Security" in sanitized
    assert r"SOC 2 \& ISO 27001, R\&D, C\#, user\_name, 50\% reduction" in sanitized
    assert r"\href{https://example.test/user_name?q=50%25&tag=#frag}{Profile\_user\_name}" in sanitized
    assert r"Version $x_1$ and already escaped R\&D" in sanitized
    assert r"\definecolor{accent}{HTML}{3B50D5}" in sanitized
    assert sanitize_latex_source(sanitized) == sanitized


def test_reserved_character_sanitizer_preserves_latex_alignment_syntax():
    source = BASE.replace(
        "\\end{document}",
        "\\begin{tabular}{ll}\nleft & right\\\\\n\\end{tabular}\n\\end{document}",
    )

    sanitized = sanitize_latex_source(source)

    assert "left & right" in sanitized


def test_reserved_character_sanitizer_preserves_macro_definitions_and_verb():
    syntax = r"\newcommand{\sample}[1]{#1 & user_name} \verb|#_&%|"
    source = BASE.replace("\\end{document}", syntax + "\n\\end{document}")

    assert syntax in sanitize_latex_source(source)


def test_squads_luna_ampersand_regression_compiles_after_sanitization():
    source = BASE.replace(
        "\\end{document}",
        r"\skillrow{Identity, Infrastructure & Cloud Security}{AWS Fundamentals, Container Security Fundamentals}" + "\n"
        + "\\end{document}",
    )

    validated = validate_tailored_latex(source, BASE)
    assert r"Identity, Infrastructure \& Cloud Security" in validated
    assert compile_latex(validated).startswith(b"%PDF-")


def test_skill_evidence_annotations_are_removed_but_public_names_remain():
    source = BASE.replace(
        "\\end{document}",
        r"\skillrow{Application Security}{Threat Modeling (skills-level knowledge), DAST (skills-level)}" + "\n\\end{document}",
    )

    validated = validate_tailored_latex(source, BASE)

    assert "Threat Modeling (skills-level knowledge)" not in validated
    assert "DAST (skills-level)" not in validated
    assert "Threat Modeling" in validated
    assert "DAST" in validated


def test_evidence_annotations_outside_skill_rows_are_rejected():
    source = BASE.replace("security@example.com", "security@example.com") + "\n% skills-level knowledge"

    with pytest.raises(TailoredCVError, match="evidence metadata"):
        validate_tailored_latex(source, BASE)


def test_public_fundamentals_and_historical_experience_are_preserved():
    source = BASE.replace(
        "\\end{document}",
        r"\skillrow{Cloud}{AWS Fundamentals, Container Security Fundamentals}" + "\n\\textbf{Historical web application scanning}" + "\n\\end{document}",
    )

    validated = validate_tailored_latex(source, BASE)

    assert "AWS Fundamentals" in validated
    assert "Container Security Fundamentals" in validated
    assert "Historical web application scanning" in validated


def test_v3_tailoring_cache_identity_is_not_current_v4():
    profile = representative_profile()
    tailoring_input = build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=JOB)
    current = tailoring_fingerprint(tailoring_input=tailoring_input, source_cv_version_id=2)
    legacy = tailoring_fingerprint(
        tailoring_input=tailoring_input, source_cv_version_id=2, version="tailored_cv_v3"
    )
    pre_fix_key = legacy_tailoring_fingerprint(profile, JOB)

    assert current != legacy
    assert current != pre_fix_key


def test_tailoring_model_receives_only_the_canonical_input_and_explicit_reasoning():
    profile = representative_profile()
    tailoring_input = build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=JOB)
    ai = FakeTailoredAI()
    result = generate_tailored_latex(tailoring_input=tailoring_input, client=ai)
    request = ai.requests[0]
    user_content = request["input"][1]["content"]
    assert result == BASE.strip() + "\n"
    assert request["reasoning"] == {
        "mode": TAILORED_CV_REASONING_MODE,
        "effort": TAILORED_CV_REASONING_EFFORT,
    }
    assert "public_display_name" in user_content
    assert "company" not in user_content
    assert "source_url" not in user_content
    assert "location" not in user_content
    assert "remote_scope" not in user_content
    assert JOB.title in user_content and JOB.description in user_content
    assert "untrusted source data, not" in request["input"][0]["content"]


def test_oversized_tailored_model_output_is_rejected():
    from matching.tailored_cv import MAX_TAILORED_LATEX_CHARS

    with pytest.raises(ValidationError):
        TailoredCVOutput(latex_source="x" * (MAX_TAILORED_LATEX_CHARS + 1))


@pytest.mark.parametrize("source", ["", "```latex\\documentclass{article}```", r"\documentclass{article}\begin{document}\end{document}"])
def test_latex_validation_rejects_unsafe_or_incomplete_output(source):
    with pytest.raises(TailoredCVError):
        validate_tailored_latex(source, BASE)


class FakeTailoredClient:
    def __init__(self):
        self.rows = []
        self.uploads = []

    def resolve_active_base_cv(self, user_id=None):
        return ActiveBaseCV(2, "user-1", "cv-artifacts", "user-1/base/main_example.tex", True, True)

    def list_profiles(self, user_id, cv_version_id):
        return [{
            "id": 7,
            "user_id": user_id,
            "cv_version_id": cv_version_id,
            "is_active": True,
            "profile_json": representative_profile().model_dump(mode="json"),
        }]

    def download_storage_object(self, bucket, path):
        assert (bucket, path) == ("cv-artifacts", "user-1/base/main_example.tex")
        return BASE.encode()

    def get_json(self, path):
        query = parse_qs(urlparse(path).query)
        filters = {
            key: value[0][3:]
            for key, value in query.items()
            if value and value[0].startswith("eq.")
        }
        return [
            row for row in self.rows
            if all(str(row.get(key)).casefold() == value.casefold() for key, value in filters.items())
        ]

    def upload_storage_object(self, bucket, path, data, *, content_type):
        self.uploads.append((bucket, path, data, content_type))

    def json_request(self, method, path, payload, *, prefer=None):
        assert method == "POST"
        row = {"id": len(self.rows) + 1, **payload}
        self.rows.append(row)
        return [row]

    def delete_storage_object(self, bucket, path):
        pass


class FakeTailoredAI:
    def __init__(self, output=_DEFAULT_TAILORED_OUTPUT):
        self.calls = 0
        self.requests = []
        self.output = TailoredCVOutput(latex_source=BASE) if output is _DEFAULT_TAILORED_OUTPUT else output

    class _Responses:
        def __init__(self, owner):
            self.owner = owner

        def parse(self, **kwargs):
            self.owner.calls += 1
            self.owner.requests.append(kwargs)
            return SimpleNamespace(output_parsed=self.owner.output)

    @property
    def responses(self):
        return self._Responses(self)


def test_missing_tailored_model_output_never_compiles_or_persists(monkeypatch):
    client = FakeTailoredClient()
    ai = FakeTailoredAI(output=None)
    monkeypatch.setattr(
        "matching.tailored_cv.compile_latex",
        lambda _source: pytest.fail("invalid model output must not reach the compiler"),
    )

    with pytest.raises(TailoredCVError, match="no CV source"):
        generate_or_reuse_tailored_cv(
            client,
            user_id="user-1", cv_version_id=2, candidate_profile_id=7,
            job_id=8, title=JOB.title, company=JOB.company,
            description=JOB.description, source_url=JOB.source_url,
            location=None, remote_scope=None, ai_client=ai,
        )

    assert ai.calls == 1
    assert client.rows == []
    assert client.uploads == []


def test_tailored_cv_cache_persists_pdf_and_regenerate_keeps_history(monkeypatch):
    client = FakeTailoredClient()
    ai = FakeTailoredAI()
    monkeypatch.setattr("matching.tailored_cv.compile_latex", lambda source: b"%PDF-1.7 fake")
    args = {
        "user_id": "user-1",
        "cv_version_id": 2,
        "candidate_profile_id": 7,
        "job_id": 8,
        "title": JOB.title,
        "company": JOB.company,
        "description": JOB.description,
        "source_url": JOB.source_url,
        "location": None,
        "remote_scope": None,
        "ai_client": ai,
    }
    first = generate_or_reuse_tailored_cv(client, **args)
    second = generate_or_reuse_tailored_cv(client, **args)
    regenerated = generate_or_reuse_tailored_cv(client, **args, force_regenerate=True)
    assert first["created"] is True
    assert second["cache_hit"] is True
    assert regenerated["created"] is True
    assert ai.calls == 2
    assert len(client.rows) == 2
    assert len(client.uploads) == 4
    assert all(path.startswith("user-1/tailored/8/") for _, path, _, _ in client.uploads)


def test_legacy_cache_key_is_not_reused_and_history_is_preserved(monkeypatch):
    client = FakeTailoredClient()
    historical = {
        "id": 40,
        "user_id": "user-1",
        "job_id": 8,
        "is_base": False,
        "source_cv_version_id": 2,
        "tailoring_fingerprint": legacy_tailoring_fingerprint(representative_profile(), JOB),
        "tex_file_path": "user-1/tailored/8/legacy.tex",
        "pdf_file_path": "user-1/tailored/8/legacy.pdf",
        "file_path": "user-1/tailored/8/legacy.pdf",
        "storage_bucket": "cv-artifacts",
        "created_at": "2026-10-01T00:00:00Z",
        "expires_at": None,
        "artifacts_deleted_at": None,
    }
    client.rows.append(historical.copy())
    ai = FakeTailoredAI()
    monkeypatch.setattr("matching.tailored_cv.compile_latex", lambda source: b"%PDF-1.7 fake")
    result = generate_or_reuse_tailored_cv(
        client,
        user_id="user-1", cv_version_id=2, candidate_profile_id=7, job_id=8,
        title=JOB.title, company=JOB.company, description=JOB.description,
        source_url=JOB.source_url, location=None, remote_scope=None, ai_client=ai,
    )
    assert result["created"] is True
    assert result["cache_hit"] is False
    assert ai.calls == 1
    assert len(client.rows) == 2
    assert client.rows[0] == historical


def test_expired_matching_artifact_is_not_reused_or_overwritten(monkeypatch):
    profile = representative_profile()
    current_input = build_tailoring_input(base_cv_text=BASE, candidate_profile=profile, job=JOB)
    current_fingerprint = tailoring_fingerprint(
        tailoring_input=current_input, source_cv_version_id=2
    )
    client = FakeTailoredClient()
    expired = {
        "id": 41,
        "user_id": "user-1",
        "job_id": 8,
        "is_base": False,
        "source_cv_version_id": 2,
        "tailoring_fingerprint": current_fingerprint,
        "tex_file_path": "user-1/tailored/8/expired.tex",
        "pdf_file_path": "user-1/tailored/8/expired.pdf",
        "file_path": "user-1/tailored/8/expired.pdf",
        "storage_bucket": "cv-artifacts",
        "created_at": "2026-01-01T00:00:00Z",
        "expires_at": "2026-02-10T00:00:00Z",
        "artifacts_deleted_at": None,
    }
    client.rows.append(expired.copy())
    ai = FakeTailoredAI()
    monkeypatch.setattr("matching.tailored_cv.compile_latex", lambda source: b"%PDF-1.7 fake")
    result = generate_or_reuse_tailored_cv(
        client,
        user_id="user-1", cv_version_id=2, candidate_profile_id=7, job_id=8,
        title=JOB.title, company=JOB.company, description=JOB.description,
        source_url=JOB.source_url, location=None, remote_scope=None, ai_client=ai,
    )
    assert result["created"] is True
    assert result["cache_hit"] is False
    assert ai.calls == 1
    assert client.rows[0] == expired
    assert client.rows[1]["tailoring_fingerprint"] != current_fingerprint
