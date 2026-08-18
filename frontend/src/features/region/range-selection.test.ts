import assert from 'node:assert/strict'
import test from 'node:test'

import { updateRangeSelection } from './range-selection.ts'

test('toggles a single item without an anchor', () => {
  assert.deepEqual([...updateRangeSelection(new Set([1]), 1, null)], [])
  assert.deepEqual([...updateRangeSelection(new Set(), 2, null)], [2])
})

test('selects an inclusive range when the target is not selected', () => {
  const next = updateRangeSelection(new Set([2]), 5, 2)
  assert.deepEqual([...next].sort((a, b) => a - b), [2, 3, 4, 5])
})

test('clears an inclusive range when the target is already selected', () => {
  const next = updateRangeSelection(new Set([1, 2, 3, 4, 5]), 4, 1)
  assert.deepEqual([...next].sort((a, b) => a - b), [5])
})

test('supports ranges selected in reverse order', () => {
  const next = updateRangeSelection(new Set([5]), 2, 5)
  assert.deepEqual([...next].sort((a, b) => a - b), [2, 3, 4, 5])
})
