<h1 align="center">
  <img width="2172" height="724" alt="GeoD" src="https://github.com/user-attachments/assets/107849ff-eb30-425a-91d8-b93b9048dae7" />
</h1>

<p align="center">
  <a href="README.md">简体中文</a> · <b>English</b>
</p>

<p align="center">
  <a href="https://geodownloader.pages.dev"><b>Website</b></a> ·
  <a href="https://github.com/gaopengbin/geo-downloader/releases/latest"><b>Download</b></a> ·
  <a href="https://github.com/gaopengbin/geo-downloader/discussions"><b>Discussions</b></a> ·
  <a href="https://github.com/gaopengbin/geo-downloader/issues"><b>Issues</b></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/gaopengbin/geo-downloader?include_prereleases&color=2563eb" alt="Latest release">
  <img src="https://img.shields.io/github/downloads/gaopengbin/geo-downloader/total?color=brightgreen&label=downloads" alt="Total downloads">
  <img src="https://img.shields.io/github/stars/gaopengbin/geo-downloader?style=flat" alt="GitHub stars">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT license">
</p>

# GeoD (GeoDownloader)

GeoD is a free and open-source desktop application for browsing and exporting geospatial data. It can display OpenStreetMap basemaps, download selected OpenStreetMap vector features through Overpass, work with user-authorized XYZ and vector tile services, and export local datasets for GIS workflows.

GeoD does not bundle map data or grant rights to third-party services. You are responsible for choosing a source that permits your intended access, download, storage, and redistribution. See the [terms and disclaimer](https://geodownloader.pages.dev/disclaimer.html).

## Download

Download the latest stable release from [GitHub Releases](https://github.com/gaopengbin/geo-downloader/releases/latest).

| Platform | Package pattern |
|---|---|
| Windows x64 | `GeoDownloader_*_windows_x64-setup.exe` |
| macOS Apple Silicon | `GeoDownloader_*_macos_arm64.dmg` |
| macOS Intel | `GeoDownloader_*_macos_x64.dmg` |
| Debian / Ubuntu | `GeoDownloader_*_linux_amd64.deb` |
| Linux AppImage | `GeoDownloader_*_linux_amd64.AppImage` |

The macOS packages are currently unsigned. On first launch, use **Open** from the Finder context menu or allow the app under **System Settings > Privacy & Security**.

## Features

- Select an area by drawing on the map, searching for a place, choosing an administrative region, or importing GeoJSON, Shapefile, KML, or KMZ.
- Download OSM roads, buildings, POIs, land use, waterways, and other selected vector features through Overpass, then save them as GeoJSON.
- Configure XYZ raster sources with URL templates, subdomains, request headers, referrers, and API keys.
- Export raster tiles as georeferenced GeoTIFF, PNG, or JPEG, with optional compression and polygon clipping.
- Preview and download Mapbox Vector Tiles and Mapbox GL style sources.
- Browse Esri Wayback imagery by capture date.
- Work with DEM sources and 3D Tiles datasets.
- Pause, resume, recover, and inspect multiple download tasks.
- Browse through a local tile cache and move the cache directory to another drive.

## OpenStreetMap

GeoD supports OpenStreetMap in two distinct ways:

1. **Interactive map display.** The built-in OpenStreetMap Standard raster layer is intended for normal interactive viewing.
2. **Vector feature export.** GeoD can query selected features through an Overpass API endpoint and convert the response to GeoJSON.

The public `tile.openstreetmap.org` service does not permit bulk downloading, prefetching, or offline tile archives. For offline raster workflows, use a self-hosted service or a provider that explicitly allows those uses. Always follow the [OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/), [OpenStreetMap copyright and ODbL requirements](https://www.openstreetmap.org/copyright), and the usage policy of the service you select.

GeoD is an independent community project. It is not affiliated with or endorsed by the OpenStreetMap Foundation.

## Development

Requirements:

- Rust 1.77 or newer
- Node.js 20 or newer

```bash
npm ci --prefix frontend
cd src-tauri
cargo tauri dev
```

Build release packages with:

```bash
cd src-tauri
cargo tauri build
```

The desktop application uses Tauri 2 and Rust for native functionality, with a React and TypeScript frontend.

## Community

- Ask questions and share workflows in [GitHub Discussions](https://github.com/gaopengbin/geo-downloader/discussions).
- Report reproducible bugs in [GitHub Issues](https://github.com/gaopengbin/geo-downloader/issues).
- Read release notes on the [Releases page](https://github.com/gaopengbin/geo-downloader/releases).

## License

GeoD source code is available under the [MIT License](LICENSE). Third-party map data, imagery, APIs, and tile services remain subject to their own licenses and terms.

Copyright (c) 2025-2026 gaopengbin
