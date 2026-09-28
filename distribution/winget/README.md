# GeoD CLI WinGet submission

Submitted package: **GeoD.CLI 0.1.1** (Windows x64, Inno Setup, current user).
[Microsoft community repository PR #434088](https://github.com/microsoft/winget-pkgs/pull/434088)
is open and awaiting validation/review; it has not been merged or indexed.
Do not advertise the catalog install command as available until that completes.

Verified on 2026-09-14 at 00:04 Asia/Shanghai: PR head
`3bf7aac41cc462942a256d56753ed3a16cd67c24`, three added YAML files, non-draft and
unmerged. After one bounded follow-up, the upstream **Pull Request Validation**
and **Manifest Validation** checks succeeded. Validation stages 03 through 10
were still queued. The CLA check was pending; see the specific notice below.

## Exact submission payload

The PR contains only these three files in `microsoft/winget-pkgs`:

```text
manifests/g/GeoD/CLI/0.1.1/GeoD.CLI.yaml
manifests/g/GeoD/CLI/0.1.1/GeoD.CLI.locale.en-US.yaml
manifests/g/GeoD/CLI/0.1.1/GeoD.CLI.installer.yaml
```

PR title: `New package: GeoD.CLI version 0.1.1`.
This README, local reports, scripts, binaries, and other package versions are
not part of that PR.

## Source and identifier checks

The publisher's [public release](https://github.com/gaopengbin/geo-downloader/releases/tag/geod-cli-v0.1.1)
is a GitHub prerelease, with installer version `0.1.1`. The manifest keeps that
actual installed version; it does not invent a different version or a WinGet
channel. The default locale explicitly describes the public preview status.

- Source commit: `a9d1a9062916141071e1b122de15dc2041f0fdc1`.
- Installer: `geod-cli-0.1.1-windows-x64-setup.exe`, 4,285,378 bytes.
- SHA256: `3ca8c7a515f8f5f397732e62be11fddbce0d6e9cc61c66c0f6074341f8e85288`.
- Actual per-user uninstall identifier:
  `{692CB25C-EC2D-446A-BB70-972F89073D63}_is1`.
- Actual installed display name: `GeoD CLI 0.1.1`; publisher: `GeoD`.
- The version-specific license link is MIT. No desktop installer or other
  product's package identifier is used.

Before this submission (2026-09-14, Asia/Shanghai), anonymous GitHub API checks found no `manifests/g/GeoD` directory
(404), and no open `winget-pkgs` PR matching `GeoD`. `winget search --id GeoD.CLI
--exact --source winget --disable-interactivity` reported no matching package.
The existing `GeoDa` and `GeodeSDK` publishers are different products. This
submission is now tracked by PR #434088; do not create a duplicate PR.

## Validation and remaining acceptance work

The currently recommended community schema is **1.12.0**, verified against the
official PR template. The local client is WinGet **v1.29.290**.

From this repository root, validate without installing or changing settings:

```powershell
rtk proxy winget validate --manifest distribution/winget/manifests/g/GeoD/CLI/0.1.1 --disable-interactivity
```

Actual result: exit code **0**, `清单验证成功。` (manifest validation succeeded).
The final local change scope is the three YAML files above plus this README.

The frozen installer already has a separate 49-check direct installer acceptance
report under `output/geod-cli-installer-qa-20260913-resumed-a3/installer-qa.json`.
That report covers silent install/uninstall, payload hashes, PATH ownership,
Chinese/space paths, preserving user-added files, and an installed CLI boundary
fetch. It is **not** a WinGet-manifest installation test.

`winget install --manifest <version-directory>` has not been run on this host.
The remaining technical check is to verify catalog correlation, the default
silent-with-progress mode, and uninstall through WinGet. The official guide says
enabling `LocalManifestFiles` requires elevation; an already enabled environment
or Windows Sandbox can be used. This preparation kept the existing local
administrative settings unchanged and did not perform another installation.
The read-only `winget --info` check confirmed `LocalManifestFiles` is **disabled**
on the current machine. `ProxyCommandLineOptions` is also disabled; the catalog
search succeeded without that option. No administrative setting was changed.

The per-user installer deliberately refuses in-place installation over an
existing installation or a nonempty directory. `UpgradeBehavior:
uninstallPrevious` instructs WinGet to remove the old installation first. Because
uninstall preserves user-added files, those files may still block reuse of the
same directory. Keep outputs outside the installation directory, or move the
retained files before a subsequent install. Only one public CLI version exists,
so a real cross-version upgrade has not been tested.

The public setup is unsigned. A passing local schema check or direct installer
test does not replace the community repository's security scans, automated
installer validation, moderator review, or indexing.

The [Microsoft CLA bot notice on the PR](https://github.com/microsoft/winget-pkgs/pull/434088)
explicitly reports that the Contributor License Agreement has not been agreed
yet. This requires the contributor's own review and decision; no agreement was
posted on their behalf. The CLA and local WinGet-install checklist items remain
unchecked. A queued check is not a failed installer or a successful validation.

After acceptance and catalog availability, the intended user command is:

```powershell
winget install --id GeoD.CLI --exact --source winget --scope user
```

## Official references checked

- [Current PR template and schema recommendation](https://github.com/microsoft/winget-pkgs/blob/master/.github/PULL_REQUEST_TEMPLATE.md)
- [Contributor guide](https://github.com/microsoft/winget-pkgs/blob/master/CONTRIBUTING.md)
- [First-time contributor checklist](https://github.com/microsoft/winget-pkgs/blob/master/doc/FirstContribution.md)
- [Manifest authoring and exact directory structure](https://github.com/microsoft/winget-pkgs/blob/master/doc/Authoring.md)
- [Installer schema 1.12.0, including uninstallPrevious](https://github.com/microsoft/winget-pkgs/blob/master/doc/manifest/schema/1.12.0/installer.md)
- [Community repository policies](https://github.com/microsoft/winget-pkgs/blob/master/doc/Policies.md)
- [Microsoft submission and review process](https://learn.microsoft.com/en-us/windows/package-manager/package/repository)
