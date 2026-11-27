#!/usr/bin/env bash
# Verify and launch the application copied from a release DMG on a native macOS runner.
set -euo pipefail

dmg=$1
expected_version=$2
shift 2
mount_dir=$(mktemp -d "$RUNNER_TEMP/geod-dmg.XXXXXX")
trap 'hdiutil detach "$mount_dir" >/dev/null 2>&1 && rmdir "$mount_dir" || true' EXIT
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_dir"
app=$(find "$mount_dir" -maxdepth 1 -type d -name "*.app" -print -quit)
test -n "$app"
info="$app/Contents/Info.plist"
version=$(plutil -extract CFBundleShortVersionString raw -o - "$info")
test "$version" = "$expected_version"
executable=$(plutil -extract CFBundleExecutable raw -o - "$info")
lipo "$app/Contents/MacOS/$executable" -verify_arch "$(uname -m)"
codesign --verify --deep --strict --verbose=2 "$app"
codesign -dv --verbose=4 "$app" 2>&1
installed=$(mktemp -d "$RUNNER_TEMP/geod-mac-app.XXXXXX")/"$(basename "$app")"
ditto "$app" "$installed"
python3 "$(dirname "$0")/check_unix_release_startup.py" "$installed/Contents/MacOS/$executable" "$@"
