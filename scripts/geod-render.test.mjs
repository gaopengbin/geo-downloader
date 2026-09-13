import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fork, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCancellation } from './geod-render.mjs';

const script = fileURLToPath(new URL('./geod-render.mjs', import.meta.url));
const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(value => value && existsSync(value));

test('cancellation observes IPC, signals and parent disconnect without leaking listeners', () => {
  for (const event of ['SIGINT', 'SIGTERM', 'disconnect', 'message']) {
    const events = new EventEmitter();
    const cancellation = createCancellation(events);
    events.emit('message', { type: 'unrelated' });
    assert.equal(cancellation.signal.aborted, false);
    events.emit(event, { type: 'geod:cancel' });
    assert.equal(cancellation.signal.aborted, true);
    assert.equal(cancellation.signal.reason.code, 'CANCELLED');
    cancellation.dispose();
    assert.deepEqual(events.eventNames(), []);
  }
});

function childOutput(child, onProgress) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let ownedBrowser;
    let exited = false;
    let exitCode;
    const finished = () => {
      if (!exited || !child.stdout.readableEnded || !child.stderr.readableEnded) return;
      clearTimeout(timer);
      resolve({ code: exitCode, stdout, stderr, ownedBrowser });
    };
    const timer = setTimeout(() => {
      // Test fallback targets only the child and exact browser PID reported by
      // this invocation, never any unrelated Chrome session.
      if (child.connected) child.send({ type: 'geod:cancel' }, () => {});
      if (ownedBrowser?.pid) { try { process.kill(ownedBrowser.pid, 'SIGKILL'); } catch {} }
      child.kill();
      reject(new Error(`Renderer test exceeded 20 seconds: ${JSON.stringify({ stdout, stderr, connected: child.connected, exitCode: child.exitCode, pid: child.pid, ownedBrowser })}`));
    }, 20_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('end', finished);
    child.stderr.on('end', finished);
    child.on('message', value => {
      if (value?.type === 'geod:render-progress') {
        ownedBrowser = value;
        onProgress?.(value, child);
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    // Parent-initiated IPC disconnect can suppress ChildProcess's aggregate
    // close notification on Windows. Process exit plus both drained streams
    // establishes completion independently of that IPC bookkeeping.
    child.once('exit', code => { exited = true; exitCode = code; finished(); });
  });
}

test('argument failures produce one bounded JSON error and no stack trace', async () => {
  const child = spawn(process.execPath, [script, '--unknown', 'value'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await childOutput(child);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, false);
  assert.equal(value.error.code, 'RENDER_FAILED');
  assert.match(value.error.message, /Invalid argument/);
  assert.ok(result.stdout.length < 1_500);
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geod-render-test-'));
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    const ready = request.url.startsWith('/ready');
    response.end(`<style>html,body{margin:0;background:#123456}</style><script>window.__GEOD_RENDER__=${JSON.stringify(
      ready ? { state: 'ready', renderer: 'explicit-test-fixture', style: { fixture: true } } : { state: 'loading' },
    )}</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    directory,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise(resolve => server.close(resolve));
      // This exact directory was created by the test's mkdtemp above.
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('geod-render-test-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function launch(fixture, route, output) {
  return fork(script, ['--url', `${fixture.url}${route}`, '--out', output, '--width', '256', '--height', '256', '--chrome', chrome], {
    execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, TMP: fixture.directory, TEMP: fixture.directory, TMPDIR: fixture.directory },
  });
}

for (const mode of ['startup-ipc', 'evidence-ipc', 'parent-disconnect']) {
  test(`${mode} cancellation stops its real Chrome and removes its own profile`, { skip: !chrome, timeout: 25_000 }, async () => {
    const local = await fixture();
    try {
      const output = path.join(local.directory, 'map.png');
      let cancelled = false;
      const child = launch(local, '/waiting', output);
      const result = await childOutput(child, (value, running) => {
        const targetPhase = mode === 'startup-ipc' ? 'browser-started' : 'waiting-for-evidence';
        if (!cancelled && value.phase === targetPhase) {
          cancelled = true;
          if (mode === 'parent-disconnect') running.disconnect();
          else running.send({ type: 'geod:cancel' });
        }
      });
      assert.equal(cancelled, true, result.stdout);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).error.code, 'CANCELLED', result.stdout);
      assert.equal(existsSync(output), false);
      assert.ok(result.ownedBrowser?.pid);
      assert.throws(() => process.kill(result.ownedBrowser.pid, 0), { code: 'ESRCH' });
      assert.equal(existsSync(result.ownedBrowser.profile), false);
      assert.deepEqual(await readdir(local.directory), []);
    } finally { await local.close(); }
  });
}

test('successful rendering keeps its JSON/artifacts and also cleans Chrome', { skip: !chrome, timeout: 25_000 }, async () => {
  const local = await fixture();
  try {
    const output = path.join(local.directory, 'map.png');
    const result = await childOutput(launch(local, '/ready', output));
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, '');
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, true);
    assert.equal(value.image, output);
    assert.equal(value.renderer, 'explicit-test-fixture');
    const png = await readFile(output);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 256);
    assert.equal(png.readUInt32BE(20), 256);
    assert.deepEqual(JSON.parse(await readFile(value.openStyle, 'utf8')), { fixture: true });
    assert.equal(JSON.parse(await readFile(value.evidence, 'utf8')).state, 'ready');
    assert.equal(existsSync(result.ownedBrowser.profile), false);
    assert.throws(() => process.kill(result.ownedBrowser.pid, 0), { code: 'ESRCH' });
    const refused = await childOutput(launch(local, '/ready', output));
    assert.equal(refused.code, 1);
    assert.match(JSON.parse(refused.stdout).error.message, /Output exists/);
    assert.deepEqual(await readFile(output), png);
  } finally { await local.close(); }
});
