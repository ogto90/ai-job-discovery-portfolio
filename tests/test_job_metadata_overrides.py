from urllib.parse import parse_qs, urlparse

import pytest

from matching.candidate_profile import representative_profile
from matching.holistic_matcher import VerifiedJob, evaluation_fingerprint
from matching.job_metadata_overrides import (
    get_job_metadata_override,
    reset_job_metadata_override,
    resolve_effective_job_metadata,
    save_job_metadata_override,
    validate_metadata_override,
)
from matching.tailored_cv import build_tailoring_input, tailoring_fingerprint


class FakeOverrideClient:
    def __init__(self):
        self.rows = {}
        self.requests = []
        self.reads = []

    def get_json(self, path):
        self.reads.append(path)
        parsed = urlparse(path)
        query = parse_qs(parsed.query)
        user = query.get("user_id", ["eq.user-a"])[0].removeprefix("eq.")
        if "job_id" not in query:
            return [dict(row) for (owner, _), row in self.rows.items() if owner == user]
        job = int(query.get("job_id", ["eq.1"])[0].removeprefix("eq."))
        row = self.rows.get((user, job))
        return [dict(row)] if row else []

    def json_request(self, method, path, payload=None, *, prefer=None):
        self.requests.append((method, path, payload))
        parsed = urlparse(path)
        query = parse_qs(parsed.query)
        job = int(query.get("job_id", ["eq.1"])[0].removeprefix("eq."))
        user = query.get("user_id", [None])[0]
        user = user.removeprefix("eq.") if user else None
        key = (user, job)
        if method == "POST":
            user = payload["user_id"]
            job = int(payload["job_id"])
            key = (user, job)
            self.rows[key] = {"user_id": user, "job_id": job, "company_override": None, "title_override": None, **payload}
        elif method == "PATCH":
            self.rows[key].update(payload)
        elif method == "DELETE":
            row = self.rows.pop(key)
            return [row]
        return [dict(self.rows[key])]


def test_resolver_keeps_source_and_applies_user_specific_override_fields():
    source = resolve_effective_job_metadata("Swapcard", "Our Mission")
    assert (source.company, source.title) == ("Swapcard", "Our Mission")
    corrected = resolve_effective_job_metadata(
        "Swapcard", "Our Mission", {"title_override": "Senior Security Engineer"}
    )
    assert (corrected.source_company, corrected.source_title) == ("Swapcard", "Our Mission")
    assert (corrected.company, corrected.title) == ("Swapcard", "Senior Security Engineer")
    assert corrected.title_overridden
    assert not corrected.company_overridden
    # A different user's missing row resolves to the original shared metadata.
    assert resolve_effective_job_metadata("Swapcard", "Our Mission").title == "Our Mission"


def test_company_and_title_overrides_and_single_field_reset_preserve_other_field():
    client = FakeOverrideClient()
    assert save_job_metadata_override(client, user_id="user-a", job_id=9, field="title", value="  Security Lead ", current_value="Our Mission")
    assert save_job_metadata_override(client, user_id="user-a", job_id=9, field="company", value="Acme Corp", current_value="Unknown company")
    assert not save_job_metadata_override(client, user_id="user-a", job_id=9, field="company", value="Acme Corp", current_value="Acme Corp")
    current = get_job_metadata_override(client, user_id="user-a", job_id=9)
    effective = resolve_effective_job_metadata("Unknown company", "Our Mission", current)
    assert (effective.company, effective.title) == ("Acme Corp", "Security Lead")
    assert get_job_metadata_override(client, user_id="user-b", job_id=9) is None
    assert reset_job_metadata_override(client, user_id="user-a", job_id=9, field="company")
    current = get_job_metadata_override(client, user_id="user-a", job_id=9)
    assert current["company_override"] is None
    assert current["title_override"] == "Security Lead"
    assert reset_job_metadata_override(client, user_id="user-a", job_id=9, field="title")
    assert get_job_metadata_override(client, user_id="user-a", job_id=9) is None
    assert all("user_id=eq.user-a" in call[1] for call in client.requests if call[0] in {"PATCH", "DELETE"})


@pytest.mark.parametrize("value", ["", "  \t", "first\nsecond", "x" * 181])
def test_override_validation_rejects_blank_multiline_and_overlong_values(value):
    with pytest.raises(ValueError):
        validate_metadata_override("title", value)


def test_override_validation_trims_and_preserves_normal_punctuation():
    assert validate_metadata_override("company", "  Acme, Inc.  ") == "Acme, Inc."


def test_bulk_override_loader_is_user_scoped_and_reads_rows_in_one_request():
    client = FakeOverrideClient()
    client.rows[("user-a", 11)] = {"user_id": "user-a", "job_id": 11, "company_override": "Acme", "title_override": None}
    client.rows[("user-b", 12)] = {"user_id": "user-b", "job_id": 12, "company_override": None, "title_override": "Security Lead"}
    from matching.job_metadata_overrides import load_job_metadata_overrides

    loaded = load_job_metadata_overrides(client, user_id="user-a")
    assert list(loaded) == [11]
    assert len(client.reads) == 1
    assert "user_id=eq.user-a" in client.reads[0]


def test_company_does_not_change_fit_or_tailoring_fingerprint_but_title_does():
    profile = representative_profile()
    base = VerifiedJob(
        title="Security Engineer", company="Original Co", description="Build security systems.",
        source_url="https://example.test/job/1",
    )
    changed_company = base.model_copy(update={"company": "Corrected Co"})
    changed_title = base.model_copy(update={"title": "Security Lead"})
    fit = evaluation_fingerprint(candidate_profile=profile, job=base)
    assert fit == evaluation_fingerprint(candidate_profile=profile, job=changed_company)
    assert fit != evaluation_fingerprint(candidate_profile=profile, job=changed_title)

    base_input = build_tailoring_input(base_cv_text="base latex", candidate_profile=profile, job=base)
    company_input = build_tailoring_input(base_cv_text="base latex", candidate_profile=profile, job=changed_company)
    title_input = build_tailoring_input(base_cv_text="base latex", candidate_profile=profile, job=changed_title)
    base_fingerprint = tailoring_fingerprint(tailoring_input=base_input, source_cv_version_id=2)
    assert base_fingerprint == tailoring_fingerprint(tailoring_input=company_input, source_cv_version_id=2)
    assert base_fingerprint != tailoring_fingerprint(tailoring_input=title_input, source_cv_version_id=2)
