import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { validateUsage, usageEvent } from './usage-schema.mjs';

// Observations are journaled outside OAuth state and job records. A disk failure
// disables observations only; it must never reject an authorization or a job.
export class UsageStore {
  constructor(directory, { isTest = false } = {}) {
    this.directory = directory; this.isTest = isTest; this.pending = 0; this.seen = new Set();
    this.tail = Promise.resolve(); this.enabled = false;
    this.ready = this.initialize().catch(() => false);
  }
  async initialize() {
    if (!this.directory) return false;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'metadata.json');
    try { await writeFile(file, JSON.stringify({ schemaVersion: 1, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const metadata = JSON.parse(await readFile(file, 'utf8'));
    this.enabled = metadata.schemaVersion === 1 && Number.isFinite(Date.parse(metadata.startedAt));
    return this.enabled;
  }
  accept(event, actor = {}) {
    if (!this.directory || this.pending >= 2000) return Promise.resolve(false);
    let clean;
    try { clean = validateUsage(event); } catch { return Promise.resolve(false); }
    const userId = /^user-[a-f0-9-]{36}$/i.test(actor.userId || '') ? actor.userId : null;
    const actorType = actor.internal ? 'internal' : userId ? 'account' : 'anonymous';
    // Account identity is server supplied. A client can only mark itself as test.
    const record = { ...clean, isTest: clean.isTest || this.isTest, userId, actorType,
      receivedAt: new Date().toISOString() };
    this.pending++;
    const result = this.tail.then(async () => {
      await this.ready;
      if (!this.enabled) return false;
      const key = `${actorType}:${userId || clean.installationId || ''}:${clean.eventId}`;
      if (this.seen.has(key)) return true;
      await appendFile(path.join(this.directory, `${record.receivedAt.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      this.seen.add(key);
      if (this.seen.size > 20000) this.seen.delete(this.seen.values().next().value);
      return true;
    }).catch(() => false).finally(() => { this.pending--; });
    this.tail = result;
    return result;
  }
  observer(context, actor = {}) {
    return { emit: details => {
      try { void this.accept(usageEvent(context, details), actor); } catch { /* Never affect the operation. */ }
    } };
  }
  async flush() { await this.tail; }
}

export function usageIngest(store, identify) {
  const rates = new Map();
  return async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST') return reply(405, { ok: false });
    await store.ready;
    if (!store.enabled) return reply(503, { ok: false });
    // Ephemeral limiter only; IPs never enter the journal.
    const key = req.socket.remoteAddress || 'unknown', minute = Math.floor(Date.now() / 60000);
    const rate = rates.get(key);
    if (rate?.minute === minute && rate.count >= 120) return reply(429, { ok: false });
    if (rates.size > 10000) rates.clear();
    rates.set(key, { minute, count: rate?.minute === minute ? rate.count + 1 : 1 });
    const actor = identify(req.headers.authorization);
    if (!actor) return reply(401, { ok: false });
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 65536) return reply(413, { ok: false }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (Object.keys(input).join() !== 'events' || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > 50) return reply(400, { ok: false });
      const events = input.events.map(event => validateUsage(event, { local: true }));
      const results = await Promise.all(events.map(event => store.accept(event, actor)));
      return reply(results.every(Boolean) ? 202 : 503, { ok: results.every(Boolean) });
    } catch { return reply(400, { ok: false }); }
  };
}
