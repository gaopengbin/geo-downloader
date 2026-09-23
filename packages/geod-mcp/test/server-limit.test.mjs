import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/server.mjs';

async function connect(t, { data, mimeType, capabilities = { examples: [] } }) {
  const artifact = { id: 'preview', name: 'preview', path: 'G:/geod-test/output/preview', uri: 'geod://artifacts/test-job/preview', mimeType, bytes: data?.byteLength ?? 0 };
  const service = {
    capabilities: () => capabilities,
    plan: () => ({ ok: true }), startFetch: () => ({ jobId: 'test-job', status: 'queued' }),
    jobStatus: () => ({ jobId: 'test-job', status: 'completed' }), cancelJob: () => ({ status: 'cancelled' }),
    inspect: () => ({ ok: true }),
    readArtifact: () => ({ artifact, data }),
  };
  const server = createServer(service);
  const client = new Client({ name: 'geod-wire-limit-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, artifact };
}

async function expectArtifactLimit(client, artifact) {
  const result = await client.callTool({ name: 'geod_get_artifact', arguments: { jobId: 'test-job', artifactId: 'preview' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'ARTIFACT_TOO_LARGE');
  assert.ok(result.structuredContent.error.message.includes(artifact.path));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 9000, 'error must be bounded instead of returning the oversized payload');
  await assert.rejects(client.readResource({ uri: artifact.uri }), error => {
    assert.equal(error.data?.code, 'ARTIFACT_TOO_LARGE');
    assert.ok(error.message.includes(artifact.path));
    return true;
  });
}

test('8 MiB image is rejected after base64 expansion for tools and resources', async t => {
  const data = Buffer.alloc(8 * 1024 * 1024, 0x01);
  assert.equal(data.length, 8 * 1024 * 1024);
  const { client, artifact } = await connect(t, { data, mimeType: 'image/png' });
  await expectArtifactLimit(client, artifact);
});

test('JSON below the file cap is rejected when protocol string escaping exceeds the wire cap', async t => {
  const data = Buffer.from(JSON.stringify({ text: '\\'.repeat(3_000_000) }));
  assert.ok(data.length < 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: data.toString('utf8') })) > 9_000_000);
  const { client, artifact } = await connect(t, { data, mimeType: 'application/json' });
  await expectArtifactLimit(client, artifact);
});

test('small PNG still returns native image and the original resource bytes', async t => {
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFf8AAAAASUVORK5CYII=', 'base64');
  const { client, artifact } = await connect(t, { data, mimeType: 'image/png' });
  const result = await client.callTool({ name: 'geod_get_artifact', arguments: { jobId: 'test-job', artifactId: 'preview' } });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.find(block => block.type === 'image')?.data, data.toString('base64'));
  assert.equal(result.content.find(block => block.type === 'resource_link')?.uri, artifact.uri);
  const resource = await client.readResource({ uri: artifact.uri });
  assert.equal(resource.contents[0].blob, data.toString('base64'));
});

test('generic JSON results account for duplicated structured content and text', async t => {
  const { client } = await connect(t, { capabilities: { note: 'x'.repeat(5_000_000) } });
  const result = await client.callTool({ name: 'geod_capabilities', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'RESPONSE_TOO_LARGE');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 9000);
});
