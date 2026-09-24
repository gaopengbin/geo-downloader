# GeoD CLI

Install the GeoD command line on **Windows x64** with **Node.js 18 or newer**:

```powershell
npm install --global geod-cli@0.2.0
geod --version
geod --help
```

Or run without a permanent global installation:

```powershell
npx --yes geod-cli@0.2.0 --help
```

GeoD plans and acquires geodata from a JSON request, writes imagery and GeoJSON with source metadata, and inspects existing bundles:

```powershell
geod plan --request request.json
geod fetch --request request.json --out ./geod-output
geod inspect --bundle ./geod-output
```

Imagery requests support multiple zoom levels, GeoTIFF/PNG/JPEG mosaics, MBTiles, GeoPackage, raw XYZ tiles, overlays, polygon clipping, TIFF compression and overviews. Add `--work-dir ./geod-work` to `fetch` to reuse validated tiles after an interruption. The download and export run on your own computer.

See the [GeoD CLI 0.2 guide](https://github.com/gaopengbin/geo-downloader/blob/geod-cli-v0.2.0/docs/geod-cli-0.2.md) for request examples and limits.

Version 0.2.0 includes the Windows x64 `geod.exe` directly in this npm package. Installation does not fetch a binary from GitHub, run a postinstall script, or require Rust, Tauri, GDAL or a separate Visual C++ runtime installation. The Node launcher passes arguments directly to the executable, preserves the current directory and native stdout/stderr, and returns its exit code (including cancellation code 130).

macOS, Linux and Windows ARM64 are not supported by this package version. The npm launcher requires Node.js; the separately published [portable ZIP and Windows installer](https://github.com/gaopengbin/geo-downloader/releases/tag/geod-cli-v0.2.0) run without Node.js. Fetching map data requires access to the sources in the request and remains subject to their terms and availability. This package does not include map data or an AI service.

## Package integrity

The build verifies the frozen upstream portable ZIP, its executable and build metadata before packaging. `build-info.json` records the native source revision and executable hash. There are no runtime npm dependencies or install hooks.

For maintainers, run `node scripts/package-geod-cli-npm.mjs` from the repository. The resulting tarball is staged under `output/geod-cli-public-0.2.0/npm/`; the executable is not checked into the package source directory. Direct packing without the verified executable fails.
