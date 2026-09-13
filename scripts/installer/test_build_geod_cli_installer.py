"""Archive boundary and provenance tests; no installs, network or registry writes."""
import hashlib
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

from build_geod_cli_installer import package_files, validate_build_info


def fixture():
    binary = b'frozen-test-binary'
    return {'geod.exe': binary, 'LICENSE': b'license', 'README.txt': b'readme',
            'docs/geod-cli.md': b'docs', 'scripts/geod-render.mjs': b'script',
            'build-info.json': json.dumps({'name': 'geod-cli', 'version': '0.1.1',
                'platform': 'windows-x64', 'sourceRevision': 'a' * 40,
                'binarySha256': hashlib.sha256(binary).hexdigest()}).encode()}


class ArchiveValidation(unittest.TestCase):
    def check_archive(self, extras=(), prefix='package/', changes=None):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'payload.zip'
            files = fixture()
            files.update(changes or {})
            with zipfile.ZipFile(archive, 'w') as zf:
                for name, data in files.items():
                    zf.writestr(prefix + name, data)
                for name, data in extras:
                    zf.writestr(name, data)
            return package_files(archive)

    def test_nested_portable_round_trip(self):
        self.assertEqual(self.check_archive(), fixture())

    def test_flat_portable_round_trip(self):
        self.assertEqual(self.check_archive(prefix=''), fixture())

    def test_windows_zip_separators(self):
        files = self.check_archive(prefix='package\\')
        self.assertEqual(files, fixture())

    def test_rejects_traversal_and_windows_aliases(self):
        for name in ['../outside', '/absolute', 'C:/drive', 'package/../outside',
                     'package/./docs/x', 'package//docs/x', 'package/docs/x:stream',
                     'package/docs/nul.txt', 'package/docs/COM1', 'package/docs/x.',
                     'package/docs/x ', 'package/docs/a\n', 'package/docs/a?b']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check_archive([(name, b'bad')])

    def test_rejects_case_duplicate(self):
        with self.assertRaises(ValueError):
            self.check_archive([('package/GEOD.EXE', b'different')])

    def test_rejects_symlink(self):
        item = zipfile.ZipInfo('package/docs/link')
        item.create_system = 3
        item.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(ValueError):
            self.check_archive([(item, b'../../outside')])

    def test_rejects_uninstaller_and_runtime_state(self):
        for name in ['package/unins000.exe', 'package/.env', 'package/random.exe']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check_archive([(name, b'bad')])

    def test_provenance_exact_binary(self):
        self.assertEqual(validate_build_info(fixture())['sourceRevision'], 'a' * 40)
        files = fixture()
        files['geod.exe'] += b'mutated'
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            validate_build_info(files)

    def test_provenance_wrong_version_or_revision(self):
        for key, value in [('version', '0.1.0'), ('sourceRevision', 'HEAD')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                files = fixture()
                info = json.loads(files['build-info.json'])
                info[key] = value
                files['build-info.json'] = json.dumps(info).encode()
                validate_build_info(files)


if __name__ == '__main__':
    unittest.main()
