#!/usr/bin/env node
// Standalone browser renderer: a fresh, isolated Chrome profile, no dependencies.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

function cancellationError() {
  const error = new Error('Render cancelled');
  error.code = 'CANCELLED';
  return error;
}

// Windows SIGTERM forcibly terminates Node, bypassing its JS signal handlers.
// Callers on Windows must use an IPC channel and send {type: 'geod:cancel'}.
export function createCancellation(events = process) {
  const controller = new AbortController();
  const cancel = () => controller.abort(cancellationError());
  const message = value => { if (value?.type === 'geod:cancel') cancel(); };
  events.on('SIGINT', cancel);
  events.on('SIGTERM', cancel);
  events.on('disconnect', cancel);
  events.on('message', message);
  return {
    signal: controller.signal,
    dispose() {
      events.off('SIGINT', cancel);
      events.off('SIGTERM', cancel);
      events.off('disconnect', cancel);
      events.off('message', message);
    },
  };
}

function progress(value) {
  if (process.connected) {
    try { process.send({ type: 'geod:render-progress', ...value }, () => {}); } catch {}
  }
}

function openSocket(address, signal, timeoutMs = 10_000) {
  const socket = new WebSocket(address);
  // WebSocket errors are handled by promises, including a close during setup.
  socket.addEventListener('error', () => {});
  const opened = new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(socket);
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error('Chrome debugging connection failed'));
    const onClose = () => finish(new Error('Chrome debugging connection closed'));
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('Chrome debugging connection timed out')), timeoutMs);
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  return { socket, opened };
}

function browserExited(browser) {
  return !browser?.pid || browser.exitCode != null || browser.signalCode != null;
}

async function waitForExit(browser, timeoutMs) {
  if (browserExited(browser)) return true;
  return new Promise(resolve => {
    const done = exited => { clearTimeout(timer); browser.off('exit', onExit); resolve(exited); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    browser.once('exit', onExit);
    if (browserExited(browser)) done(true);
  });
}

async function cleanBrowser(browser, socket, profile, tempRoot) {
  let closeSocket;
  try {
    if (!browserExited(browser)) {
      // Prefer Chrome's own shutdown so it stops its subprocesses and releases
      // profile locks. Cleanup deliberately does not use the aborted signal.
      let channel = socket?.readyState === WebSocket.OPEN ? socket : undefined;
      if (!channel) {
        // Cancellation can arrive before startup has written its debugging port.
        for (let attempt = 0; attempt < 10 && !browserExited(browser); attempt++) {
          let browserAddress;
          try {
            const [portText, browserPath] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
            const port = Number(portText);
            if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[\w-]+$/.test(browserPath)) {
              browserAddress = `ws://127.0.0.1:${port}${browserPath}`;
            }
          } catch {}
          if (browserAddress) {
            const connection = openSocket(browserAddress, undefined, 750);
            closeSocket = connection.socket;
            try { channel = await connection.opened; } catch {}
            break;
          }
          await delay(75);
        }
      }
      if (channel?.readyState === WebSocket.OPEN) {
        try { channel.send(JSON.stringify({ id: -1, method: 'Browser.close' })); } catch {}
      }
      if (!(await waitForExit(browser, 1_500))) {
        // Only this invocation's exact child PID is terminated. Never kill by
        // browser name or affect the user's normal browser sessions.
        browser.kill('SIGTERM');
        if (!(await waitForExit(browser, 1_500))) {
          browser.kill('SIGKILL');
          if (!(await waitForExit(browser, 1_500))) throw new Error('Owned Chrome process did not exit');
        }
      }
    }
  } finally {
    try { socket?.close(); } catch {}
    try { closeSocket?.close(); } catch {}
  }
  if (profile) {
    // Resolve the actual target before recursive deletion. Refuse replacements
    // pointing outside the temporary root used by this invocation.
    let resolved;
    try { resolved = await realpath(profile); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const root = await realpath(tempRoot);
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('geod-render-')) {
      throw new Error('Refusing to remove an unexpected Chrome profile path');
    }
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

async function render(argv, signal) {
  signal.throwIfAborted();
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--url', '--out', '--width', '--height', '--chrome'].includes(key) || !argv[i + 1] || args.has(key)) throw new Error(`Invalid argument: ${key}`);
    args.set(key, argv[i + 1]);
  }
  if (!args.has('--url') || !args.has('--out')) throw new Error('Usage: node scripts/geod-render.mjs --url http://127.0.0.1:3100/render/geod/ID --out map.png [--width 1600 --height 1000 --chrome PATH]');
  const url = new URL(args.get('--url'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Render URL must be HTTP(S)');
  const width = Number(args.get('--width') ?? 1600);
  const height = Number(args.get('--height') ?? 1000);
  if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 4096)) throw new Error('Dimensions must be 256..4096');
  url.searchParams.set('width', String(width));
  url.searchParams.set('height', String(height));
  const output = path.resolve(args.get('--out'));
  const evidenceOutput = `${output}.render.json`;
  const styleOutput = `${output}.openstyle.json`;
  for (const p of [output, evidenceOutput, styleOutput]) if (existsSync(p)) throw new Error(`Output exists: ${p}`);
  const chromePath = args.get('--chrome') ?? process.env.CHROME_PATH ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
  if (!chromePath) throw new Error('Chrome/Chromium not found. Set CHROME_PATH or --chrome.');

  const tempRoot = path.resolve(os.tmpdir());
  let profile;
  let browser;
  let socket;
  let id = 0;
  const pending = new Map();
  const rejectPending = error => { for (const task of [...pending.values()]) task.finish(error); };
  const onAbort = () => rejectPending(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  function call(method, params = {}) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const finish = (error, result) => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`CDP timeout: ${method}`)), 30_000);
      pending.set(requestId, { finish });
      try { socket.send(JSON.stringify({ id: requestId, method, params })); } catch (error) { finish(error); }
    });
  }
  try {
    await mkdir(path.dirname(output), { recursive: true });
    signal.throwIfAborted();
    profile = await mkdtemp(path.join(tempRoot, 'geod-render-'));
    signal.throwIfAborted();
    browser = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--window-size=${width},${height}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let launchError;
    browser.on('error', error => { launchError = error; });
    browser.once('spawn', () => progress({ phase: 'browser-started', pid: browser.pid, profile }));
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
      signal.throwIfAborted();
      if (launchError) throw launchError;
      if (browserExited(browser)) throw new Error(`Chrome exited: ${browser.exitCode ?? browser.signalCode}`);
      try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
      if (port) break;
      await delay(200, undefined, { signal });
    }
    if (!port) throw new Error('Chrome startup timed out');
    signal.throwIfAborted();
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }).then(r => r.json());
    const target = tabs.find(tab => tab.type === 'page');
    if (!target) throw new Error('Chrome page target unavailable');
    const connection = openSocket(target.webSocketDebuggerUrl, signal);
    socket = connection.socket;
    await connection.opened;
    socket.addEventListener('close', () => rejectPending(new Error('Chrome debugging connection closed')));
    socket.addEventListener('error', () => rejectPending(new Error('Chrome debugging connection failed')));
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        const task = pending.get(message.id);
        if (task) task.finish(message.error ? new Error(message.error.message) : undefined, message.result);
      } catch { rejectPending(new Error('Invalid Chrome debugging response')); }
    });
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const navigation = await call('Page.navigate', { url: url.href });
    if (navigation.errorText) throw new Error(navigation.errorText);
    progress({ phase: 'waiting-for-evidence', pid: browser.pid, profile });
    let evidence;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const status = await call('Runtime.evaluate', { expression: 'window.__GEOD_RENDER__ ?? null', returnByValue: true });
      const value = status.result?.value;
      if (value?.state === 'error') throw new Error(`Map render failed: ${value.error}`);
      if (value?.state === 'ready') { evidence = value; break; }
      await delay(300, undefined, { signal });
    }
    if (!evidence) throw new Error('Map did not produce real render evidence within 90 seconds');
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width, height, scale: 1 } });
    signal.throwIfAborted();
    await writeFile(output, Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
    signal.throwIfAborted();
    await writeFile(evidenceOutput, JSON.stringify(evidence, null, 2), { flag: 'wx' });
    signal.throwIfAborted();
    if (evidence.style) await writeFile(styleOutput, JSON.stringify(evidence.style, null, 2), { flag: 'wx' });
    signal.throwIfAborted();
    return { ok: true, image: output, evidence: evidenceOutput, openStyle: evidence.style ? styleOutput : null, width, height, renderer: evidence.renderer };
  } finally {
    signal.removeEventListener('abort', onAbort);
    rejectPending(new Error('Browser closed'));
    try { await cleanBrowser(browser, socket, profile, tempRoot); } catch (error) {
      error.code = 'CLEANUP_FAILED';
      throw error;
    }
  }
}

async function main() {
  const cancellation = createCancellation();
  try {
    const result = await render(process.argv.slice(2), cancellation.signal);
    cancellation.signal.throwIfAborted();
    console.log(JSON.stringify(result));
  } catch (error) {
    const cancelled = cancellation.signal.aborted && error?.code !== 'CLEANUP_FAILED';
    const message = String(cancelled ? 'Render cancelled' : error?.message ?? error).replace(/\s+/g, ' ').slice(0, 1_200);
    console.log(JSON.stringify({ ok: false, error: { code: cancelled ? 'CANCELLED' : error?.code === 'CLEANUP_FAILED' ? 'CLEANUP_FAILED' : 'RENDER_FAILED', message } }));
    process.exitCode = 1;
  } finally {
    cancellation.dispose();
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
