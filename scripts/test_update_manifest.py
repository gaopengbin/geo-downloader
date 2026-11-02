import copy
import unittest
from update_manifest import build_manifest, expected_names, release_url, validate_manifest


def release():
    return {"tag_name": "v3.6.24", "draft": True, "prerelease": False,
        "html_url": "https://github.com/gaopengbin/geo-downloader/releases/tag/untagged-4afd5c6b79992f201900",
        "body": "Release notes", "assets": [
            {"name": name, "id": i + 1, "size": 1000 + i, "digest": "sha256:" + "a" * 64}
            for i, name in enumerate(sorted(expected_names("v3.6.24")))
        ]}


class UpdateManifestTests(unittest.TestCase):
    def test_actual_draft_url_regression_produces_canonical_page(self):
        feed = build_manifest(release(), allow_draft_for_staging=True)
        self.assertEqual(feed["html_url"], release_url("v3.6.24"))
        self.assertEqual(len(feed["assets"]), 5)
        self.assertNotIn("untagged-", str(feed))

    def test_stale_draft_page_in_public_feed_is_rejected(self):
        feed = build_manifest(release(), allow_draft_for_staging=True)
        feed["html_url"] = release()["html_url"]
        with self.assertRaises(ValueError): validate_manifest(feed)

    def test_published_release_matches_staged_feed(self):
        original = release()
        published = copy.deepcopy(original)
        published.update(draft=False, html_url=release_url(original["tag_name"]))
        self.assertEqual(build_manifest(published), build_manifest(original, True))

    def test_draft_requires_explicit_staging(self):
        with self.assertRaises(ValueError): build_manifest(release())

    def test_bad_tag_incomplete_or_duplicate_assets_and_missing_digest_fail(self):
        for mutate in [
            lambda r: r.update(tag_name="untagged-abc"),
            lambda r: r["assets"].pop(),
            lambda r: r["assets"].append(r["assets"][0]),
            lambda r: r["assets"][0].update(digest=None),
        ]:
            data = release(); mutate(data)
            with self.assertRaises(ValueError): build_manifest(data, True)


if __name__ == "__main__": unittest.main()
