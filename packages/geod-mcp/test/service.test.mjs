import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { GeoDService } from '../src/service.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'geod-service-test-'));
  const service = new GeoDService({ GEOD_WORKSPACE: directory, GEOD_OUTPUT_DIR: path.join(directory, 'output'), GEOD_MAX_CONCURRENT_JOBS: '1' });
  await service.ready;
  t.after(async () => {
    await service.close();
    const target = await realpath(directory);
    if (path.dirname(target) !== await realpath(tmpdir()) || !path.basename(target).startsWith('geod-service-test-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  });
  return service;
}

test('close waits for a reserved job and never starts its worker after shutdown', { timeout: 5000 }, async t => {
  const service = await fixture(t);
  const enteredPersist = deferred();
  const releasePersist = deferred();
  const persist = service.persist.bind(service);
  let firstPersist = true;
  let workerStarted = false;
  service.persist = async job => {
    if (firstPersist) {
      firstPersist = false;
      enteredPersist.resolve();
      await releasePersist.promise;
    }
    return persist(job);
  };
  const starting = service.startJob('test', async () => { workerStarted = true; return { ok: true }; });
  await enteredPersist.promise;
  let closeResolved = false;
  const closing = service.close().then(() => { closeResolved = true; });
  try {
    await nextTurn();
    assert.equal(closeResolved, false, 'closing must wait for a reservation that has not finished setup');
    assert.equal(workerStarted, false);
  } finally {
    releasePersist.resolve();
    await starting;
    await closing;
  }
  assert.equal(workerStarted, false, 'a worker must not start after close aborts its reservation');
  const job = [...service.jobs.values()][0];
  assert.equal(job.record.status, 'cancelled');
  const stored = JSON.parse(await readFile(path.join(job.dir, 'job.json'), 'utf8'));
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.error.code, 'CANCELLED');
});

test('failed reservation setup releases the slot and lets close finish', { timeout: 5000 }, async t => {
  const service = await fixture(t);
  const enteredPersist = deferred();
  const releasePersist = deferred();
  let workerStarted = false;
  service.persist = async () => {
    enteredPersist.resolve();
    await releasePersist.promise;
    throw Object.assign(new Error('Test persistence failure'), { code: 'TEST_PERSISTENCE' });
  };
  const starting = service.startJob('test', async () => { workerStarted = true; return { ok: true }; });
  // Attach the rejection assertion immediately, before releasing the failing write.
  const rejected = assert.rejects(starting, { code: 'TEST_PERSISTENCE' });
  await enteredPersist.promise;
  const closing = service.close();
  releasePersist.resolve();
  await rejected;
  await closing;
  assert.equal(workerStarted, false);
  assert.equal(service.jobs.size, 0);
});
