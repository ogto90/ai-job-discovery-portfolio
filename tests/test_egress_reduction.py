from types import SimpleNamespace

import ui.dashboard as dashboard


def test_rebuild_profile_cache_reuses_revision_and_isolates_user_and_project(monkeypatch):
    reads = []

    def load(client, user):
        reads.append((client.base_url, user))
        return SimpleNamespace(user_id=user, id=12, storage_bucket='cv'), 13, None, None

    monkeypatch.setattr(dashboard, '_load_dashboard_profile_context', load)
    cache = {}
    client = SimpleNamespace(base_url='https://one.example')
    def read(user='user-a', revision=1):
        return dashboard._load_dashboard_context_rows(
            client, user, job_ids=set(), ui_state={}, summary_only=True,
            profile_cache=cache, profile_revision=revision,
        )
    assert read() == read()
    assert len(reads) == 1
    read(revision=2)
    read(user='user-b', revision=2)
    client.base_url = 'https://two.example'
    read(user='user-b', revision=2)
    assert len(reads) == 4
    assert len(cache) == 1
    # A separate rebuild does not inherit data from a previous run.
    cache.clear()
    read(user='user-b', revision=2)
    assert len(reads) == 5


def test_assessment_lists_exclude_details_and_detail_read_is_scoped():
    from urllib.parse import parse_qs, urlsplit
    from ui.dashboard_summary import load_assessment_detail
    calls = []

    class Client:
        def get_json(self, path):
            params = parse_qs(urlsplit(path).query)
            calls.append(params)
            if params['select'] == ['strengths,gaps']:
                return [{'strengths': ['Evidence'], 'gaps': ['Gap']}]
            if params['select'] == ['strengths,gaps,job_snapshot']:
                return [{'strengths': [], 'gaps': [], 'job_snapshot': {'description': 'large'}}]
            return [{'id': 12, 'job_id': 7, 'fit_score': 80}]

    client = Client()
    rows = dashboard._load_current_assessments(client, {'user_id': 'eq.owner'})
    assert rows[0]['fit_score'] == 80
    assert not {'strengths', 'gaps', 'job_snapshot'} & set(calls[0]['select'][0].split(','))
    result = load_assessment_detail(client, user_id='owner', job_id=7, assessment_id=12)
    assert result == {'fit_strengths': ('Evidence',), 'fit_gaps': ('Gap',)}
    assert calls[-1]['user_id'] == ['eq.owner']
    assert calls[-1]['job_id'] == ['eq.7']
    assert calls[-1]['id'] == ['eq.12']
    assert calls[-1]['limit'] == ['1']
    assert load_assessment_detail(client, user_id='owner', job_id=7, assessment_id=12,
                                  include_snapshot=True)['fit_job_snapshot'] == {'description': 'large'}
    count = len(calls)
    assert load_assessment_detail(client, user_id='owner', job_id=7, assessment_id=None) == {}
    assert len(calls) == count
