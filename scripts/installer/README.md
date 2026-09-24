# GeoD CLI Windows installer

This installer is independent of the GeoD desktop application's installer. It
installs the files from a SHA256-pinned CLI portable ZIP without downloading
anything. The ZIP remains available for portable use.

## Build locally

Requires Windows, Python 3, and a locally installed Inno Setup 6 compiler. The
initial verified compiler is **Inno Setup 6.6.1**. No third-party Python modules
are needed. Do not build from a ZIP whose provenance has not been checked.

```powershell
powershell -NoProfile -File scripts/installer/build-geod-cli-installer.ps1 `
  -PackageZip C:/releases/geod-cli-0.2.0-windows-x64.zip `
  -ExpectedSha256 <verified-64-character-sha256> `
  -OutputDirectory C:/releases/geod-cli-installer-0.2.0
```

The output directory must not exist. The builder checks ZIP paths, expected
files, x64 PE architecture, build-info binary hash and actual `geod --version`.
It retains the exact extracted payload, compiler log, installer SHA256, and
`installer-build.json`. A blank source revision is explicitly marked as a
development build; publish only a package with a verified frozen commit. The
builder neither rebuilds the CLI nor changes the portable package.

Installers are unsigned unless a future reviewed signing process is added.
Windows may display an unknown-publisher warning. This is not a signed release.

## Installation behavior

- Default: `%LOCALAPPDATA%\Programs\GeoD CLI`, current user only, no elevation.
- A different empty directory on a local drive can be selected. Nonempty
  directories, junctions, symlinks, and root directories are rejected. Existing
  installations must be uninstalled before installing again; this initial
  installer does not perform in-place upgrades or overwrite arbitrary files.
- PATH is selected by default and changes **only HKCU\Environment\Path**.
  Open a new terminal after installation. A matching pre-existing PATH entry
  (including environment-variable, case, quote, and trailing-slash equivalents)
  is left in place and not claimed by the installer.
- Uninstall removes one exact PATH token only when this installation added it.
  User-edited equivalent tokens and all unrelated entries are preserved. Both
  existing REG_SZ and REG_EXPAND_SZ PATH types are preserved. The installer
  re-reads PATH before writing to avoid replacing an observed concurrent edit.
- Uninstall removes only installer-logged payload files. Files users later add
  to the installation directory are retained. Keep downloaded maps/projects
  outside the install directory as normal CLI working data.
- The uninstall entry and installer ownership metadata are per user and have
  a dedicated CLI AppId; desktop application registration is not touched.

## Silent installation and removal

```powershell
powershell -NoProfile -Command "Start-Process -FilePath 'C:/releases/geod-cli-0.2.0-windows-x64-setup.exe' -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' -WindowStyle Hidden -Wait"
```

For automated verification, use `subprocess.run` with separate arguments or
proper Windows argument quoting, capture the exit code, and add
`/DIR=C:\a-controlled-empty-folder` and `/LOG=C:\logs\install.log`. To opt out
of PATH, pass `/TASKS=`. The uninstaller is `unins000.exe` inside the chosen
installation directory; pass `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=...`.
Do not infer success from process launch alone: verify the exit status, binary
version, per-user registry, and PATH ownership.

```powershell
python -m unittest discover -s scripts/installer -p "test_*.py"
```

These tests validate archive safety and provenance. Actual installer acceptance
also requires silent install/uninstall, nonempty directory rejection, exact
payload hashes, PATH opt-out/pre-existing token handling, and preservation of
unrelated files. Do not run multiple installer tests against the same user PATH
concurrently.

## Upstream references

- [Per-user privileges](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm)
- [PATH string-type preservation](https://jrsoftware.org/ishelp/topic_isxfunc_regwritestringvalue.htm)
- [Environment-change broadcast](https://jrsoftware.org/ishelp/topic_setup_changesenvironment.htm)
- [Inno Setup license](https://github.com/jrsoftware/issrc/blob/main/license.txt)

The compiler retains its own copyright notices and URLs. Its license permits
commercial applications; upstream requests commercial users support development
by purchasing a license, which its [FAQ](https://jrsoftware.org/isorder.php)
states is not strictly required.
