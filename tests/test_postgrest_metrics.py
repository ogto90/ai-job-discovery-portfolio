import io
import json
import logging
from urllib.error import HTTPError, URLError

import pytest

from matching import candidate_profile_persistence as persistence
from matching import postgrest_metrics as metrics
from scripts.postgrest_egress_report import aggregate


def test_client_records_bytes_once_without_private_data(monkeypatch):
    output = io.StringIO()
    monkeypatch.setattr(metrics._LOGGER, 'handlers', [logging.StreamHandler(output)])
    body = '私密 profile'.encode()

    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self): return body

    monkeypatch.setattr(persistence, 'urlopen', lambda *_args, **_kwargs: Response())
    client = persistence.SupabaseRestClient('https://private-project.example', 'secret-key')
    assert client.request('GET', '/rest/v1/jobs?user_id=eq.private-user')[1] == body
    row = json.loads(output.getvalue())
    assert row['response_body_bytes'] == len(body)
    assert row['endpoint'] == '/rest/v1/jobs'
    assert row['operation'] == 'read'
    assert all(secret not in output.getvalue() for secret in ['私密', 'private-user', 'private-project', 'secret-key'])
    assert aggregate(output.getvalue().splitlines())[0]['requests'] == 1


def test_errors_and_empty_responses_are_measured_without_logging_error_content(monkeypatch):
    output = io.StringIO()
    monkeypatch.setattr(metrics._LOGGER, 'handlers', [logging.StreamHandler(output)])
    def fail(*_args, **_kwargs):
        raise HTTPError('https://private.example', 403, 'Forbidden', {}, io.BytesIO(b'private-error'))
    monkeypatch.setattr(persistence, 'urlopen', fail)
    client = persistence.SupabaseRestClient('https://private.example', 'secret')
    with pytest.raises(persistence.PersistenceError):
        client.request('GET', '/rest/v1/jobs?token=secret')
    def network_fail(*_args, **_kwargs): raise URLError('private-host')
    monkeypatch.setattr(persistence, 'urlopen', network_fail)
    with pytest.raises(persistence.PersistenceError):
        client.request('GET', '/rest/v1/jobs')
    metrics.record_response('PATCH', '/rest/v1/jobs?id=eq.private', 204, 0)
    rows = [json.loads(line) for line in output.getvalue().splitlines()]
    assert [row['response_body_bytes'] for row in rows] == [13, 0, 0]
    assert [row['status'] for row in rows] == [403, 0, 204]
    assert 'private' not in output.getvalue() and 'secret' not in output.getvalue()
    report = aggregate(['unrelated log', *output.getvalue().splitlines()])
    assert sum(row['requests'] for row in report) == 3
    assert sum(row['errors'] for row in report) == 2
