import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { UsageStore, usageIngest } from '../src/usage-store.mjs';
import { UsageClient, configureUsage, usageEndpoint } from '../src/usage-client.mjs';
import { usageEvent, validateUsage, usageReason, downloadOutcome } from '../src/usage-schema.mjs';
import { GeoDService } from '../src/service.mjs';

async function journal(dir) {
  const files = (await readdir(dir)).filter(n => n.endsWith('.jsonl'));
  return (await Promise.all(files.map(n => readFile(path.join(dir, n), 'utf8')))).flatMap(s => s.trim().split('\n').filter(Boolean).map(JSON.parse));
}
const detail = { kind: 'tool', operation: 'geod_plan', state: 'succeeded' };

test('wire contract rejects private fields, impersonation and server-only events', () => {
  const e = usageEvent({ installationId: randomUUID() }, detail);
  assert.deepEqual(validateUsage(e, { local: true }), e);
  for (const key of ['email', 'userId', 'url', 'path', 'arguments', 'token']) assert.throws(() => validateUsage({ ...e, [key]: 'private' }));
  assert.throws(() => validateUsage({ ...e, reason: 'secret raw error' }));
  assert.throws(() => validateUsage({ ...e, transport: 'http' }, { local: true }));
  assert.throws(() => validateUsage({ ...e, kind: 'authorization', operation: 'login' }, { local: true }));
  assert.throws(() => usageEndpoint('https://other.example/collect'));
  assert.throws(() => usageEndpoint('http://127.0.0.1:10/?token=secret'));
  assert.equal(usageReason(new Error('HTTP 502 https://example.com/?token=secret')), 'network');
  assert.equal(downloadOutcome({ manifest: { quality: { status: 'partial', missingTiles: 1 } } }), 'partial');
  assert.equal(downloadOutcome({}), null);
});

test('collector persists once, trusts only server identity, and degrades safely on disk failure', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'geod-usage-store-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new UsageStore(path.join(home, 'journal'));
  const e = usageEvent({ installationId: randomUUID() }, detail);
  const actor = { userId: `user-${randomUUID()}` };
  assert.deepEqual(await Promise.all([store.accept(e, actor), store.accept(e, actor)]), [true, true]);
  const records = await journal(store.directory);
  assert.equal(records.length, 1); assert.equal(records[0].userId, actor.userId);
  await writeFile(path.join(home, 'not-a-directory'), 'occupied');
  const bad = new UsageStore(path.join(home, 'not-a-directory', 'usage'));
  assert.equal(await bad.accept(e), false);
  assert.doesNotThrow(() => bad.observer({}).emit(detail));
  await bad.flush();
});

test('disabled clients send nothing; offline outbox replays without changing identity or duplicating', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'geod-usage-client-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new UsageStore(path.join(home, 'journal'));
  let offline = true, requests = 0, sawAuthorization = false;
  const ingest = usageIngest(store, header => { sawAuthorization ||= Boolean(header); return header ? { userId: `user-${'a'.repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` } : {}; });
  const server = createServer((req, res) => { requests++; if (offline) { res.writeHead(503); res.end(); } else void ingest(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { GEOD_CLI_HOME: path.join(home, 'cli'), GEOD_USAGE_ENDPOINT: `http://127.0.0.1:${server.address().port}/usage`, GEOD_USAGE_TEST: '1' };
  const off = new UsageClient(env); off.emit(detail); await off.flush();
  assert.equal(requests, 0);
  await configureUsage('enable', env);
  await writeFile(path.join(env.GEOD_CLI_HOME, 'account.json'), JSON.stringify({ clientId: 'first-login', accessToken: 'a'.repeat(43), expiresAt: Date.now() / 1000 + 3600 }));
  const client = new UsageClient(env); client.emit(detail); await client.flush();
  const out = path.join(env.GEOD_CLI_HOME, 'usage-outbox');
  assert.equal((await readdir(out)).length, 1);
  const pending = await readFile(path.join(out, (await readdir(out))[0]), 'utf8');
  assert.ok(!pending.includes('a'.repeat(43))); // no credentials stored in statistics
  await writeFile(path.join(env.GEOD_CLI_HOME, 'account.json'), JSON.stringify({ clientId: 'second-login', accessToken: 'b'.repeat(43), expiresAt: Date.now() / 1000 + 3600 }));
  offline = false; sawAuthorization = false;
  await client.flush();
  assert.equal(sawAuthorization, false); // old work cannot be attributed to a newly logged-in account
  assert.equal((await readdir(out)).length, 0);
  const records = await journal(store.directory);
  assert.equal(records.length, 1); assert.equal(records[0].isTest, true); assert.equal(records[0].actorType, 'anonymous');
  await writeFile(path.join(out, `${records[0].eventId}.json`), pending);
  await client.flush();
  assert.equal((await journal(store.directory)).length, 1);
  await configureUsage('disable', env);
  const before = requests; client.emit(detail); await client.flush();
  assert.equal(requests, before);
  const child = new UsageClient({ ...env, GEOD_TELEMETRY: '1', GEOD_USAGE_PARENT: 'mcp' });
  child.emit(detail); await child.flush(); assert.equal(requests, before);
  await client.close();
});

test('ingestion refuses forged authorization and identity without saving rejected data', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'geod-usage-ingest-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new UsageStore(home);
  const server = createServer((req, res) => void usageIngest(store, () => ({}))(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const e = usageEvent({ installationId: randomUUID() }, detail);
  for (const event of [{ ...e, userId: 'forged' }, { ...e, kind: 'authorization', operation: 'login' }, { ...e, transport: 'http' }]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/usage`, { method: 'POST', body: JSON.stringify({ events: [event] }) });
    assert.equal(response.status, 400);
  }
  assert.equal((await journal(home)).length, 0);
});

test('collector disk failure cannot fail a real job; cancellation is a terminal observation', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'geod-usage-job-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'blocked'), 'occupied');
  const store = new UsageStore(path.join(home, 'blocked', 'journal'));
  const service = new GeoDService({ GEOD_WORKSPACE: home, GEOD_TELEMETRY: '0' });
  await service.ready; service.usage = store.observer({ transport: 'http' });
  const completed = await service.startJob('fetch', async () => ({ manifest: { quality: { status: 'complete' } } }));
  await service.jobs.get(completed.jobId).done;
  assert.equal((await service.jobStatus(completed.jobId)).status, 'completed');
  await store.flush();
  const observations = []; service.usage = { emit: event => observations.push(event) };
  const cancelled = await service.startJob('fetch', async job => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('User stopped the task'), { code: 'CANCELLED' }));
    if (job.controller.signal.aborted) abort(); else job.controller.signal.addEventListener('abort', abort, { once: true });
  }));
  await service.cancelJob(cancelled.jobId); await service.jobs.get(cancelled.jobId).done;
  assert.deepEqual(observations.map(e => e.state), ['started', 'cancelled']);
  await service.close();
});
