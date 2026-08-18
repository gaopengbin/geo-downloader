import assert from 'node:assert/strict'
import test from 'node:test'

import { getTaskStatusKey } from './task-copy.ts'

test('maps every known task state to a translation key', () => {
  assert.equal(getTaskStatusKey('pending'), 'tasks.status.pending')
  assert.equal(getTaskStatusKey('completed_with_gaps'), 'tasks.status.completed_with_gaps')
  assert.equal(getTaskStatusKey('building_pyramid'), 'tasks.status.building_pyramid')
})

test('preserves unknown backend states for forward compatibility', () => {
  assert.equal(getTaskStatusKey('future_state'), null)
})
