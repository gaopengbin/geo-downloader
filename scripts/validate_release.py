"""Validate a release before building; resolve both supported notes layouts."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib


def validate(root: Path, tag: str) -> dict[str, str]:
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?", tag):
        raise ValueError("Release tag must be vMAJOR.MINOR.PATCH (optionally with a prerelease suffix)")
    version = tag[1:]
    tauri = json.loads((root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    cargo = tomllib.loads((root / "src-tauri/Cargo.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((root / "src-tauri/Cargo.lock").read_text(encoding="utf-8"))
    packages = [p for p in lock["package"] if p["name"] == cargo["package"]["name"]]
    versions = [tauri["version"], cargo["package"]["version"], *[p["version"] for p in packages]]
    if len(packages) != 1 or any(value != version for value in versions):
        raise ValueError(f"Tag {tag} disagrees with Tauri/Cargo/lockfile versions: {versions}")
    candidates = [f"docs/release-notes/release-notes-v{version}.md", f"docs/releases/{version}.md"]
    notes_path = next((path for path in candidates if (root / path).is_file()
                       and (root / path).read_text(encoding="utf-8-sig").strip()), None)
    if not notes_path:
        raise ValueError("Non-empty release notes are required before building. Expected: " + " or ".join(candidates))
    return {"version": version, "tag": tag, "notes_path": notes_path,
            "prerelease": str("-" in version).lower()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--tag", default=os.environ.get("RELEASE_TAG", ""))
    args = parser.parse_args()
    try:
        result = validate(args.root, args.tag)
        result["source_sha"] = subprocess.check_output(
            ["git", "-C", str(args.root), "rev-parse", "HEAD"], text=True).strip()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release preflight failed: {error}\n")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8", newline="\n") as stream:
            stream.write("".join(f"{key}={value}\n" for key, value in result.items()))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
