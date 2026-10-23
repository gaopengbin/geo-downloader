import base64
import hashlib
import io
import json
import tarfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import npm_release as release


def package(extra=None, **overrides):
    binary = b'MZ-test-executable'
    meta = {'name': 'geod-cli', 'version': '0.3.4', 'os': ['win32'], 'cpu': ['x64'],
            'repository': {'url': 'git+https://github.com/gaopengbin/geo-downloader.git'}, **overrides}
    files = {'package/package.json': json.dumps(meta).encode(), 'package/native/geod.exe': binary,
             'package/build-info.json': json.dumps({'version': '0.3.4', 'binarySha256': hashlib.sha256(binary).hexdigest()}).encode()}
    files.update(extra or {})
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w:gz') as archive:
        for name, content in files.items():
            member = tarfile.TarInfo(name); member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
    return out.getvalue()


class ReleaseTests(unittest.TestCase):
    def check(self, data, **kwargs):
        return release.inspect_package(data, kwargs.get('name', 'geod-cli'), kwargs.get('version', '0.3.4'),
                                       kwargs.get('sha', hashlib.sha256(data).hexdigest()))

    def test_valid_package(self):
        self.assertEqual(self.check(package())['version'], '0.3.4')

    def test_wrong_checksum(self):
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            self.check(package(), sha='0' * 64)

    def test_wrong_name_or_version(self):
        for meta in ({'name': 'other'}, {'version': '9.9.9'}):
            with self.subTest(meta=meta), self.assertRaisesRegex(ValueError, 'name/version'):
                self.check(package(**meta))

    def test_path_escape(self):
        for name in ('package/../../outside', '/package/absolute', 'package/..\\outside'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'Unsafe'):
                self.check(package({name: b'x'}))

    def test_install_script(self):
        with self.assertRaisesRegex(ValueError, 'hooks'):
            self.check(package(scripts={'postinstall': 'anything'}))

    def test_wrong_repo(self):
        with self.assertRaisesRegex(ValueError, 'repository'):
            self.check(package(repository={'url': 'git+https://github.com/other/repo.git'}))

    def test_replaced_native_binary(self):
        with self.assertRaisesRegex(ValueError, 'metadata mismatch'):
            self.check(package({'package/native/geod.exe': b'MZ-replaced'}))

    def test_tags(self):
        self.assertEqual(release.parse_tag('geod-mcp-v0.1.8'), ('geod-mcp', '0.1.8'))
        for value in ('v3.6.17', 'geod-cli-v1.0.0/other', '${{bad}}'):
            with self.assertRaises(ValueError):
                release.parse_tag(value)

    def test_checksums_exact_unique(self):
        checksum = 'a' * 64
        line = checksum + '  geod-cli-0.3.4.tgz\n'
        self.assertEqual(release.checksum_for(line, 'geod-cli-0.3.4.tgz'), checksum)
        for text in (line + line, checksum + '  different.tgz', 'bad  geod-cli-0.3.4.tgz'):
            with self.assertRaises(ValueError):
                release.checksum_for(text, 'geod-cli-0.3.4.tgz')

    def test_existing_version_must_be_identical(self):
        candidate = self.check(package())
        release.compare_registry(candidate, {'dist': {'integrity': candidate['integrity'], 'shasum': candidate['sha1']}})
        with self.assertRaisesRegex(ValueError, 'refusing'):
            release.compare_registry(candidate, {'dist': {'integrity': 'other', 'shasum': candidate['sha1']}})

    def test_registry_failure_not_misread_as_missing(self):
        for status in (401, 403, 429, 500):
            with self.subTest(status=status), patch.object(release, 'read_url', side_effect=HTTPError('url', status, '', {}, None)):
                with self.assertRaises(HTTPError):
                    release.registry_version({'name': 'geod-cli', 'version': '0.3.4'})
        with patch.object(release, 'read_url', side_effect=HTTPError('url', 404, '', {}, None)):
            self.assertIsNone(release.registry_version({'name': 'geod-cli', 'version': '0.3.4'}))


if __name__ == '__main__':
    unittest.main()
