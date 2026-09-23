#!/usr/bin/env node
// Runs the complete chain through the public MCP wire protocol, including image readback.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const reportDir = path.join(root, 'output', `geod-mcp-verification-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(reportDir, { recursive: true });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))], env: { ...process.env, GEOD_WORKSPACE: root, GEOD_OUTPUT_DIR: path.join(reportDir, 'jobs') }, stderr: 'pipe' });
const client = new Client({ name: 'geod-live-verification', version: '0.1.0' });
const protocolErrors = [], stderr = [];
client.onerror = error => protocolErrors.push(error.message);
transport.stderr?.on('data', data => stderr.push(String(data)));
const started = Date.now();
const timings = {};
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content.find(item => item.type === 'text').text), result.structuredContent);
  return result;
}
async function job(name, args) {
  const start = Date.now();
  let status = (await call(name, args)).structuredContent;
  assert.equal(status.status, 'running');
  const deadline = Date.now() + 300_000;
  while (['running', 'cancelling'].includes(status.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    status = (await call('geod_job_status', { jobId: status.jobId })).structuredContent;
  }
  assert.equal(status.status, 'completed', JSON.stringify(status));
  timings[name] = Date.now() - start;
  return status;
}
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  const resource = await client.readResource({ uri: 'geod://examples/sichuan' });
  const request = JSON.parse(resource.contents[0].text);
  assert.equal(request.imagery.clipToLayer, 'boundary');
  const plan = (await call('geod_plan', { request })).structuredContent;
  const fetched = await job('geod_fetch', { request });
  const inspected = (await call('geod_inspect', { bundleDir: fetched.result.bundleDir })).structuredContent;
  assert.equal(inspected.manifest.quality.status, 'complete');
  const raw = await call('geod_get_artifact', { jobId: fetched.jobId, artifactId: 'imagery-preview' });
  assert.equal(raw.content.find(item => item.type === 'image')?.mimeType, 'image/png');
  const openStyle = JSON.parse(await readFile(path.join(root, 'examples/geod-cli/sichuan-overview.openstyle.json'), 'utf8'));
  const rendered = await job('geod_render', { bundleDir: fetched.result.bundleDir, openStyle, renderer: 'openlayers', width: 1600, height: 1200 });
  const imageResult = await call('geod_get_artifact', { jobId: rendered.jobId, artifactId: 'map' });
  const image = imageResult.content.find(item => item.type === 'image');
  assert.equal(image?.mimeType, 'image/png');
  // This file is decoded from the MCP image block, not copied from the renderer output.
  const imagePath = path.join(reportDir, 'sichuan-via-mcp.png');
  await writeFile(imagePath, Buffer.from(image.data, 'base64'), { flag: 'wx' });
  const preview = await call('geod_get_artifact', { jobId: rendered.jobId, artifactId: 'preview' });
  assert.ok(preview.content.some(item => item.type === 'image'));
  const evidenceResource = await client.readResource({ uri: rendered.artifacts.find(a => a.id === 'render-evidence').uri });
  const evidence = JSON.parse(evidenceResource.contents[0].text);
  assert.equal(evidence.state, 'ready');
  assert.equal(evidence.observation.renderedFeatures, 21);
  assert.deepEqual(protocolErrors, []);
  const report = { ok: true, verifiedAt: new Date().toISOString(), protocol: 'official SDK 2.0.0 stdio Client', tools: tools.tools.map(t => t.name), timings: { ...timings, total: Date.now() - started }, imagePath, plan, fetched, rendered, protocolErrors, stderr: stderr.join('') };
  await writeFile(path.join(reportDir, 'verification.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, reportDir, imagePath, timings: report.timings, fetchJobId: fetched.jobId, renderJobId: rendered.jobId }));
} finally { await client.close(); }
