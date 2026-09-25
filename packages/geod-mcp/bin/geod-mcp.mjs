#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (!args.length || (args.length === 1 && args[0] === 'serve')) {
  await import('../src/index.mjs');
} else if (args[0] === 'install' && ['codex', 'workbuddy'].includes(args[1])) {
  const optionIndex = args.indexOf('--workspace');
  const packageIndex = args.indexOf('--package');
  if ((optionIndex >= 0 && !args[optionIndex + 1]) || (packageIndex >= 0 && !args[packageIndex + 1])) {
    throw new Error('--workspace and --package require values');
  }
  const known = new Set(['install', args[1], '--workspace', '--package']);
  for (let i = 2; i < args.length; i++) {
    if (['--workspace', '--package'].includes(args[i])) { i++; continue; }
    if (!known.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  }
  const userData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const workspace = path.resolve(optionIndex >= 0 ? args[optionIndex + 1] : path.join(userData, 'GeoD', 'Workspace'));
  const packageSpec = packageIndex >= 0 ? args[packageIndex + 1] : 'https://laogao.xyz/geod-mcp/geod-mcp-0.1.6.tgz';
  const script = args[1] === 'codex' ? 'install-geod-codex.ps1' : 'install-geod-workbuddy.ps1';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', path.join(root, 'scripts', script), '-PackageSpec', packageSpec, '-Workspace', workspace], { stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else if (args[0] === 'auth' && ['login', 'status', 'logout'].includes(args[1]) && args.length === 2) {
  const binary = path.join(root, 'bin', process.platform === 'win32' ? 'geod.exe' : 'geod');
  const result = spawnSync(binary, ['auth', args[1]], { stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  process.stderr.write('Usage: geod-mcp [serve | install codex|workbuddy [--workspace PATH] [--package SPEC] | auth login|status|logout]\n');
  process.exitCode = 2;
}
