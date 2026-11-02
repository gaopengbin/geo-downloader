import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateEnvelope } from '../server.mjs'

function event(name, properties) {
  return { schema_version: 1, events: [{ event_id: crypto.randomUUID(), install_id: crypto.randomUUID(), session_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(), app_version: '3.6.25-test', platform: 'windows', event: name, properties }] }
}

test('client and collector share exactly the same feature schema', async () => {
  assert.equal(await readFile(new URL('../feature-events.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../../../frontend/src/features/telemetry/feature-events.mjs', import.meta.url), 'utf8'))
})

test('collector accepts all feature events but rejects extra private and invalid fields', () => {
  const samples = [
    ['overlay_configuration', { target: 'download', action: 'reorder', layer_count: '2-10' }],
    ['output_location_action', { action: 'copy_path', outcome: 'success', strict_file: true }],
    ['update_transfer_state', { state: 'switching', source: 'mirror', reason: 'slow', attempt: 1 }],
  ]
  for (const [name, properties] of samples) {
    assert.deepEqual(validateEnvelope(event(name, properties))[0].properties, properties)
    for (const key of ['path', 'headers', 'url', 'error', 'source_id']) assert.throws(() => validateEnvelope(event(name, { ...properties, [key]: 'private' })))
  }
  assert.throws(() => validateEnvelope(event('update_transfer_state', { state: 'failed', source: 'other-private', reason: 'other', attempt: 1 })))
  assert.throws(() => validateEnvelope(event('update_transfer_state', { state: 'failed', source: 'mirror', reason: 'other', attempt: 99 })))
})

test('OSM GeoJSON exports have their own output format category', () => {
  const properties = { workflow: 'osm', output_format: 'geojson', zoom_count: '0', selection: 'bounds' }
  assert.deepEqual(validateEnvelope(event('download_task_created', properties))[0].properties, properties)
})
