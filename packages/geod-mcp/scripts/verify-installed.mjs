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
const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], env: { ...process.env, GEOD_WORKSPACE: workspace, GEOD_CLI_HOME: path.join(workspace, 'source-config') }, stderr: 'pipe' });
const client = new Client({ name: 'geod-install-verification', version: '1.0.0' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('geod_capabilities') && tools.includes('geod_sources') && tools.includes('geod_plan'));
  const capabilities = (await client.callTool({ name: 'geod_capabilities', arguments: {} })).structuredContent;
  assert.equal(capabilities.cli.available, true);
  assert.ok(capabilities.cli.path.includes('node_modules'));
  assert.ok(!tools.includes('geod_render'));
  const sources = (await client.callTool({ name: 'geod_sources', arguments: { action: 'list' } })).structuredContent;
  assert.ok(sources.sources.some(source => source.id === 'nasa_gibs_blue_marble'));
  const resource = await client.readResource({ uri: 'geod://examples/henan' });
  const request = JSON.parse(resource.contents[0].text);
  const registration = await client.callTool({ name: 'geod_sources', arguments: {
    action: 'register', id: 'install_check', name: 'Installer source check',
    url: request.imagery.url, attribution: request.imagery.attribution, maxZoom: 8,
  } });
  assert.equal(registration.structuredContent.id, 'install_check');
  const selected = structuredClone(request);
  delete selected.imagery.url;
  delete selected.imagery.source;
  delete selected.imagery.attribution;
  selected.imagery.sourceId = 'install_check';
  const planResult = await client.callTool({ name: 'geod_plan', arguments: { request: selected } });
  assert.equal(planResult.isError, undefined, JSON.stringify(planResult));
  assert.equal(planResult.structuredContent.ok, true);
  console.log(JSON.stringify({ ok: true, tools: tools.length, cli: capabilities.cli.path, example: request.name, plan: planResult.structuredContent.ok }));
} finally {
  await client.close();
  const relative = path.relative(path.resolve(os.tmpdir()), workspace);
  if (!relative.startsWith('geod-mcp-install-check-') || relative.includes(path.sep)) throw new Error('Refusing to remove an unexpected verification directory');
  await rm(workspace, { recursive: true, force: true });
}
