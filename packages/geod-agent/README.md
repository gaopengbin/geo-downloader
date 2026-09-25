# GeoD Agent installer

Install the GeoD Agent Skill and register the hosted imagery download MCP in Codex or WorkBuddy:

```sh
npx -y geod-agent@latest install
```

If both clients are present, select the current one explicitly:

```sh
npx -y geod-agent@latest install codex
npx -y geod-agent@latest install workbuddy
```

The package does not install GeoD CLI or download imagery. It registers `geod-cloud` at `https://laogao.xyz/geod-mcp/mcp` and copies `geod-agent/SKILL.md` into the selected client's user Skill directory. Existing different MCP registrations and modified Skills are preserved. The installer backs up WorkBuddy's existing MCP JSON before adding GeoD, and backs up an unchanged older GeoD Skill before upgrading it. Re-running the installer with the same version is safe.

Open a new Agent session after installation. In Codex, use `codex mcp login geod-cloud` when authorization is needed; WorkBuddy should open its OAuth flow when connecting. The user signs in with their own GeoD account. To verify without using a download job, call `geod_capabilities` and `geod_plan` with one example request. The hosted service's daily download limit applies to `geod_fetch`.

For clients that cannot run this installer, use the [HTTPS MCP address and downloadable Skill](https://geod.laogao.xyz/mcp). The Windows-only local MCP package and the GeoD CLI remain separate options.
