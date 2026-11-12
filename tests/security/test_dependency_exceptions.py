"""An exception must not hide another dependency, version, advisory or future risk."""
from copy import deepcopy
from datetime import date
import pytest
from scripts.security.check_code_dependencies import exception_matches

BASE = dict(manifest='cli/package.json', package='example', advisory='GHSA-example',
            affected_range='<2', locked_versions=['1.0'], expires='2026-12-11',
            reason='Reviewed unreachable parser; temporary exception.')
ADVISORY = dict(url='https://github.com/advisories/GHSA-example', vulnerable_versions='<2')


def matches(exc=BASE, **changes):
    args = dict(manifest='cli/package.json', package='example', advisory=ADVISORY,
                versions={'1.0'}, today=date(2026, 11, 11))
    args.update(changes)
    return exception_matches(exc, **args)


def test_exact_reviewed_exception():
    assert matches()


@pytest.mark.parametrize('changes', [dict(manifest='other/package.json'),
    dict(package='another'), dict(versions={'1.1'}), dict(versions={'1.0', '1.1'}),
    dict(today=date(2026, 12, 12)),
    dict(advisory=dict(url='https://github.com/advisories/GHSA-other', vulnerable_versions='<2')),
    dict(advisory=dict(url=ADVISORY['url'], vulnerable_versions='<3'))])
def test_exception_cannot_expand(changes):
    assert not matches(**changes)


def test_reason_required():
    exc = deepcopy(BASE)
    exc['reason'] = ''
    assert not matches(exc)
