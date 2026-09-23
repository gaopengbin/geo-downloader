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
const client = new Client({ name: 'geod-portable-package-check', version: '0.1.1' });
const errors = [];
client.onerror = error => errors.push(error.message);
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
}
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(names.length, 7);
  assert.ok(!names.includes('geod_render'));
  const capabilities = (await call('geod_capabilities')).structuredContent;
  assert.equal(path.resolve(capabilities.cli.path), path.join(packageDir, 'bin/geod.exe'));
  assert.equal(capabilities.cli.available, true);
  const example = await client.readResource({ uri: 'geod://examples/sichuan' });
  const request = JSON.parse(example.contents[0].text);
  const plan = (await call('geod_plan', { request })).structuredContent;
  const inspected = (await call('geod_inspect', { bundleDir })).structuredContent;
  assert.equal(inspected.ok, true);
  assert.deepEqual(errors, []);
  const result = { ok: true, verifiedAt: new Date().toISOString(), packageDir, cli: capabilities.cli, plan, inspection: { quality: inspected.manifest?.quality }, protocolErrors: errors };
  const report = path.join(root, 'output/geod-mcp-package-check/verification.json');
  await writeFile(report, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, packageDir, report, tools: names }));
} finally { await client.close(); }
