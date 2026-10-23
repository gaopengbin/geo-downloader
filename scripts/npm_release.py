"""Publish the exact verified GeoD GitHub release tarball via npm OIDC.

Preparation has no publish permissions. Publishing never executes package scripts,
never falls back to interactive authentication and never blindly repeats a PUT.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

REPO = 'gaopengbin/geo-downloader'
REGISTRY = 'https://registry.npmjs.org'
TAG = re.compile(r'^(geod-(?:cli|mcp))-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$')
LIMIT = 64 * 1024 * 1024


def read_url(url, *, github=False):
    headers = {'User-Agent': 'GeoD-release-verifier', 'Cache-Control': 'no-cache'}
    if github and os.environ.get('GH_TOKEN'):
        assert urlparse(url).netloc == 'api.github.com'
        headers['Authorization'] = 'Bearer ' + os.environ['GH_TOKEN']
    with urlopen(Request(url, headers=headers), timeout=30) as response:
        data = response.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('Response exceeds release size bound')
    return data


def parse_tag(tag):
    match = TAG.fullmatch(tag)
    if not match:
        raise ValueError('Only GeoD CLI/MCP version release tags are accepted')
    return match.groups()


def checksum_for(text, filename):
    values = []
    for line in text.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1].lstrip('*') == filename:
            values.append(fields[0])
    if len(values) != 1 or not re.fullmatch('[0-9a-f]{64}', values[0]):
        raise ValueError('Missing, duplicate or malformed release checksum')
    return values[0]


def inspect_package(data, name, version, expected_sha):
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_sha:
        raise ValueError('Tarball SHA256 differs from release checksum')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        total = 0
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or '\\' in member.name or not path.parts or path.parts[0] != 'package':
                raise ValueError('Unsafe archive path')
            if member.isdir():
                continue
            if not member.isfile() or member.name in files:
                raise ValueError('Links, special files and duplicates are forbidden')
            total += member.size
            if total > LIMIT or len(files) >= 1000:
                raise ValueError('Unpacked package exceeds bounds')
            files[member.name] = archive.extractfile(member).read()
    meta = json.loads(files['package/package.json'])
    if (meta['name'], meta['version']) != (name, version):
        raise ValueError('Package name/version does not match release tag')
    repo = meta.get('repository', {})
    if not isinstance(repo, dict) or repo.get('url') != f'git+https://github.com/{REPO}.git':
        raise ValueError('Unexpected package repository')
    if meta.get('os') != ['win32'] or meta.get('cpu') != ['x64']:
        raise ValueError('Unexpected package platform')
    if any(meta.get('scripts', {}).get(key) for key in ('preinstall', 'install', 'postinstall')):
        raise ValueError('Installation hooks are forbidden')
    native_path = 'package/native/geod.exe' if name == 'geod-cli' else 'package/bin/geod.exe'
    binary = files[native_path]
    if not binary.startswith(b'MZ'):
        raise ValueError('Missing Windows executable')
    if name == 'geod-cli':
        info = json.loads(files['package/build-info.json'])
        if info['version'] != version or info['binarySha256'] != hashlib.sha256(binary).hexdigest():
            raise ValueError('Bundled executable/build metadata mismatch')
    return {'name': name, 'version': version, 'sha256': digest,
            'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode(),
            'sha1': hashlib.sha1(data).hexdigest(), 'nativeSha256': hashlib.sha256(binary).hexdigest()}


def registry_version(candidate):
    try:
        return json.loads(read_url(f"{REGISTRY}/{candidate['name']}/{candidate['version']}"))
    except HTTPError as error:
        if error.code == 404:
            return None
        raise  # Authentication/network/server failures are not "unpublished".


def compare_registry(candidate, meta):
    if meta['dist'].get('integrity') != candidate['integrity'] or meta['dist'].get('shasum') != candidate['sha1']:
        raise ValueError('Existing npm version differs from verified release; refusing to overwrite')


def npm(args, **kwargs):
    executable = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not executable:
        raise RuntimeError('npm not found')
    subprocess.run([executable, *args], check=True, timeout=180, **kwargs)


def smoke(candidate, directory, package_spec):
    target = directory / 'installed'
    npm(['install', '--prefix', str(target), '--ignore-scripts', '--no-audit', '--no-fund',
         '--prefer-online', '--registry', REGISTRY, package_spec])
    package = target / 'node_modules' / candidate['name']
    binary = package / ('native/geod.exe' if candidate['name'] == 'geod-cli' else 'bin/geod.exe')
    if hashlib.sha256(binary.read_bytes()).hexdigest() != candidate['nativeSha256']:
        raise ValueError('Installed native executable differs from verified package')
    result = subprocess.check_output([str(binary), '--version'], text=True, timeout=20).strip()
    if not result.startswith('geod ') or (candidate['name'] == 'geod-cli' and result != 'geod ' + candidate['version']):
        raise ValueError('Unexpected installed executable version')
    if candidate['name'] == 'geod-mcp':
        subprocess.run(['node', str(package/'bin/geod-mcp.mjs'), 'telemetry', 'status'], check=True, timeout=20)
    print('Installed native version:', result)


def prepare(tag, directory, run_smoke=False):
    name, version = parse_tag(tag)
    release = json.loads(read_url(f'https://api.github.com/repos/{REPO}/releases/tags/{quote(tag)}', github=True))
    if release['draft'] or release['tag_name'] != tag or bool(release['prerelease']) != ('-' in version):
        raise ValueError('Release is draft or stable/prerelease status is inconsistent')
    filename = f'{name}-{version}.tgz'
    checksum_name = ('CLI' if name == 'geod-cli' else 'MCP') + '-SHA256SUMS.txt'
    def asset(asset_name):
        matches = [a for a in release['assets'] if a['name'] == asset_name]
        if len(matches) != 1:
            raise ValueError('Expected exactly one release asset: ' + asset_name)
        value = matches[0]
        url = value['browser_download_url']
        if not url.startswith(f'https://github.com/{REPO}/releases/download/{tag}/'):
            raise ValueError('Unexpected asset URL')
        data = read_url(url)
        if len(data) != value['size']:
            raise ValueError('Asset size mismatch')
        if value.get('digest') and value['digest'] != 'sha256:' + hashlib.sha256(data).hexdigest():
            raise ValueError('GitHub asset digest mismatch')
        return data
    expected = checksum_for(asset(checksum_name).decode(), filename)
    data = asset(filename)
    candidate = inspect_package(data, name, version, expected)
    directory.mkdir(parents=True, exist_ok=True)
    (directory/filename).write_bytes(data)
    candidate.update(filename=filename, releaseTag=tag, releaseUrl=release['html_url'],
                     distTag='next' if '-' in version else 'latest')
    (directory/'candidate.json').write_text(json.dumps(candidate, indent=2))
    if run_smoke:
        smoke(candidate, directory, str((directory/filename).resolve()))
    print(json.dumps(candidate))


def load_candidate(directory):
    candidate = json.loads((directory/'candidate.json').read_text())
    name, version = parse_tag(candidate['releaseTag'])
    if candidate['filename'] != f'{name}-{version}.tgz' or candidate['distTag'] != ('next' if '-' in version else 'latest'):
        raise ValueError('Invalid candidate metadata')
    verified = inspect_package((directory/candidate['filename']).read_bytes(), name, version, candidate['sha256'])
    if any(candidate[key] != value for key, value in verified.items()):
        raise ValueError('Candidate metadata does not match archive')
    return candidate


def publish(directory):
    candidate = load_candidate(directory)
    meta = registry_version(candidate)
    if meta:
        compare_registry(candidate, meta)
        status = 'already-published-identical'
    else:
        if not (os.environ.get('ACTIONS_ID_TOKEN_REQUEST_URL') and os.environ.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN')):
            raise RuntimeError('OIDC credentials unavailable; interactive/token fallback is disabled')
        if os.environ.get('NODE_AUTH_TOKEN') or os.environ.get('NPM_TOKEN'):
            raise RuntimeError('Long-lived npm publish tokens must not be configured')
        # Exactly one submission. An ambiguous error is reconciled by rerunning the
        # workflow, which first checks the registry checksum, not by retrying PUT.
        npm(['publish', str((directory/candidate['filename']).resolve()), '--access', 'public',
             '--tag', candidate['distTag'], '--ignore-scripts', '--registry', REGISTRY])
        status = 'published'
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            meta = registry_version(candidate)
            if meta:
                break
            time.sleep(10)
        if not meta:
            raise RuntimeError('npm accepted submission but registry visibility is still pending; rerun to reconcile')
        compare_registry(candidate, meta)
    url = meta['dist']['tarball']
    if urlparse(url).netloc != 'registry.npmjs.org' or urlparse(url).scheme != 'https':
        raise ValueError('Unexpected registry download host')
    if hashlib.sha256(read_url(url)).hexdigest() != candidate['sha256']:
        raise ValueError('Public registry tarball differs from release')
    receipt = {**candidate, 'status': status, 'registryVerified': True}
    (directory/'receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf8') as summary:
            summary.write(f"### {candidate['name']} {candidate['version']}\n\n{status}; public tarball SHA-256 verified.\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'publish', 'install'])
    parser.add_argument('--tag')
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare(args.tag or '', args.directory, args.smoke)
    elif args.action == 'publish':
        publish(args.directory)
    else:
        candidate = load_candidate(args.directory)
        smoke(candidate, args.directory, candidate['name'] + '@' + candidate['version'])


if __name__ == '__main__':
    main()
