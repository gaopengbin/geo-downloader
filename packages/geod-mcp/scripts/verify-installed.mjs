import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

const installRoot = process.argv[2];
if (!installRoot) throw new Error('Usage: node scripts/verify-installed.mjs INSTALL_PREFIX');
const entrypoint = path.resolve(installRoot, 'node_modules/geod-mcp/src/index.mjs');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'geod-mcp-install-check-'));
const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], env: { ...process.env, GEOD_WORKSPACE: workspace }, stderr: 'pipe' });
const client = new Client({ name: 'geod-install-verification', version: '1.0.0' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('geod_capabilities') && tools.includes('geod_plan'));
  const capabilities = (await client.callTool({ name: 'geod_capabilities', arguments: {} })).structuredContent;
  assert.equal(capabilities.cli.available, true);
  assert.ok(capabilities.cli.path.includes('node_modules'));
  assert.equal(capabilities.geostyle.renderScriptAvailable, true);
  const resource = await client.readResource({ uri: 'geod://examples/henan' });
  const request = JSON.parse(resource.contents[0].text);
  const planResult = await client.callTool({ name: 'geod_plan', arguments: { request } });
  assert.equal(planResult.isError, undefined, JSON.stringify(planResult));
  assert.equal(planResult.structuredContent.ok, true);
  console.log(JSON.stringify({ ok: true, tools: tools.length, cli: capabilities.cli.path, renderScript: capabilities.geostyle.renderScriptAvailable, example: request.name, plan: planResult.structuredContent.ok }));
} finally {
  await client.close();
  const relative = path.relative(path.resolve(os.tmpdir()), workspace);
  if (!relative.startsWith('geod-mcp-install-check-') || relative.includes(path.sep)) throw new Error('Refusing to remove an unexpected verification directory');
  await rm(workspace, { recursive: true, force: true });
}
