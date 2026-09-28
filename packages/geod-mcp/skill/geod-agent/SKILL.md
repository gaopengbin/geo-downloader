---
name: geod-agent
description: Plan, download, and inspect geographic imagery with GeoD MCP when a user asks for GeoD data or imagery. Diagnose missing GeoD tools.
description_zh: 使用 GeoD MCP 规划、下载并校验地理影像。
description_en: Plan, download, and inspect geographic imagery with GeoD MCP.
version: 0.1.6
author: GeoD
---

# GeoD imagery download

Use the connected GeoD MCP server, regardless of the client's registration name. It wraps GeoD CLI's imagery download workflow; users of the hosted HTTPS server do not need GeoD CLI on their computers.

1. Call `geod_capabilities` and `geod_sources` with `{ "action": "list" }` to learn the actual transport, available imagery sources, and limits. On local MCP, use `geod_sources` to register a user-supplied, authorized XYZ/TMS/QuadKey source when needed. Prefer `imagery.sourceId` in each request; set a persistent default only when the user asks. Hosted MCP lists only NASA GIBS and does not accept custom source registration. For other sources or larger work, use local MCP or the browser workflow so the user's device does the download.
2. If the user has not supplied a complete request, read a relevant `geod://examples/henan` or `geod://examples/sichuan` resource and adapt its area and source. Bounds are WGS84 `[west, south, east, north]`; do not invent a precise boundary or claim a source is permitted without checking. Call `geod_plan` with `{ "request": ... }` to validate and estimate tiles, pixels, and footprint. Planning does not download anything. Explain the plan and any source or size limitation in plain language.
3. When the user asks to obtain the data, call `geod_fetch` with the planned request. It starts a job. Poll `geod_job_status` using its `jobId` until it completes or fails. Do not call `geod_fetch` just to test a connection, because hosted accounts have a daily job limit.
   Anonymous imagery downloads are limited to zoom 0–5. `zoomLevels` takes precedence over `zoom` and `zoomMax`; any selected level 6 or higher requires GeoD login. For local MCP, have the user run `geod auth login` if GeoD CLI is installed, or `npx --yes --package https://laogao.xyz/geod-mcp/geod-mcp-0.1.6.tgz geod-mcp auth login` for an MCP-only installation, and complete the browser authorization, then retry. Hosted MCP issues an OAuth challenge on high-zoom fetch; let the client and user complete it, then retry. Never ask for a password, token, or authorization code in chat. Vector-only work and read-only planning do not require login.
4. Check the completed manifest and report the actual source, coverage, quality, missing tiles, warnings, and provenance. Read a small preview with `geod_get_artifact`. For large hosted files, use `geod_artifact_link` to return a temporary HTTPS download link; for local files, return the artifact path. Use `geod_inspect` when the user asks to validate an existing bundle.

`geod_sources list` only checks policy eligibility; it does not prove that a provider currently works. Before a requested download from a selected source, use `geod_sources` with `{ "action": "probe", "id": "...", "zoom": ..., "x": ..., "y": ... }`. A probe reports actual tile dimensions. For a 512px source, register it with `tileSize: 512` (or pass `imagery.tileSize: 512` for a direct URL), then plan and fetch with that same size. Do not use CARTO Basemaps for bulk download: they now require a user key and prohibit bulk extraction. An unreachable or restricted source is a blocker, not permission to silently switch providers.

`geod_job_status` returns a top-level `manifestPath` after completion, plus `result.manifestPath` and `artifacts`. The manifest's `bounds` is the requested area; a raster asset's `bounds` is the actual tile-grid footprint. Keep a local stdio MCP process alive while its job runs. A client timeout can be polled while the server remains alive, but stopping the process cancels active work; downloads do not resume after restart. Use the MCP tools directly and report unsupported OAuth or tool registration instead of hand-writing a raw JSON-RPC or PowerShell client.

The bundled NASA Blue Marble examples are overview imagery, not current high-resolution satellite imagery. A prepared administrative boundary is not a verified tourism or POI dataset. `geod_sources probe` requests one tile and should run only when the user wants to test a source. Source URLs may contain credentials; do not quote them in reports. GeoD MCP does not render GeoStyle maps.

If GeoD tools are missing, check the MCP registration and whether this client can use the configured transport. The hosted endpoint is `https://laogao.xyz/geod-mcp/mcp`; anonymous imagery downloads work through zoom 5, and higher levels require the user's own GeoD account authorization in a browser. For local Windows x64 with Node.js 22+, follow the installation instructions at `https://geod.laogao.xyz/mcp`; the installer configures the client and its Skill. A newly added MCP server or Skill may require a new client session. Do not ask for another person's machine path, password, or authorization code.
