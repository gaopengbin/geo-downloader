---
name: geod-agent
description: Use the installed GeoD MCP tools to plan and download geographic imagery through GeoD CLI, inspect the bundle, and read verified artifacts. Also diagnose a missing GeoD tool connection.
---

# GeoD Agent

Use the `geod` MCP server for GeoD requests. Start with `geod_capabilities` to confirm the CLI and workspace. For a new acquisition, inspect a relevant `geod://examples/...` resource, prepare an explicit request, call `geod_plan`, then call `geod_fetch` only when the user asked to acquire data. Poll `geod_job_status` for completion and inspect `quality`, warnings, provenance, and artifact paths before describing the result.

Display the downloaded imagery preview through `geod_get_artifact` where the host supports MCP images. Give file paths for full GeoTIFF or large outputs rather than embedding them as images. This MCP package does not provide GeoStyle map rendering.

Do not equate a successful plan with downloaded data. The example imagery is NASA Blue Marble overview data, not current high-resolution satellite imagery; example administrative boundaries do not include verified tourism POIs. State source and coverage based on the actual manifest.

If the `geod` tools are unavailable, inspect the Codex MCP registration and the installed GeoD package. The setup command is `scripts/install-geod-codex.ps1` in the GeoD source repository, using a tested GeoD MCP tarball. A Codex session may need to be restarted after registration to discover the tools.
