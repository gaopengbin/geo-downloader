"""Offline installer build from a SHA-pinned GeoD CLI portable package only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import subprocess
import sys
from datetime import datetime, timezone
import zipfile

VERSION = '0.1.1'
LIMIT = 128 * 1024 * 1024


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def package_files(archive: Path) -> dict[str, bytes]:
    """Validate all names before extraction. Accept a single enclosing folder."""
    files: dict[str, bytes] = {}
    seen: set[str] = set()
    total = 0
    with zipfile.ZipFile(archive) as zf:
        if len(zf.infolist()) > 200:
            raise ValueError('Unexpected portable package member count')
        infos = zf.infolist()
        names = []
        for item in infos:
            name = item.filename.replace('\\', '/')
            parts = name.rstrip('/').split('/')
            if not parts or name.startswith('/') or any(p in ('', '..', '.') or ':' in p or
                    p.endswith((' ', '.')) or re.search(r'[\x00-\x1f"<>|?*]', p) or
                    re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', p)
                    for p in parts):
                raise ValueError(f'Unsafe ZIP path: {name!r}')
            mode = item.external_attr >> 16
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError(f'ZIP links/special entries are forbidden: {name}')
            if item.flag_bits & 1:
                raise ValueError('Encrypted ZIP entries are forbidden')
            key = name.rstrip('/').casefold()
            if key in seen:
                raise ValueError(f'Duplicate ZIP path: {name}')
            seen.add(key)
            total += item.file_size
            if total > LIMIT:
                raise ValueError('Portable package exceeds extraction limit')
            names.append((item, name))
        regular = [name for item, name in names if not item.is_dir()]
        prefix = ''
        if 'geod.exe' not in regular:
            roots = {name.split('/')[0] for name in regular}
            if len(roots) != 1:
                raise ValueError('Expected one portable package root')
            prefix = next(iter(roots)) + '/'
        for item, name in names:
            if item.is_dir():
                continue
            relative = name.removeprefix(prefix)
            if not relative or relative == name and prefix:
                raise ValueError('Invalid portable root')
            if relative.lower().startswith(('unins', '.')):
                raise ValueError('Unexpected installer/runtime state in portable payload')
            if relative not in ('geod.exe', 'LICENSE', 'README.txt', 'build-info.json') and not relative.startswith(
                    ('docs/', 'examples/geod-cli/', 'scripts/')):
                raise ValueError(f'Unexpected portable file: {relative}')
            files[relative] = zf.read(item)
    required = {'geod.exe', 'LICENSE', 'README.txt', 'build-info.json', 'docs/geod-cli.md', 'scripts/geod-render.mjs'}
    if not required.issubset(files):
        raise ValueError(f'Missing required payload files: {sorted(required - files.keys())}')
    return files


def validate_build_info(files: dict[str, bytes]) -> dict:
    info = json.loads(files['build-info.json'])
    if info.get('name') != 'geod-cli' or info.get('version') != VERSION or info.get('platform') != 'windows-x64':
        raise ValueError('Portable build-info product/version/platform mismatch')
    if info.get('binarySha256') != sha256(files['geod.exe']):
        raise ValueError('Portable build-info binary SHA256 mismatch')
    revision = info.get('sourceRevision')
    if not isinstance(revision, str) or (revision and not re.fullmatch(r'[a-f0-9]{40}', revision)):
        raise ValueError('Invalid sourceRevision in portable build-info')
    return info


def build(args: argparse.Namespace) -> dict:
    if os.name != 'nt':
        raise ValueError('Build and executable version verification require Windows x64')
    archive = Path(args.package_zip).resolve(strict=True)
    compiler = Path(args.inno_compiler).resolve(strict=True)
    output = Path(args.output_directory).resolve()
    digest = sha256(archive.read_bytes())
    if digest != args.expected_sha256.lower():
        raise ValueError('Portable ZIP SHA256 mismatch')
    files = package_files(archive)
    build_info = validate_build_info(files)
    exe = files['geod.exe']
    if exe[:2] != b'MZ' or len(exe) < 64:
        raise ValueError('Payload geod.exe is not a PE executable')
    pe = struct.unpack_from('<I', exe, 0x3C)[0]
    if exe[pe:pe+4] != b'PE\0\0' or struct.unpack_from('<H', exe, pe+4)[0] != 0x8664:
        raise ValueError('Payload geod.exe is not Windows x64')
    # No existing output/staging is removed or reused.
    output.mkdir(parents=True, exist_ok=False)
    staging = output / 'payload'
    staging.mkdir()
    for name, data in files.items():
        destination = staging / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    version = subprocess.run([str(staging / 'geod.exe'), '--version'], capture_output=True,
                             text=True, check=True, timeout=20).stdout.strip()
    if version != f'geod {VERSION}':
        raise ValueError(f'Portable binary version mismatch: {version!r}')
    script = Path(__file__).with_name('geod-cli.iss')
    command = [str(compiler), f'/DPackageDir={staging}', f'/DPackageSha256={digest}',
               f'/DCliVersion={VERSION}', f'/O{output}', str(script)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    (output / 'compiler.log').write_text(result.stdout + result.stderr, encoding='utf-8')
    if result.returncode:
        raise ValueError(f'Inno compiler failed ({result.returncode}); see compiler.log')
    setup = output / f'geod-cli-{VERSION}-windows-x64-setup.exe'
    setup_hash = sha256(setup.read_bytes())
    (output / (setup.name + '.sha256')).write_text(f'{setup_hash}  {setup.name}\n', encoding='utf-8')
    compiler_version = re.search(r'Compiler engine version:\s*(.+)', result.stdout)
    report = {
        'createdAt': datetime.now(timezone.utc).isoformat(), 'version': VERSION,
        'packageZip': str(archive), 'packageSha256': digest,
        'packageBytes': archive.stat().st_size, 'binaryVersionOutput': version,
        'compiler': str(compiler), 'compilerSha256': sha256(compiler.read_bytes()),
        'compilerVersion': compiler_version.group(1).strip() if compiler_version else 'See compiler.log',
        'installerScriptSha256': sha256(script.read_bytes()),
        'setup': str(setup), 'setupSha256': setup_hash, 'setupBytes': setup.stat().st_size,
        'payload': [{'path': name, 'bytes': len(data), 'sha256': sha256(data)} for name, data in sorted(files.items())],
        'buildInfo': build_info, 'developmentBuild': not bool(build_info['sourceRevision']),
        'signed': False, 'scope': 'per-user', 'requiresAdmin': False,
    }
    (output / 'installer-build.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {key: report[key] for key in ('version', 'packageSha256', 'setup', 'setupSha256', 'setupBytes')}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package-zip', required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--output-directory', required=True)
    parser.add_argument('--inno-compiler', default=r'C:\Program Files (x86)\Inno Setup 6\ISCC.exe')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-fA-F0-9]{64}', args.expected_sha256):
        parser.error('Expected SHA256 must have 64 hexadecimal digits')
    print(json.dumps(build(args), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Installer build failed: {error}', file=sys.stderr)
        sys.exit(1)
