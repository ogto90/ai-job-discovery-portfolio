"""Fail-closed source and dependency checks; no application credentials required."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / '.diagnostics' / 'code-dependencies'


def run(args, cwd=ROOT, allowed=(0,)):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=600)
    if result.returncode not in allowed:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}):\n{result.stdout}\n{result.stderr}')
    return result


def tracked(pattern):
    return run(['git', 'ls-files', '-z', pattern]).stdout.rstrip('\0').split('\0')


def source_files():
    return [p for p in tracked('*') if p.endswith(('.py', '.ts', '.tsx', '.js'))
            and 'tests' not in Path(p).parts and not Path(p).name.startswith('test_')]


def scan(paths, report):
    report.unlink(missing_ok=True)
    result = run(['semgrep', 'scan', '--config', str(ROOT / 'security/semgrep.yml'),
                  '--metrics=off', '--disable-version-check', '--disable-nosem',
                  '--no-git-ignore', '--strict', '--error', '--json', '--output', str(report),
                  *map(str, paths)], allowed=(0, 1))
    data = json.loads(report.read_text())
    if data.get('errors') or not data.get('paths', {}).get('scanned'):
        raise RuntimeError('Static analysis incomplete: ' + str(data.get('errors')))
    if result.returncode == 1 and not data['results']:
        raise RuntimeError('Scanner failed without findings')
    return data


def static():
    paths = source_files()
    if not paths:
        raise RuntimeError('No tracked source files')
    data = scan(paths, REPORTS / 'semgrep.json')
    scanned = {str(Path(p).resolve()) for p in data['paths']['scanned']}
    missing = {str((ROOT / p).resolve()) for p in paths} - scanned
    if missing:
        raise RuntimeError(f'Source files not scanned: {sorted(missing)}')
    if data['results']:
        for finding in data['results']:
            print(f"{finding['check_id']}: {finding['path']}:{finding['start']['line']}")
        raise RuntimeError('Static analysis findings require review')
    print(f'Static analysis: {len(paths)} tracked source files; zero findings.')


def python_audit(requirements, report):
    report.unlink(missing_ok=True)
    result = run(['pip-audit', '-r', str(requirements), '--require-hashes', '--disable-pip',
                  '--progress-spinner', 'off', '-f', 'json', '-o', str(report)], allowed=(0, 1))
    data = json.loads(report.read_text())
    deps = data.get('dependencies')
    if not deps or any('skip_reason' in d or 'vulns' not in d for d in deps):
        raise RuntimeError('Python audit is empty or incomplete')
    findings = [(d['name'], d['version'], v['id']) for d in deps for v in d['vulns']]
    if result.returncode != bool(findings):
        raise RuntimeError('Python audit exit status disagrees with report')
    return findings


def exception_matches(exc, manifest, package, advisory, versions, today):
    return (exc['manifest'] == manifest and exc['package'] == package
            and exc['advisory'] == advisory['url'].rsplit('/', 1)[-1]
            and exc['affected_range'] == advisory['vulnerable_versions']
            and set(exc['locked_versions']) == versions
            and dt.date.fromisoformat(exc['expires']) >= today
            and bool(exc['reason'].strip()))


def dependencies():
    import json5
    exceptions = json.loads((ROOT / 'security/dependency-exceptions.json').read_text())
    today = dt.datetime.now(dt.timezone.utc).date()
    if any(dt.date.fromisoformat(e['expires']) < today for e in exceptions):
        raise RuntimeError('Expired dependency exception; review required')
    findings = []
    py_exceptions = json.loads((ROOT / 'security/python-dependency-exceptions.json').read_text())
    py_used = set()
    for name in ['requirements-lock.txt', 'security/requirements.txt']:
        for package, version, advisory in python_audit(ROOT / name, REPORTS / (Path(name).stem + '-audit.json')):
            matches = [i for i, e in enumerate(py_exceptions)
                       if (e['manifest'], e['package'], e['version'], e['advisory'])
                       == (name, package, version, advisory)
                       and dt.date.fromisoformat(e['expires']) >= today and e['reason'].strip()]
            if matches:
                py_used.update(matches)
                print(f'Reviewed tool exception: {name}: {package}=={version}: {advisory}')
            else:
                findings.append((name, package, version, advisory))
    if py_used != set(range(len(py_exceptions))):
        raise RuntimeError('Expired or stale Python dependency exception; review required')
    manifests = tracked('*package.json')
    used = set()
    for manifest in manifests:
        folder = ROOT / Path(manifest).parent
        lock = folder / 'bun.lock'
        if not lock.is_file():
            raise RuntimeError(f'Missing lockfile for {manifest}')
        run(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], cwd=folder)
        result = run(['bun', 'audit', '--json'], cwd=folder, allowed=(0, 1))
        data = json.loads(result.stdout)
        if not isinstance(data, dict) or result.returncode != bool(data):
            raise RuntimeError(f'Invalid Bun audit response for {manifest}')
        (REPORTS / (folder.parent.name + '-audit.json')).write_text(json.dumps(data, indent=2))
        packages = json5.loads(lock.read_text())['packages']
        for package, advisories in data.items():
            versions = {entry[0][len(package) + 1:] for entry in packages.values()
                        if entry[0].startswith(package + '@')}
            if not versions or not isinstance(advisories, list) or not advisories:
                raise RuntimeError('Unrecognized Bun advisory data')
            for advisory in advisories:
                matches = [i for i, e in enumerate(exceptions)
                           if exception_matches(e, manifest, package, advisory, versions, today)]
                if matches:
                    used.update(matches)
                    print(f"Reviewed exception: {manifest}: {package}: {advisory['url']}")
                else:
                    findings.append((manifest, package, advisory['url']))
    if used != set(range(len(exceptions))):
        raise RuntimeError('Stale dependency exception; remove or re-review it')
    if findings:
        raise RuntimeError(f'Unreviewed dependency findings: {findings}')
    print(f'Dependency audit: two Python locks and {len(manifests)} Bun locks; '
          f'{len(used) + len(py_used)} exact, unexpired exceptions; zero unreviewed findings.')


def canaries():
    # These vulnerable snippets are parsed, never executed or imported.
    with tempfile.TemporaryDirectory(prefix='security-canary-') as tmp:
        folder = Path(tmp)
        py = folder / 'canary.py'
        py.write_text('import subprocess, ssl, pickle\neval(user_input)\n'
                      'subprocess.run(user_input, shell=True)\n'
                      'ssl._create_unverified_context()\npickle.loads(user_input)\n')
        ts = folder / 'canary.ts'
        ts.write_text('import * as child_process from "node:child_process";\n'
                      'eval(userInput);\nchild_process.exec(userInput);\n'
                      'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";\n')
        data = scan([py, ts], REPORTS / 'static-canary.json')
        expected = {'python-dynamic-code', 'python-shell-command', 'python-disabled-tls',
                    'python-unsafe-deserialization', 'javascript-dynamic-code',
                    'javascript-shell-command', 'javascript-disabled-tls'}
        found = {r['check_id'].rsplit('.', 1)[-1] for r in data['results']}
        if not expected <= found:
            raise RuntimeError(f'Static canaries missed: {expected - found}')
        py.write_text('import subprocess\nsubprocess.run(["echo", user_input], shell=False)\n')
        ts.write_text('import { spawn } from "node:child_process";\nspawn("echo", [userInput]);\n')
        if scan([py, ts], REPORTS / 'safe-canary.json')['results']:
            raise RuntimeError('Safe argument-vector canary incorrectly rejected')
        # Audits metadata only: the vulnerable wheel is never installed or executed.
        req = folder / 'requirements.txt'
        req.write_text((ROOT / 'security/fixtures/urllib3-vulnerable-canary.lock').read_text())
        findings = python_audit(req, REPORTS / 'dependency-canary.json')
        if not any(name == 'urllib3' for name, _, _ in findings):
            raise RuntimeError('Known vulnerable dependency was not rejected')
    print('Canaries: all seven source rules reject unsafe code; safe code passes; '
          'known vulnerable dependency rejected.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('suite', choices=['static', 'dependencies', 'canaries'])
    args = parser.parse_args()
    REPORTS.mkdir(parents=True, exist_ok=True)
    try:
        globals()[args.suite]()
    except (RuntimeError, ValueError, KeyError, OSError, subprocess.TimeoutExpired) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
