import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectClient, installCodex, installWorkBuddy, MCP_NAME, MCP_URL } from '../src/install.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
function tempHome(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'geod-agent-test-'));
  t.after(() => {
    assert.ok(path.resolve(home).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('WorkBuddy install preserves other MCP servers, backs up config, and is idempotent', t => {
  const home = tempHome(t);
  const workbuddy = path.join(home, '.workbuddy');
  mkdirSync(workbuddy);
  const configPath = path.join(workbuddy, 'mcp.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: { unrelated: { command: 'example', args: [] } }, custom: true }));
  const first = installWorkBuddy({ home });
  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(saved.mcpServers.unrelated, { command: 'example', args: [] });
  assert.equal(saved.custom, true);
  assert.deepEqual(saved.mcpServers[MCP_NAME], { type: 'streamableHttp', url: MCP_URL });
  assert.ok(existsSync(first.mcp.backup));
  assert.ok(existsSync(first.skill.path));
  const second = installWorkBuddy({ home });
  assert.equal(second.mcp.action, 'kept');
  assert.equal(second.skill.action, 'kept');
});

test('Codex install adds only the hosted MCP and upgrades an unchanged old Skill', t => {
  const home = tempHome(t);
  const codexHome = path.join(home, '.codex');
  const destination = path.join(codexHome, 'skills', 'geod-agent');
  mkdirSync(destination, { recursive: true });
  writeFileSync(path.join(destination, 'SKILL.md'), readFileSync(path.join(packageRoot, 'legacy', 'geod-agent-0.1.2.md')));
  const calls = [];
  const runCodex = args => {
    calls.push(args);
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(existsSync(path.join(codexHome, 'config.toml'))
      ? [{ name: MCP_NAME, transport: { type: 'streamable_http', url: MCP_URL } }] : []), stderr: '' };
    throw new Error(`Unexpected Codex command: ${args.join(' ')}`);
  };
  const result = installCodex({ home, env: {}, runCodex });
  assert.deepEqual(calls, [['mcp', 'list', '--json'], ['mcp', 'list', '--json']]);
  assert.match(readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), /\[mcp_servers\.geod-cloud\]/);
  assert.equal(result.skill.action, 'upgraded');
  assert.ok(existsSync(result.skill.backup));
  assert.equal(readFileSync(result.skill.path, 'utf8'), readFileSync(path.join(packageRoot, 'skill', 'geod-agent', 'SKILL.md'), 'utf8'));
});

test('ambiguous client and conflicting registrations do not change user files', t => {
  const home = tempHome(t);
  mkdirSync(path.join(home, '.codex'));
  mkdirSync(path.join(home, '.workbuddy'));
  assert.throws(() => detectClient({ home, env: {} }), /choose the current Agent/);
  const configPath = path.join(home, '.workbuddy', 'mcp.json');
  const original = JSON.stringify({ mcpServers: { [MCP_NAME]: { type: 'streamableHttp', url: 'https://example.com/mcp' } } });
  writeFileSync(configPath, original);
  assert.throws(() => installWorkBuddy({ home }), /different geod-cloud/);
  assert.equal(readFileSync(configPath, 'utf8'), original);
  assert.equal(existsSync(path.join(home, '.agents', 'skills', 'geod-agent')), false);
});
