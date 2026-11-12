from types import SimpleNamespace

import pytest

from ui.manual_jd import ManualJDValidationError
from ui.manual_job import create_or_reuse_manual_job, manual_metadata


JD = """Lead Security Engineer

About Acme Security. Build security programs, lead incident response, and partner with engineering teams to improve secure delivery across the company.

Responsibilities include setting security priorities, managing vulnerability remediation, supporting governance and risk activities, advising product teams, and improving security awareness. The role collaborates with engineering, IT, and business stakeholders across the organization."""


class FakeManualClient:
    def __init__(self):
        self.rows = []
        self.posts = []
        self.reads = []

    def get_json(self, path):
        if "/jobs?" in path:
            self.reads.append(path)
            return self.rows
        raise AssertionError(path)

    def json_request(self, method, path, payload=None, *, prefer=None):
        self.posts.append((method, path, payload))
        if method == "POST":
            row = {"id": len(self.rows) + 1, **payload}
            self.rows.append(row)
            return [row]
        raise AssertionError(method)


def test_metadata_preserves_supplied_values_and_has_conservative_fallbacks():
    assert manual_metadata(JD, title="  Security Lead  ", company=" Acme ") == ("Security Lead", "Acme")
    assert manual_metadata(JD) == ("Lead Security Engineer", "Acme Security")


def test_manual_metadata_does_not_parse_page_headings_as_company_or_title():
    text = "ABOUT US\n\nPliant is a modular payment platform.\n\nAbout the Role\n\nWe need a Security Engineer."
    assert manual_metadata(text) == ("Manual listing", "Pliant")
    assert manual_metadata("About the Role\n\nResponsibilities follow.") == ("Manual listing", "Unknown company")
    assert manual_metadata("Our Mission\n\nSwapcard is an event platform.") == ("Manual listing", "Swapcard")


def test_manual_job_is_created_with_private_owner_and_full_jd():
    client = FakeManualClient()
    row, created = create_or_reuse_manual_job(
        client, user_id="user-1", jd_text=JD, title="Lead Security Engineer",
        company="Acme Security", listing_url="https://example.test/job",
    )
    assert created is True
    assert row["source"] == "manual"
    assert row["manual_owner_user_id"] == "user-1"
    assert row["description_kind"] == "full"
    assert row["application_url"] == "https://example.test/job"
    assert "review_status" not in client.posts[0][2]
    assert len(client.posts) == 1


def test_identical_manual_jd_reuses_existing_private_job():
    client = FakeManualClient()
    params = {
        "user_id": "user-1", "jd_text": JD, "title": "Lead Security Engineer",
        "company": "Acme Security", "listing_url": "https://example.test/job",
    }
    first, _ = create_or_reuse_manual_job(client, **params)
    second, created = create_or_reuse_manual_job(client, **params)
    assert created is False
    assert second["id"] == first["id"]
    assert len(client.posts) == 1


def test_same_jd_has_separate_user_scoped_identity():
    client = FakeManualClient()
    create_or_reuse_manual_job(
        client, user_id="user-1", jd_text=JD, title="Lead Security Engineer",
        company="Acme Security", listing_url="https://example.test/job",
    )
    # The fake returns only its own query result, mirroring the repository's
    # user-filtered query contract.
    client.rows = []
    second, created = create_or_reuse_manual_job(
        client, user_id="user-2", jd_text=JD, title="Lead Security Engineer",
        company="Acme Security", listing_url="https://example.test/job",
    )
    assert created is True
    assert second["manual_owner_user_id"] == "user-2"


def test_empty_or_tiny_jd_is_rejected_before_write():
    with pytest.raises(ManualJDValidationError):
        create_or_reuse_manual_job(
            FakeManualClient(), user_id="user-1", jd_text="too short",
            title="Lead Security Engineer", company="Acme Security",
            listing_url="https://example.test/job",
        )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("title", "   ", "job title"),
        ("company", "   ", "company name"),
        ("listing_url", "   ", "listing URL"),
        ("listing_url", "ftp://example.test/job", "http:// or https://"),
    ],
)
def test_manual_job_requires_all_fields_before_any_supabase_request(field, value, message):
    client = FakeManualClient()
    params = {
        "user_id": "user-1", "jd_text": JD, "title": "Lead Security Engineer",
        "company": "Acme Security", "listing_url": "https://example.test/job",
    }
    params[field] = value
    with pytest.raises(ValueError, match=message):
        create_or_reuse_manual_job(client, **params)
    assert client.reads == []
    assert client.posts == []
