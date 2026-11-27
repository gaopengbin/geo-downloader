import struct
import unittest

from check_windows_release_payload import verify_payload


class WindowsPayloadTest(unittest.TestCase):
    def test_only_accepts_the_tested_amd64_executable_with_nsis_bundle_marker(self):
        header = bytearray(128)
        header[:2] = b"MZ"
        struct.pack_into("<I", header, 60, 80)
        header[80:86] = b"PE\x00\x00\x64\x86"
        build = bytes(header) + b"__TAURI_BUNDLE_TYPE_VAR_UNK" + b"test content"
        packaged = build.replace(b"VAR_UNK", b"VAR_NSS")
        self.assertEqual(verify_payload(build, packaged), verify_payload(packaged, packaged))
        for wrong in (build, packaged[:-1], packaged.replace(b"test", b"next"), packaged + b"__TAURI_BUNDLE_TYPE_VAR_NSS"):
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                verify_payload(build, wrong)
        with self.assertRaises(ValueError):
            verify_payload(build.replace(b"\x64\x86", b"\x4c\x01"), packaged)
