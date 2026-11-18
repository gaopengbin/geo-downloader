import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { DOWNLOAD_OUTCOMES_SQL } from '../download-outcomes.mjs'
import { validateEnvelope } from '../server.mjs'

test('task identity is accepted alongside legacy events and rejects private strings', () => {
  const base = { attempt_id: crypto.randomUUID(), state: 'failed', duration: 'unknown', reason: 'network' }
  const envelope = properties => ({ schema_version: 1, events: [{
    event_id: crypto.randomUUID(), install_id: crypto.randomUUID(), session_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(), app_version: '3.6.28', platform: 'windows',
    event: 'download_task_state', properties,
  }] })
  const properties = { ...base, task_id: crypto.randomUUID() }
  assert.deepEqual(validateEnvelope(envelope(properties))[0].properties, properties)
  assert.deepEqual(validateEnvelope(envelope(base))[0].properties, base)
  assert.throws(() => validateEnvelope(envelope({ ...base, task_id: 'C:/private/task.tif' })))
})

test('latest task outcomes join retries, isolate installations and handle delayed or duplicate events', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE events (install_id TEXT, event_name TEXT, properties_json TEXT, occurred_at TEXT, received_at TEXT, event_id TEXT)')
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)')
    const add = (task, attempt, state, day, install = 'a') => insert.run(install, 'download_task_state',
      JSON.stringify({ ...(task ? { task_id: task } : {}), attempt_id: attempt, state }),
      `2026-11-${day}T00:00:00Z`, '2026-11-20T00:00:00Z', crypto.randomUUID())
    add('recovered', 'second', 'completed', '12')
    add('recovered', 'first', 'failed', '10') // Delivered late.
    add('recovered', 'second', 'completed', '12') // Repeated terminal.
    add('recovered', 'different-device', 'failed', '13', 'b')
    add('retrying', 'first', 'failed', '10')
    add('retrying', 'second', 'started', '11')
    add('gaps', 'first', 'failed', '10')
    add('gaps', 'second', 'completed_with_gaps', '11')
    add(null, 'legacy', 'started', '10')
    add(null, 'legacy', 'failed', '11')
    assert.deepEqual({ ...db.prepare(DOWNLOAD_OUTCOMES_SQL).get() }, {
      observed_tasks: 4, completed_tasks: 1, recovered_tasks: 1, latest_failed_tasks: 1,
      completed_with_gaps_tasks: 1, cancelled_tasks: 0, in_progress_or_unreported_tasks: 1,
      legacy_unlinked_attempts: 1,
    })
  } finally { db.close() }
})
