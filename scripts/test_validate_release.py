import json
from pathlib import Path
import tempfile
import unittest
from validate_release import validate


class ReleaseValidationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "src-tauri").mkdir()
        (self.root / "src-tauri/tauri.conf.json").write_text(json.dumps({"version": "3.6.21"}))
        (self.root / "src-tauri/Cargo.toml").write_text('[package]\nname="geo-downloader"\nversion="3.6.21"\n')
        (self.root / "src-tauri/Cargo.lock").write_text('[[package]]\nname="geo-downloader"\nversion="3.6.21"\n')

    def notes(self, path, text="# Changes\nWorks"):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")

    def test_canonical_notes(self):
        self.notes("docs/release-notes/release-notes-v3.6.21.md")
        self.assertEqual(validate(self.root, "v3.6.21")["notes_path"], "docs/release-notes/release-notes-v3.6.21.md")

    def test_manual_recovery_legacy_layout(self):
        self.notes("docs/releases/3.6.21.md")
        self.assertEqual(validate(self.root, "v3.6.21")["notes_path"], "docs/releases/3.6.21.md")

    def test_canonical_wins_when_both_exist(self):
        self.notes("docs/releases/3.6.21.md")
        self.notes("docs/release-notes/release-notes-v3.6.21.md")
        self.assertIn("release-notes/", validate(self.root, "v3.6.21")["notes_path"])

    def test_missing_or_empty_notes_fail_before_build(self):
        for text in [None, " \n", "\ufeff \n"]:
            if text is not None:
                self.notes("docs/releases/3.6.21.md", text)
            with self.assertRaisesRegex(ValueError, "before building"):
                validate(self.root, "v3.6.21")

    def test_prerelease_metadata_and_flag(self):
        for path in (self.root / "src-tauri").iterdir():
            path.write_text(path.read_text().replace("3.6.21", "3.6.21-rc.1"))
        self.notes("docs/releases/3.6.21-rc.1.md")
        self.assertEqual(validate(self.root, "v3.6.21-rc.1")["prerelease"], "true")

    def test_rejects_tag_and_metadata_mismatches(self):
        self.notes("docs/releases/3.6.21.md")
        for tag in ["main", "v3.6.20", "v3.6.21\nx=bad", "v3.6.21/../../bad"]:
            with self.assertRaises(ValueError):
                validate(self.root, tag)
        (self.root / "src-tauri/Cargo.lock").write_text('[[package]]\nname="geo-downloader"\nversion="3.6.20"\n')
        with self.assertRaisesRegex(ValueError, "lockfile"):
            validate(self.root, "v3.6.21")


if __name__ == "__main__":
    unittest.main()
