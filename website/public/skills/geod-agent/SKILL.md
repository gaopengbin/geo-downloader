---
name: geod-agent
description: Install and use GeoD MCP for imagery planning, downloads, and inspection. Use browser WebMCP only when the user explicitly requests that route and the browser exposes its tools.
description_zh: 使用 GeoD 规划、下载、拼接并校验影像与边界数据。
description_en: Plan, download, mosaic, and inspect imagery and boundaries with GeoD.
version: 0.1.6
author: GeoD
---

# GeoD imagery download

Connect this Agent to GeoD MCP. GeoD is separate from GeoStyle. Do not assume the Agent can access the user's computer or browser: check where this Agent actually runs before choosing a transport.

## Connect

1. For Codex or WorkBuddy running on the user's Windows x64 computer with Node.js 22+, install the local MCP and bundled Skill. In PowerShell, set `$pkg = "https://laogao.xyz/geod-mcp/geod-mcp-0.1.6.tgz"`, then run `npx --yes --package $pkg geod-mcp install codex --package $pkg` (use `workbuddy` instead of `codex` in WorkBuddy). Afterward, update the installed, unmodified bundled `geod-agent/SKILL.md` with this current file. Preserve any user edits and report a conflict instead of overwriting them. The installer configures the current user's MCP and Skill; do not use another person's paths.
2. For a cloud Agent or an environment where the local installer cannot run, add `https://laogao.xyz/geod-mcp/mcp` as a Streamable HTTP MCP server. Anonymous imagery downloads work through zoom 5; a high-zoom fetch issues an OAuth challenge so the user can authorize with their own GeoD account in a browser. Read-only planning can use this connection; downloads and mosaics use GeoD server resources, only its listed sources are available, and resource limits apply. For large downloads, explain the limitation and use a local-capable Agent instead of silently spending server resources.

Install this `SKILL.md` in the current Agent's supported Skills location; for Codex use `~/.codex/skills/geod-agent/SKILL.md`, and for WorkBuddy import `https://geod.laogao.xyz/skills/geod-agent.zip` if its Skills UI is available. If this client cannot install Skills, read this file as the task guide and report that limitation. A new Agent session may be needed to load an installed Skill or MCP server. Verify setup with MCP tool calls, not by opening a webpage.

## Browser WebMCP (only when requested)

Use `https://geod.laogao.xyz/browser` only if the user explicitly chooses browser processing and this Agent actually receives `geod_browser_*` WebMCP tools from that open page. Merely opening the page, reading its UI, or clicking its controls does not install or verify MCP. If the tools are absent, report that and continue with the MCP setup above. When available, call `geod_browser_capabilities`, `geod_browser_sources` with `action: list`, and `geod_browser_plan`. Use a listed `sourceId`; register an authorized custom source only when the user provides one. The source must permit CORS. `exampleId: "henan"` or `"sichuan"` supplies an example province boundary and range. For another boundary, pass a WGS84 GeoJSON Polygon or MultiPolygon in `clipGeometry`; pixels outside it become transparent. Call `geod_browser_fetch` only when the user asks to download, then have them save the ZIP in the page. Browser output is PNG with positioning files and a manifest; use local MCP for other formats.

## Local or hosted MCP

Anonymous imagery downloads are limited to zoom 0–5. `zoomLevels` takes precedence over `zoom` and `zoomMax`; any selected level 6 or higher requires GeoD login. For local MCP, have the user run `geod auth login` if GeoD CLI is installed, or `npx --yes --package https://laogao.xyz/geod-mcp/geod-mcp-0.1.6.tgz geod-mcp auth login` for an MCP-only installation, and complete the browser authorization, then retry. Hosted MCP issues an OAuth challenge on high-zoom fetch; let the client and user complete it, then retry. Browser WebMCP uses the GeoD login on the same website. Never ask for a password, token, or authorization code in chat. Vector-only work and read-only planning do not require login.

Call `geod_capabilities` and `geod_sources` with `action: list`; use `imagery.sourceId` from the actual source list. On local MCP, an authorized XYZ/TMS/QuadKey source can be registered with `geod_sources` when needed. Hosted MCP cannot register custom sources. Read `geod://examples/henan` or `geod://examples/sichuan` for request examples, or use the user's WGS84 bounds `[west, south, east, north]`. Do not invent a precise boundary. Call `geod_plan` to validate and estimate size without downloading. When the user asks for the data, call `geod_fetch`, poll `geod_job_status`, inspect the completed manifest, and return the actual source, coverage, warnings, and artifact. Use `geod_get_artifact` for a small preview, `geod_artifact_link` for a large hosted file, or the local path for a local file. Use `geod_inspect` for an existing bundle.

`geod_sources list` reports policy eligibility, not proof that an endpoint currently works. For a user-selected source, call `geod_sources` with `action: probe` before a requested download; if it returns a different tile size, update the local source with `tileSize: 256` or `512`, or set `imagery.tileSize` when using a direct URL. Use the same tile size for planning and fetching; GeoD preserves 512px source pixels and geographic placement. Do not use CARTO Basemaps for bulk download; its current terms require a user key and prohibit bulk extraction. Do not substitute a different provider without the user's direction.

MCP tool arguments wrap the GeoD request as `{ "request": { "schemaVersion": "1.0", "name": "...", "bounds": [west, south, east, north], "imagery": { "sourceId": "...", "zoom": 7 } } }`. After `geod_job_status` reaches `completed`, use its top-level `manifestPath` on local MCP or its `artifacts` entries; `result.manifestPath` is also retained. In the manifest, `bounds` is the requested range and each raster asset's `bounds` is its actual tile-grid footprint. A queued or running job requires the MCP server process to stay alive; closing a local stdio session cancels active work, and a later process cannot resume that download. Keep the same Agent connection open while polling. Do not invent a raw JSON-RPC or PowerShell client to bypass an unsupported MCP/OAuth integration; report the client limitation clearly.

Verify the MCP connection with `geod_capabilities`, source listing, and a read-only `geod_plan`. Do not claim success from webpage interaction alone. Do not start a download or probe a network tile solely to test setup. NASA Blue Marble examples are overview imagery, not current high-resolution imagery. Do not expose source URLs containing credentials.
