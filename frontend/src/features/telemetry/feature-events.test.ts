import assert from 'node:assert/strict'
import test from 'node:test'
import { validateFeatureTelemetry } from './feature-events.mjs'

test('feature events accept fixed actions without collecting source or output data', () => {
  for (const [name, properties] of [
    ['overlay_configuration', { target: 'preview', action: 'reorder', layer_count: '2-10' }],
    ['output_location_action', { action: 'open_folder', outcome: 'failed', strict_file: true }],
    ['update_transfer_state', { state: 'switching', source: 'mirror', reason: 'slow', attempt: 1 }],
  ] as const) {
    assert.deepEqual(validateFeatureTelemetry(name, properties), properties)
    for (const field of ['path', 'url', 'headers', 'source_id', 'error', 'filename']) {
      assert.throws(() => validateFeatureTelemetry(name, { ...properties, [field]: 'private value' }))
    }
  }
})

test('feature event validation rejects raw values and unbounded transfer counters', () => {
  assert.throws(() => validateFeatureTelemetry('overlay_configuration', { target: 'private-service', action: 'add', layer_count: '1' }))
  const transfer = { state: 'failed', source: 'github', reason: 'invalid', attempt: 1 }
  for (const attempt of [-1, 9, NaN, Infinity, 1.2, '1']) assert.throws(() => validateFeatureTelemetry('update_transfer_state', { ...transfer, attempt }))
  assert.throws(() => validateFeatureTelemetry('update_transfer_state', { ...transfer, reason: 'raw credential error' }))
  assert.throws(() => validateFeatureTelemetry('__proto__', {}))
})
