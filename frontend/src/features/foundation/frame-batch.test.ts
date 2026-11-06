import test from 'node:test'
import assert from 'node:assert/strict'
import { forEachFrame } from './frame-batch.ts'

test('geometry yields across bounded frames, preserves order and stops queued stale work', async () => {
  let now = 0,
    frames = 0
  const seen: number[] = []
  const values = Array.from({ length: 1000 }, (_, i) => i)
  assert.equal(
    await forEachFrame(
      values,
      (item) => {
        seen.push(item)
        now += 1.5
      },
      () => false,
      {
        nextFrame: async () => {
          frames++
        },
        now: () => now,
      },
    ),
    true,
  )
  assert.deepEqual(seen, values)
  assert.equal(frames, 334)

  let stopped = false
  const cancelled: number[] = []
  assert.equal(
    await forEachFrame(
      values,
      (value) => cancelled.push(value),
      () => stopped,
      {
        nextFrame: async () => {
          stopped = true
        },
        now: () => 0,
      },
    ),
    false,
  )
  assert.equal(cancelled.length, 0)

  stopped = false
  let batches = 0
  assert.equal(
    await forEachFrame(
      values,
      (value) => cancelled.push(value),
      () => stopped,
      {
        nextFrame: async () => {
          stopped = ++batches > 1
        },
        now: () => 0,
      },
    ),
    false,
  )
  assert.equal(cancelled.length, 128)
})

test('a coarse clock cannot put an unbounded number of points in one frame', async () => {
  const counts: number[] = []
  await forEachFrame(
    Array.from({ length: 1000 }),
    () => {},
    () => false,
    {
      nextFrame: async () => {},
      now: () => 0,
      report: (_time, count) => counts.push(count),
    },
  )
  assert.deepEqual(counts, [128, 128, 128, 128, 128, 128, 128, 104])
})
