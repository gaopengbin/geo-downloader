"""Build a canonical domestic update feed; draft URLs must never reach clients."""
import argparse
import json
import re
from pathlib import Path

REPOSITORY = "gaopengbin/geo-downloader"
MIRROR = "https://laogao.xyz/packages/latest/"


def release_url(tag):
    if not isinstance(tag, str) or not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Expected a stable version tag")
    return f"https://github.com/{REPOSITORY}/releases/tag/{tag}"


def expected_names(tag):
    release_url(tag)
    prefix = f"GeoDownloader_{tag[1:]}_"
    return {prefix + suffix for suffix in (
        "windows_x64-setup.exe", "macos_arm64.dmg", "macos_x64.dmg",
        "linux_amd64.deb", "linux_amd64.AppImage",
    )}


def validate_manifest(feed):
    tag = feed.get("tag_name")
    if feed.get("html_url") != release_url(tag):
        raise ValueError("Release page must use the canonical version URL, never a draft/untagged URL")
    if feed.get("draft") is not False or feed.get("prerelease") is not False:
        raise ValueError("A public stable feed cannot advertise a draft or prerelease")
    assets = feed.get("assets", [])
    if len(assets) != 5 or {a.get("name") for a in assets} != expected_names(tag):
        raise ValueError("Expected all five distinct versioned installers")
    for asset in assets:
        if type(asset.get("size")) is not int or asset["size"] <= 0:
            raise ValueError("Invalid installer size")
        if not re.fullmatch(r"[a-f0-9]{64}", str(asset.get("sha256", ""))):
            raise ValueError("Installer SHA256 is required")
        if asset.get("browser_download_url") != MIRROR + asset["name"]:
            raise ValueError("Unexpected domestic installer URL")
    return feed


def build_manifest(release, allow_draft_for_staging=False):
    tag = release.get("tag_name")
    canonical = release_url(tag)
    if release.get("prerelease") is not False:
        raise ValueError("Expected a stable release")
    if release.get("draft") is not False and not allow_draft_for_staging:
        raise ValueError("Release is not published; explicit staging mode is required")
    assets = []
    names = expected_names(tag)
    for asset in release.get("assets", []):
        if asset.get("name") not in names:
            continue
        digest = asset.get("digest") or ""
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ValueError("Official installer digest is missing")
        assets.append({"name": asset["name"], "size": asset["size"],
            "sha256": digest[7:], "githubAssetId": asset["id"],
            "browser_download_url": MIRROR + asset["name"]})
    # GitHub can return an untagged html_url while a release is a draft. The
    # stable tag is authoritative; never copy that temporary display URL.
    return validate_manifest({"tag_name": tag, "html_url": canonical,
        "body": release.get("body") or "", "draft": False,
        "prerelease": False, "assets": assets})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--validate", type=Path)
    parser.add_argument("--allow-draft-for-staging", action="store_true")
    args = parser.parse_args()
    if args.validate:
        validate_manifest(json.loads(args.validate.read_text(encoding="utf-8-sig")))
    else:
        if not args.release or not args.output:
            parser.error("Provide --release and --output, or --validate")
        feed = build_manifest(json.loads(args.release.read_text(encoding="utf-8-sig")), args.allow_draft_for_staging)
        args.output.write_text(json.dumps(feed, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
