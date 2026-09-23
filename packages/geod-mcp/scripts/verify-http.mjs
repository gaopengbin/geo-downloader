#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.argv[2];
const tokenFile = process.argv[3];
if (!url || !tokenFile) {
  process.stderr.write('Usage: node scripts/verify-http.mjs <https-mcp-url> <local-token-file>\n');
  process.exit(2);
}
const token = (await readFile(tokenFile, 'utf8')).trim();
const client = new Client({ name: 'geod-http-verifier', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'geod_plan'));
  const capabilities = (await client.callTool({ name: 'geod_capabilities', arguments: {} })).structuredContent;
  assert.equal(capabilities.transport, 'streamable-http');
  assert.equal(capabilities.cli.available, true);
  const example = capabilities.examples.find(item => item.id === 'henan');
  assert.ok(example?.request, 'Henan planning example is missing');
  const plan = (await client.callTool({ name: 'geod_plan', arguments: { request: example.request } })).structuredContent;
  assert.equal(plan.ok, true, JSON.stringify(plan.error));
  const summary = { ok: true, url, tools: listed.tools.map(tool => tool.name), plan: { ok: plan.ok, name: example.name } };
  if (process.argv.includes('--fetch')) {
    const request = structuredClone(example.request);
    delete request.imagery;
    request.name = 'GeoD remote MCP smoke: Henan boundary';
    request.limits = { maxTiles: 1, maxPixels: 1_048_576, timeoutSeconds: 60 };
    const started = (await client.callTool({ name: 'geod_fetch', arguments: { request } })).structuredContent;
    assert.equal(started.ok, true, JSON.stringify(started.error));
    let status;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      status = (await client.callTool({ name: 'geod_job_status', arguments: { jobId: started.jobId } })).structuredContent;
      if (['completed', 'failed', 'cancelled'].includes(status.status)) break;
    }
    assert.equal(status?.status, 'completed', JSON.stringify(status?.error || status));
    const manifest = (await client.callTool({ name: 'geod_get_artifact', arguments: { jobId: started.jobId, artifactId: 'manifest' } })).structuredContent;
    assert.equal(manifest.artifact.id, 'manifest');
    const vectors = status.artifacts.find(item => item.id === 'vectors');
    assert.ok(vectors);
    const link = (await client.callTool({ name: 'geod_artifact_link', arguments: { jobId: started.jobId, artifactId: 'vectors' } })).structuredContent;
    assert.equal(link.ok, true);
    const download = await fetch(link.url);
    assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), vectors.sha256);
    summary.fetch = { status: status.status, jobId: started.jobId, artifactIds: status.artifacts.map(item => item.id), signedDownloadVerified: true };
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  await client.close();
}
