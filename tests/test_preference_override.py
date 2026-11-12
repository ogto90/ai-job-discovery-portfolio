from urllib.parse import parse_qs, urlparse

import pytest

from ui.preference_override import load_preference_overrides, remove_preference_override, save_preference_override


class FakeClient:
    def __init__(self):
        self.reads = []
        self.writes = []

    def get_json(self, path):
        self.reads.append(path)
        return []

    def json_request(self, method, path, payload=None, *, prefer=None):
        self.writes.append((method, path, payload, prefer))
        return None


def test_override_reads_are_user_scoped_and_batched_at_50_ids():
    client = FakeClient()
    load_preference_overrides(client, user_id="user-a", job_ids=range(1, 102))
    assert len(client.reads) == 3
    assert all(parse_qs(urlparse(path).query)["user_id"] == ["eq.user-a"] for path in client.reads)
    assert [len(parse_qs(urlparse(path).query)["job_id"][0][4:-1].split(",")) for path in client.reads] == [50, 50, 1]


def test_override_write_is_per_user_and_validates_selected_fields():
    client = FakeClient()
    save_preference_override(
        client, user_id="user-a", job_id=12,
        fields=["role", "location", "work_model", "not-a-preference"],
    )
    method, path, payload, prefer = client.writes[-1]
    assert method == "POST"
    assert path.endswith("?on_conflict=user_id,job_id")
    assert payload["user_id"] == "user-a"
    assert payload["job_id"] == 12
    assert payload["overridden_preferences"] == ["location", "role"]
    assert prefer == "resolution=merge-duplicates,return=minimal"
    with pytest.raises(ValueError):
        save_preference_override(client, user_id="user-a", job_id=12, fields=["unknown"])


def test_override_removal_is_scoped_to_one_user_and_job():
    client = FakeClient()
    remove_preference_override(client, user_id="user-b", job_id=42)
    method, path, payload, _ = client.writes[-1]
    query = parse_qs(urlparse(path).query)
    assert method == "PATCH"
    assert query == {"user_id": ["eq.user-b"], "job_id": ["eq.42"]}
    assert payload["is_active"] is False
