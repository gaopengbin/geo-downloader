import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, [path.join(packageRoot, 'src/index.mjs')], {
  env: process.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
});
const closed = new Promise(resolve => child.once('close', resolve));
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const waiting = new Map();
let nextId = 0;
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
function rejectAll(error) {
  for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(error); }
  waiting.clear();
}
child.on('error', rejectAll);
child.on('close', code => rejectAll(new Error(`MCP server exited ${code}: ${stderr}`)));
lines.on('line', line => {
  try {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    if (!Object.hasOwn(message, 'id')) return;
    const pending = waiting.get(message.id);
    assert.ok(pending, `Unexpected response ID ${message.id}`);
    waiting.delete(message.id);
    clearTimeout(pending.timer);
    message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
  } catch (error) { rejectAll(error); }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 10_000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
try {
  const initialized = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'geod-installer-check', version: '1.0.0' } });
  assert.equal(initialized.protocolVersion, '2025-11-25');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const names = (await call('tools/list')).tools.map(tool => tool.name);
  assert.ok(names.includes('geod_capabilities') && names.includes('geod_plan'));
  const capabilities = (await call('tools/call', { name: 'geod_capabilities', arguments: {} })).structuredContent;
  assert.equal(capabilities.cli.available, true);
  assert.equal(capabilities.geostyle.renderScriptAvailable, true);
  const example = await call('resources/read', { uri: 'geod://examples/henan' });
  const request = JSON.parse(example.contents[0].text);
  const plan = await call('tools/call', { name: 'geod_plan', arguments: { request } });
  assert.equal(plan.isError, undefined, JSON.stringify(plan));
  assert.equal(plan.structuredContent.ok, true);
  process.stdout.write(`${JSON.stringify({ ok: true, toolCount: names.length, cli: capabilities.cli.path, plan: true })}\n`);
} finally {
  if (!child.stdin.destroyed) child.stdin.end();
  const timer = setTimeout(() => child.kill(), 3000);
  await closed;
  clearTimeout(timer);
  lines.close();
}
