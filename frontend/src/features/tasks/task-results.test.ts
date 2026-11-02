import assert from 'node:assert/strict'
import test from 'node:test'
import { historyWithoutVisibleTasks, isTaskResultVisible } from './task-results.ts'

test('failed jobs remain visible regardless of provider or history availability', () => {
  assert.equal(isTaskResultVisible({ status: 'failed', source: 'osm_vector' }), true)
  assert.equal(isTaskResultVisible({ status: 'failed', source: 'gaode_satellite' }), true)
})
test('OSM success stays actionable while other existing terminal behavior is retained', () => {
  assert.equal(isTaskResultVisible({ status: 'completed', source: 'osm_vector' }), true)
  assert.equal(isTaskResultVisible({ status: 'completed', source: 'world_imagery' }), false)
  assert.equal(isTaskResultVisible({ status: 'cancelled', source: 'osm_vector' }), false)
  assert.equal(isTaskResultVisible({ status: 'completed_with_gaps', source: 'world_imagery' }), true)
  assert.equal(isTaskResultVisible({ status: 'future_state' }), true)
})
test('history deduplicates only by linked task ID, never output path or name', () => {
  const records = [{ id: 'failed', path: 'same.geojson' }, { id: 'success', path: 'same.geojson' }, { id: 'other', path: 'same.geojson' }]
  const tasks = [{ id: 'failed', status: 'failed', source: 'osm_vector' }, { id: 'success', status: 'completed', source: 'osm_vector' }]
  assert.deepEqual(historyWithoutVisibleTasks(records, tasks), [records[2]])
  assert.equal(records.length, 3)
})
test('removing a task reveals its durable history; empty task cache hides nothing', () => {
  const records = [{ id: 'result' }]
  assert.deepEqual(historyWithoutVisibleTasks(records, [{ id: 'result', status: 'completed', source: 'osm_vector' }]), [])
  assert.deepEqual(historyWithoutVisibleTasks(records, []), records)
})
