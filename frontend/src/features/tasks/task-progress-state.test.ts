import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskProgressState } from './task-progress-state.ts'
import type { TaskInfo } from '../../types/api.ts'
const row = (revision: number, progress: number, status = 'downloading'): TaskInfo => ({ id: 'task-1', name: 'Imagery', revision, progress, status })

test('older polling responses cannot replace newer streamed task progress', () => {
  const state = new TaskProgressState()
  state.remember(row(8, 45))
  assert.equal(state.reconcile([row(4, 10)], 0)[0].progress, 45)
  state.reconcile([row(10, 60)], state.checkpoint())
  const current = state.upsert([row(10, 60)], row(9, 50))
  assert.equal(current[0].progress, 60)
})
test('newly created tasks survive an in-flight empty poll and removed tasks stay removed', () => {
  const state = new TaskProgressState()
  const started = state.checkpoint()
  state.remember(row(1, 0, 'preparing'))
  assert.equal(state.reconcile([], started)[0].status, 'preparing')
  state.forget('task-1')
  assert.deepEqual(state.reconcile([row(1, 0)], started), [])
})
test('exporting is retained until a real completion snapshot, resume can start a newer attempt', () => {
  const state = new TaskProgressState()
  const exporting = row(4, 89.2, 'exporting')
  state.remember(exporting)
  assert.equal(state.upsert([exporting], row(3, 86.5, 'downloading'))[0].status, 'exporting')
  const completed = state.upsert([exporting], row(5, 100, 'completed'))
  assert.equal(completed[0].status, 'completed')
  assert.equal(state.upsert(completed, row(6, 0, 'preparing'))[0].progress, 0)
})
