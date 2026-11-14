"""Check Python inputs against their committed, hash-verified dependency closure."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def normalized(text):
    return '\n'.join(line.rstrip() for line in text.splitlines()
                     if line.strip() and not line.lstrip().startswith('#'))


for source, lock in [('requirements.txt', 'requirements-lock.txt'),
                     ('security/requirements.in', 'security/requirements.txt')]:
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / 'resolved.txt'
        subprocess.run(['uv', 'pip', 'compile', source, '--constraint', lock,
                        *(['--override', 'security/overrides.txt'] if source.startswith('security/') else []),
                        '--python-version', '3.12', '--generate-hashes', '--no-header',
                        '--no-annotate', '--output-file', str(output)],
                       cwd=ROOT, check=True, timeout=300, stdout=subprocess.DEVNULL)
        if normalized(output.read_text()) != normalized((ROOT / lock).read_text()):
            raise SystemExit(f'{lock} is stale; regenerate and review it')
print('Both Python dependency closures match their inputs and committed hashes.')
