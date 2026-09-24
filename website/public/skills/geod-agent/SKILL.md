---
name: geod-agent
description: Plan, download, and inspect geographic imagery with GeoD MCP when a user asks for GeoD data or imagery. Diagnose missing GeoD tools.
---

# GeoD imagery download

Use the connected GeoD MCP server, regardless of the client's registration name. It wraps GeoD CLI's imagery download workflow; users of the hosted HTTPS server do not need GeoD CLI on their computers.

1. Call `geod_capabilities` and `geod_sources` with `{ "action": "list" }` to learn the actual transport, available imagery sources, and limits. On local MCP, use `geod_sources` to register a user-supplied, authorized XYZ/TMS/QuadKey source when needed. Prefer `imagery.sourceId` in each request; set a persistent default only when the user asks. Hosted MCP lists only NASA GIBS and does not accept custom source registration. For other sources or larger work, use local MCP or the browser workflow so the user's device does the download.
2. If the user has not supplied a complete request, read a relevant `geod://examples/henan` or `geod://examples/sichuan` resource and adapt its area and source. Bounds are WGS84 `[west, south, east, north]`; do not invent a precise boundary or claim a source is permitted without checking. Call `geod_plan` with `{ "request": ... }` to validate and estimate tiles, pixels, and footprint. Planning does not download anything. Explain the plan and any source or size limitation in plain language.
3. When the user asks to obtain the data, call `geod_fetch` with the planned request. It starts a job. Poll `geod_job_status` using its `jobId` until it completes or fails. Do not call `geod_fetch` just to test a connection, because hosted accounts have a daily job limit.
4. Check the completed manifest and report the actual source, coverage, quality, missing tiles, warnings, and provenance. Read a small preview with `geod_get_artifact`. For large hosted files, use `geod_artifact_link` to return a temporary HTTPS download link; for local files, return the artifact path. Use `geod_inspect` when the user asks to validate an existing bundle.

The bundled NASA Blue Marble examples are overview imagery, not current high-resolution satellite imagery. A prepared administrative boundary is not a verified tourism or POI dataset. `geod_sources probe` requests one tile and should run only when the user wants to test a source. Source URLs may contain credentials; do not quote them in reports. GeoD MCP does not render GeoStyle maps.

If GeoD tools are missing, check the MCP registration and whether this client can use the configured transport. The hosted endpoint is `https://laogao.xyz/geod-mcp/mcp` and requires the user's own GeoD account authorization in a browser. For local Windows x64 with Node.js 22+, follow the installation instructions at `https://geod.laogao.xyz/mcp`; the installer configures the client and its Skill. A newly added MCP server or Skill may require a new client session. Do not ask for another person's machine path, password, or authorization code.
