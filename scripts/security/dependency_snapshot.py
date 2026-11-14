"""Describe every locked security-tool package, verifying installed versions."""
from datetime import datetime, timezone
from importlib.metadata import version
import argparse
import json
from pathlib import Path
import re
from urllib.parse import quote

from packaging.utils import canonicalize_name
from packaging.version import Version

MANIFEST = 'security/requirements.txt'
CORRELATOR = 'pairrole-security-tools'


def resolved_packages(text, installed_version=version):
    resolved = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if re.fullmatch(r'--hash=sha256:[a-f0-9]{64}(?:\s+\\)?', line):
            continue
        match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([^\s;]+)(?:\s+\\)?', line)
        if not match:
            raise ValueError(f'Unsupported lock entry: {line}')
        name, pinned = canonicalize_name(match[1]), match[2]
        if name in resolved:
            raise ValueError(f'Duplicate locked package: {name}')
        if Version(installed_version(name)) != Version(pinned):
            raise ValueError(f'Installed version does not match lock: {name}')
        resolved[name] = {
            'package_url': f'pkg:pypi/{name}@{quote(pinned, safe="")}',
            'relationship': 'direct',  # Every package is explicitly pinned in this manifest.
            'scope': 'development',
        }
    if not resolved:
        raise ValueError('Refusing an empty dependency snapshot')
    return resolved


def snapshot(root, sha, run_id, repository):
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('Expected the checked-out commit SHA')
    return {
        'version': 0, 'sha': sha, 'ref': 'refs/heads/main',
        'job': {'id': run_id, 'correlator': CORRELATOR},
        'detector': {'name': CORRELATOR, 'version': '1.0.0',
                     'url': f'https://github.com/{repository}'},
        'scanned': datetime.now(timezone.utc).isoformat(),
        'manifests': {MANIFEST: {
            'name': MANIFEST, 'file': {'source_location': MANIFEST},
            'resolved': resolved_packages((root / MANIFEST).read_text()),
        }},
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--repository', required=True)
    args = parser.parse_args()
    print(json.dumps(snapshot(Path(__file__).resolve().parents[2],
                              args.sha, args.run_id, args.repository)))
