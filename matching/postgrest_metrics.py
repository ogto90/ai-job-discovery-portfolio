"""Content-free response-body measurements, not Supabase billing counters."""
from datetime import datetime, timezone
import json
import logging
import re
from threading import Lock

_LOGGER = logging.getLogger('ai_job_search.postgrest_metrics')
if not _LOGGER.handlers:
    _LOGGER.addHandler(logging.StreamHandler())
_LOGGER.setLevel(logging.INFO)
_LOGGER.propagate = False
_LOCK = Lock()
_TOTALS: dict[tuple[str, str], dict[str, int]] = {}


def record_response(method: str, path: str, status: int, response_bytes: int) -> None:
    """Exclude filters, IDs, hosts, headers and response content from telemetry."""
    endpoint = path.partition('?')[0]
    if not endpoint.startswith('/rest/v1/'):
        return
    if not re.fullmatch(r'/rest/v1/(?:rpc/)?[a-z_][a-z0-9_]{0,62}', endpoint):
        endpoint = '/rest/v1/other'
    method = method.upper() if method.upper() in {'GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'} else 'OTHER'
    operation = 'rpc' if '/rpc/' in endpoint else {'GET': 'read', 'POST': 'insert', 'PATCH': 'update', 'DELETE': 'delete'}.get(method, 'other')
    with _LOCK:
        key = (endpoint, method)
        if key not in _TOTALS and len(_TOTALS) >= 128:
            key = ('/rest/v1/other', 'OTHER')
        totals = _TOTALS.setdefault(key, {'requests': 0, 'response_body_bytes': 0, 'errors': 0})
        totals['requests'] += 1
        totals['response_body_bytes'] += response_bytes
        totals['errors'] += int(status == 0 or status >= 400)
    _LOGGER.info(json.dumps({
        'event': 'postgrest_response', 'runtime': 'python',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'endpoint': endpoint, 'method': method, 'operation': operation,
        'status': status, 'requests': 1, 'response_body_bytes': response_bytes,
    }, separators=(',', ':')))


def response_totals() -> list[dict]:
    """Process-local counters for diagnostics; resets when the process restarts."""
    with _LOCK:
        return [{'endpoint': endpoint, 'method': method, **values}
                for (endpoint, method), values in sorted(_TOTALS.items())]
