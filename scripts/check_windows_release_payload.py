"""Check the Windows NSIS payload before attaching it to a GeoD release."""

import argparse
import hashlib
from pathlib import Path
import struct
import subprocess
from tempfile import TemporaryDirectory


def verify_payload(build, payload):
    marker = b"__TAURI_BUNDLE_TYPE_VAR_"
    if build[:2] != b"MZ" or len(build) < 64:
        raise ValueError("Expected a Windows executable")
    pe = struct.unpack_from("<I", build, 60)[0]
    if build[pe : pe + 6] != b"PE\x00\x00\x64\x86":
        raise ValueError("Expected a Windows AMD64 executable")
    # Tauri sets a three-byte package type when generating the installer.
    # A handoff must ship every other byte of the tested executable intact.
    unbundled = marker + b"UNK"
    nsis = marker + b"NSS"
    if build.count(marker) != 1 or payload.count(nsis) != 1:
        raise ValueError("Unexpected Tauri bundle type or marker count")
    if build.count(unbundled) == 1:
        build = build.replace(unbundled, nsis, 1)
    if build != payload:
        raise ValueError("Installer executable differs from the release build")
    return hashlib.sha256(payload).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installer", type=Path)
    parser.add_argument("executable", type=Path)
    args = parser.parse_args()
    with TemporaryDirectory(prefix="geod-verify-", dir=args.installer.resolve().parent) as temp_dir:
        subprocess.run(["7z", "t", str(args.installer)], check=True)
        subprocess.run(["7z", "x", "-y", f"-o{temp_dir}", str(args.installer), "geo-downloader.exe"], check=True)
        sha256 = verify_payload(args.executable.read_bytes(), (Path(temp_dir) / "geo-downloader.exe").read_bytes())
        print(f"Verified Windows x64 installer payload SHA-256 {sha256}")


if __name__ == "__main__":
    main()
