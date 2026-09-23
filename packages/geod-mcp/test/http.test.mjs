import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const { server, service } = await createGeoDHttpServer({ GEOD_MCP_TOKEN_FILE: tokenFile, GEOD_MCP_PORT: '19473', GEOD_WORKSPACE: workspace, GEOD_BIN: geodBin, GEOD_MAX_CONCURRENT_JOBS: '1', GEOD_RENDER_ENABLED: '0' });
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
    assert.ok(tools.tools.some(tool => tool.name === 'geod_artifact_link'));
    assert.ok(!tools.tools.some(tool => tool.name === 'geod_render'));
    const capabilities = (await client.callTool({ name: 'geod_capabilities', arguments: {} })).structuredContent;
    assert.equal(capabilities.transport, 'streamable-http');
    assert.equal(capabilities.cli.available, true);
    assert.equal(capabilities.geostyle, undefined);
    const jobId = randomUUID();
    const jobDir = path.join(workspace, 'output', 'geod-mcp', jobId);
    await mkdir(jobDir, { recursive: true });
    const data = Buffer.alloc(9 * 1024 * 1024, 37);
    const file = path.join(jobDir, 'large.bin');
    await writeFile(file, data);
    await writeFile(path.join(jobDir, 'job.json'), JSON.stringify({ jobId, kind: 'fetch', status: 'completed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), artifacts: [{ id: 'large', name: 'large.bin', path: file, uri: `geod://artifacts/${jobId}/large`, mimeType: 'application/octet-stream', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }));
    const link = (await client.callTool({ name: 'geod_artifact_link', arguments: { jobId, artifactId: 'large' } })).structuredContent;
    assert.equal(link.ok, true);
    const download = new URL(link.url);
    download.protocol = 'http:';
    download.host = '127.0.0.1:19473';
    download.pathname = download.pathname.replace('/geod-mcp', '');
    const response = await fetch(download);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    download.searchParams.set('sig', '0'.repeat(64));
    assert.equal((await fetch(download)).status, 403);
  } finally {
    await client?.close();
    await new Promise(resolve => server.close(resolve));
    await service.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
