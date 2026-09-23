#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../../', import.meta.url));
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/package-smoke.mjs PACKAGE_DIRECTORY SICHUAN_BUNDLE_DIRECTORY');
const packageDir = path.resolve(process.argv[2]);
const bundleDir = path.resolve(process.argv[3]);
const config = JSON.parse(await readFile(path.join(packageDir, 'mcp.config.json'), 'utf8')).mcpServers.geod;
const transport = new StdioClientTransport({ ...config, env: { ...process.env, ...config.env, GEOD_WORKSPACE: root, GEOD_OUTPUT_DIR: path.join(root, 'output/geod-mcp-package-check') }, stderr: 'pipe' });
const client = new Client({ name: 'geod-portable-package-check', version: '0.1.0' });
const errors = [];
client.onerror = error => errors.push(error.message);
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
}
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 8);
  const capabilities = (await call('geod_capabilities')).structuredContent;
  assert.equal(path.resolve(capabilities.cli.path), path.join(packageDir, 'bin/geod.exe'));
  assert.equal(capabilities.cli.available, true);
  const example = await client.readResource({ uri: 'geod://examples/sichuan' });
  const request = JSON.parse(example.contents[0].text);
  const plan = (await call('geod_plan', { request })).structuredContent;
  const openStyle = JSON.parse(await readFile(path.join(packageDir, 'examples/sichuan-overview.openstyle.json'), 'utf8'));
  let job = (await call('geod_render', { bundleDir, openStyle, width: 1600, height: 1200 })).structuredContent;
  const started = Date.now();
  while (job.status === 'running' && Date.now() - started < 180_000) {
    await new Promise(resolve => setTimeout(resolve, 250));
    job = (await call('geod_job_status', { jobId: job.jobId })).structuredContent;
  }
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const image = (await call('geod_get_artifact', { jobId: job.jobId, artifactId: 'preview' })).content.find(c => c.type === 'image');
  assert.ok(image?.data.length > 1000);
  assert.deepEqual(errors, []);
  const result = { ok: true, verifiedAt: new Date().toISOString(), packageDir, cli: capabilities.cli, plan, renderJob: job, nativePreview: { mimeType: image.mimeType, bytes: Buffer.from(image.data, 'base64').length }, protocolErrors: errors };
  const report = path.join(root, 'output/geod-mcp-package-check/verification.json');
  await writeFile(report, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, packageDir, report, image: job.result.image, elapsedMs: Date.now() - started }));
} finally { await client.close(); }
