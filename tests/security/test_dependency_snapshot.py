"""Fail closed rather than publishing incomplete or misleading dependency data."""
import importlib.util
from importlib.metadata import PackageNotFoundError
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[2] / 'scripts/security/dependency_snapshot.py'
spec = importlib.util.spec_from_file_location('dependency_snapshot', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SnapshotTests(unittest.TestCase):
    def test_includes_patched_and_still_vulnerable_packages(self):
        versions = {'opentelemetry-api': '1.45.2', 'mcp': '1.29.0'}
        result = module.resolved_packages(
            '# generated\nopentelemetry-api==1.45.2 \\\n'
            ' --hash=sha256:' + 'a' * 64 + '\nmcp==1.29.0\n', versions.__getitem__)
        self.assertEqual(set(result), set(versions))
        self.assertEqual(result['opentelemetry-api']['package_url'], 'pkg:pypi/opentelemetry-api@1.45.2')
        self.assertEqual(result['mcp']['package_url'], 'pkg:pypi/mcp@1.29.0')

    def test_rejects_version_mismatch(self):
        with self.assertRaises(ValueError):
            module.resolved_packages('opentelemetry-api==1.45.2', lambda _: '1.37.0')

    def test_rejects_empty_duplicate_and_unsupported_inputs(self):
        for text in ['', '# only comments', 'mcp>=1.29', '-r other.txt',
                     'mcp==1.29.0\nmcp==1.29.0', 'mcp==1.29.0; python_version > "3"']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                module.resolved_packages(text, lambda _: '1.29.0')

    def test_missing_package_is_not_silently_omitted(self):
        def missing(_):
            raise PackageNotFoundError('mcp')
        with self.assertRaises(PackageNotFoundError):
            module.resolved_packages('mcp==1.29.0', missing)


if __name__ == '__main__':
    unittest.main()
