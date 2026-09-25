---
name: geod-agent
description: Use the installed GeoD MCP tools to plan, acquire, inspect, and render geographic data when the user asks for GeoD geodata or maps. Also diagnose a missing GeoD tool connection.
---

# GeoD Agent

Use the `geod` MCP server for GeoD requests. Start with `geod_capabilities` to confirm the CLI and workspace. For a new acquisition, inspect a relevant `geod://examples/...` resource, prepare an explicit request, call `geod_plan`, then call `geod_fetch` only when the user asked to acquire data. Poll `geod_job_status` for completion and inspect `quality`, warnings, provenance, and artifact paths before describing the result.

Use `geod_render` only if `geod_capabilities` reports the renderer script and a compatible GeoStyle server is running. Display the returned preview through `geod_get_artifact` where the host supports MCP images. Give file paths for full GeoTIFF or large outputs rather than embedding them as images.

Do not equate a successful plan with downloaded data. The example imagery is NASA Blue Marble overview data, not current high-resolution satellite imagery; example administrative boundaries do not include verified tourism POIs. State source and coverage based on the actual manifest.

If the `geod` tools are unavailable, inspect the Codex MCP registration and the installed GeoD package. The setup command is `scripts/install-geod-codex.ps1` in the GeoD source repository, using a tested GeoD MCP tarball. A Codex session may need to be restarted after registration to discover the tools.
