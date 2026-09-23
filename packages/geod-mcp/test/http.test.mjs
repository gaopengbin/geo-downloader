import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGeoDHttpServer } from '../src/http.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const geodBin = path.join(repoRoot, 'target', 'release', process.platform === 'win32' ? 'geod.exe' : 'geod');

test('HTTP MCP requires bearer auth and serves real GeoD tools', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'geod-http-'));
  const token = randomBytes(32).toString('hex');
  const tokenFile = path.join(workspace, 'token.txt');
  await writeFile(tokenFile, `${token}\n`);
  const { server, service } = await createGeoDHttpServer({ GEOD_MCP_TOKEN_FILE: tokenFile, GEOD_MCP_PORT: '19473', GEOD_WORKSPACE: workspace, GEOD_BIN: geodBin, GEOD_MAX_CONCURRENT_JOBS: '1' });
  await new Promise(resolve => server.listen(19473, '127.0.0.1', resolve));
  const url = new URL('http://127.0.0.1:19473/mcp');
  let client;
  try {
    const missing = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(missing.status, 401);
    const wrongOrigin = await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example', authorization: `Bearer ${token}` }, body: '{}' });
    assert.equal(wrongOrigin.status, 403);
    client = new Client({ name: 'geod-http-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'geod_plan'));
    const capabilities = (await client.callTool({ name: 'geod_capabilities', arguments: {} })).structuredContent;
    assert.equal(capabilities.transport, 'streamable-http');
    assert.equal(capabilities.cli.available, true);
  } finally {
    await client?.close();
    await new Promise(resolve => server.close(resolve));
    await service.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
