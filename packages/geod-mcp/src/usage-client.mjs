import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { usageEvent, validateUsage } from './usage-schema.mjs';

export const DEFAULT_USAGE_URL = 'https://laogao.xyz/geod-mcp/usage';
export function usageHome(env = process.env) {
  return env.GEOD_CLI_HOME || (env.APPDATA ? path.join(env.APPDATA, 'GeoD CLI') : path.join(env.HOME || os.homedir(), '.geod-cli'));
}
export function usageEndpoint(value = DEFAULT_USAGE_URL) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      !(value === DEFAULT_USAGE_URL || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid usage endpoint');
  return url.href;
}
export async function configureUsage(action, env = process.env) {
  const home = usageHome(env), file = path.join(home, 'telemetry.json');
  let config = { schemaVersion: 1, enabled: false };
  try { config = JSON.parse(await readFile(file, 'utf8')); } catch { /* default off */ }
  if (['enable', 'disable'].includes(action)) {
    config = { schemaVersion: 1, enabled: action === 'enable' };
    await mkdir(home, { recursive: true });
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    if (!config.enabled) {
      const out = path.join(home, 'usage-outbox');
      for (const name of await readdir(out).catch(() => [])) if (/^[a-f0-9-]{36}\.json$/.test(name)) await unlink(path.join(out, name)).catch(() => {});
    }
  } else if (action !== 'status') throw new Error('Use telemetry enable|disable|status');
  return { ok: true, enabled: env.GEOD_TELEMETRY === '0' ? false : env.GEOD_TELEMETRY === '1' || (config.schemaVersion === 1 && config.enabled === true),
    message: '仅上报工具类型、随机安装标识与结果；不上传参数、路径、坐标、图源地址或密钥。关闭后清除待发送统计。' };
}

export class UsageClient {
  constructor(env = process.env) {
    this.env = env; this.home = usageHome(env); this.out = path.join(this.home, 'usage-outbox');
    this.tail = Promise.resolve(); this.pending = 0; this.sending = null; this.closed = false; this.bindings = new Map();
    this.ready = this.initialize().catch(() => false);
  }
  async initialize() {
    if (this.env.GEOD_USAGE_PARENT === 'mcp' || !(await configureUsage('status', this.env)).enabled) return false;
    this.endpoint = usageEndpoint(this.env.GEOD_USAGE_ENDPOINT);
    await mkdir(this.out, { recursive: true, mode: 0o700 });
    const file = path.join(this.home, 'usage-installation.json');
    try { await writeFile(file, JSON.stringify({ id: randomUUID() }), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    this.installationId = JSON.parse(await readFile(file, 'utf8')).id;
    return true;
  }
  emit(details) {
    if (this.closed || this.pending >= 2000) return;
    this.pending++;
    this.tail = this.tail.then(async () => {
      if (!await this.ready || !(await configureUsage('status', this.env)).enabled) return;
      const event = usageEvent({ installationId: this.installationId, isTest: this.env.GEOD_USAGE_TEST === '1' }, details);
      if ((await readdir(this.out)).length >= 2000) return;
      if (!this.bindings.has(event.attemptId)) {
        this.bindings.set(event.attemptId, (await this.session()).binding);
        if (this.bindings.size > 2000) this.bindings.delete(this.bindings.keys().next().value);
      }
      const binding = this.bindings.get(event.attemptId);
      const temporary = path.join(this.out, `${event.eventId}.tmp`);
      await writeFile(temporary, JSON.stringify({ event, sessionBinding: binding }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path.join(this.out, `${event.eventId}.json`));
      if (event.state !== 'started') this.bindings.delete(event.attemptId);
      void this.send();
    }).catch(() => {}).finally(() => { this.pending--; });
  }
  async send() {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      if (!await this.ready || this.closed || !(await configureUsage('status', this.env)).enabled) return;
      const names = (await readdir(this.out)).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).slice(0, 50);
      const events = [], files = []; let binding;
      for (const name of names) {
        try {
          const queued = JSON.parse(await readFile(path.join(this.out, name), 'utf8'));
          const event = validateUsage(queued.event, { local: true });
          if (binding === undefined) binding = queued.sessionBinding || null;
          if ((queued.sessionBinding || null) !== binding) continue;
          events.push(event); files.push(name);
        }
        catch { await unlink(path.join(this.out, name)).catch(() => {}); }
      }
      if (!events.length) return;
      const headers = { 'content-type': 'application/json' };
      // Reuse only a currently valid session; telemetry never opens login or refreshes credentials.
      const session = await this.session();
      if (binding && binding === session.binding && session.token) headers.authorization = `Bearer ${session.token}`;
      this.controller = new AbortController();
      const timer = setTimeout(() => this.controller?.abort(), 1000);
      let response;
      try { response = await fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify({ events }), redirect: 'error', signal: this.controller.signal }); }
      finally { clearTimeout(timer); }
      if (response.status === 202) for (const name of files) await unlink(path.join(this.out, name)).catch(() => {});
    })().catch(() => {}).finally(() => { this.sending = null; });
    return this.sending;
  }
  async session() {
    try {
      const session = JSON.parse(await readFile(path.join(this.home, 'account.json'), 'utf8'));
      const binding = typeof session.clientId === 'string' ? createHash('sha256').update(session.clientId).digest('hex') : null;
      return { binding, token: session.expiresAt > Date.now() / 1000 && /^[A-Za-z0-9_-]{32,}$/.test(session.accessToken) ? session.accessToken : null };
    } catch { return { binding: null, token: null }; }
  }
  async flush() { await this.tail; await this.send(); await this.send(); }
  async close() {
    let timer;
    await Promise.race([this.flush(), new Promise(resolve => { timer = setTimeout(resolve, 200); })]);
    clearTimeout(timer); this.closed = true; this.controller?.abort();
  }
}
