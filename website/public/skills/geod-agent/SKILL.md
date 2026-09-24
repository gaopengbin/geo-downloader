---
name: geod-agent
description: Connect an Agent to GeoD imagery downloads through browser WebMCP or GeoD MCP, then plan, download, and inspect imagery when requested.
---

# GeoD imagery download

Connect this Agent to GeoD and use the user's device for downloading and mosaicking when possible. GeoD is separate from GeoStyle. Do not assume the Agent can access the user's computer or browser: check the current environment first.

## Connect

1. If this Agent supports browser WebMCP, open `https://geod.laogao.xyz/browser` in its controllable browser and use the page's `geod_browser_*` tools. Keep the page open during the task. The imagery is processed in that browser.
2. Otherwise, for Codex or WorkBuddy running on the user's Windows x64 computer with Node.js 22+, install the local MCP and bundled Skill. In PowerShell, set `$pkg = "https://laogao.xyz/geod-mcp/geod-mcp-0.1.4.tgz"`, then run `npx --yes --package $pkg geod-mcp install codex --package $pkg` (use `workbuddy` instead of `codex` in WorkBuddy). Afterward, update the installed, unmodified bundled `geod-agent/SKILL.md` with this current file. Preserve any user edits and report a conflict instead of overwriting them. The installer configures the current user's MCP and Skill; do not use another person's paths.
3. If neither device-based option works and the requested download is small, add `https://laogao.xyz/geod-mcp/mcp` as a Streamable HTTP MCP server. The user authorizes it with their own GeoD account in a browser. This option downloads and mosaics on the GeoD server, uses only its listed sources, and has account limits. Never present it as local processing.

Install this `SKILL.md` in the current Agent's supported Skills location; for Codex use `~/.codex/skills/geod-agent/SKILL.md`, and for WorkBuddy import `https://geod.laogao.xyz/skills/geod-agent.zip` if its Skills UI is available. If this client cannot install Skills, read this file as the task guide and report that limitation. A new Agent session may be needed to load an installed Skill or MCP server.

## Browser WebMCP

Call `geod_browser_capabilities`, then `geod_browser_sources` with `action: list`, then `geod_browser_plan`. Use a listed `sourceId`; register an authorized custom source in this browser only when the user provides one. The browser must allow that source's CORS requests. `exampleId: "henan"` or `"sichuan"` supplies an example province boundary and range. For another boundary, pass a WGS84 GeoJSON Polygon or MultiPolygon in `clipGeometry`; pixels outside it become transparent. Planning is read-only. Call `geod_browser_fetch` only when the user asks to download, then have them save the resulting ZIP in the page. Browser output is PNG with positioning files and a manifest; use local MCP for other formats.

## Local or hosted MCP

Call `geod_capabilities` and `geod_sources` with `action: list`; use `imagery.sourceId` from the actual source list. On local MCP, an authorized XYZ/TMS/QuadKey source can be registered with `geod_sources` when needed. Hosted MCP cannot register custom sources. Read `geod://examples/henan` or `geod://examples/sichuan` for request examples, or use the user's WGS84 bounds `[west, south, east, north]`. Do not invent a precise boundary. Call `geod_plan` to validate and estimate size without downloading. When the user asks for the data, call `geod_fetch`, poll `geod_job_status`, inspect the completed manifest, and return the actual source, coverage, warnings, and artifact. Use `geod_get_artifact` for a small preview, `geod_artifact_link` for a large hosted file, or the local path for a local file. Use `geod_inspect` for an existing bundle.

For any route, verify connection with capabilities, source listing, and a read-only plan. Do not start a download or probe a network tile solely to test setup. NASA Blue Marble examples are overview imagery, not current high-resolution imagery. Do not expose source URLs containing credentials.
