"""Validate the narrow Semgrep override and patched trace-header parsing."""
from importlib.metadata import distributions, version
from pathlib import Path
import subprocess
import sys

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parents[2]


def check_dependencies():
    overrides = {
        canonicalize_name(req.name): req
        for raw_line in (ROOT / 'security/overrides.txt').read_text().splitlines()
        if (line := raw_line.strip()) and not line.startswith('#')
        for req in [Requirement(line)]
    }
    if version('semgrep') != '1.185.0':
        raise RuntimeError('Revalidate or remove telemetry overrides before changing Semgrep.')
    for name, override in overrides.items():
        if not override.specifier.contains(version(name), prereleases=True):
            raise RuntimeError(f'Unexpected override version: {name}')
    for dist in distributions():
        for raw in dist.requires or []:
            req = Requirement(raw)
            if req.marker and not req.marker.evaluate({'extra': ''}):
                continue
            name = canonicalize_name(req.name)
            installed = version(req.name)  # Missing distributions fail closed.
            if req.specifier.contains(installed, prereleases=True):
                continue
            if canonicalize_name(dist.metadata['Name']) == 'semgrep' and name in overrides:
                continue
            raise RuntimeError(f'Unexpected dependency conflict: {dist.metadata["Name"]}: {raw}')


def check_parsing():
    # A separate process bounds CPU time even if a vulnerable parser returns.
    code = r'''
import logging
logging.disable(logging.CRITICAL)
from opentelemetry.trace import get_current_span
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
p = TraceContextTextMapPropagator()
valid = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
def context(carrier):
    return get_current_span(p.extract(carrier)).get_span_context()
good = context({'traceparent': valid, 'tracestate': 'vendor=value'})
assert good.is_valid and good.trace_state.get('vendor') == 'value'
for whitespace in (' ', '\t'):
    # CVE-2026-114603: unbounded tracestate regex processing.
    state = context({'traceparent': valid, 'tracestate': 'a=b' + whitespace * 100_000 + 'x'})
    assert state.is_valid and len(state.trace_state) == 0
    # CVE-2026-126360: newline-preserving traceparent carrier.
    parent = context({'traceparent': valid + '-' + whitespace * 100_000 + '\nx'})
    assert not parent.is_valid
'''
    subprocess.run([sys.executable, '-c', code], check=True, timeout=5)


if __name__ == '__main__':
    check_dependencies()
    check_parsing()
    print('Telemetry dependency compatibility and both parsing regressions passed.')
