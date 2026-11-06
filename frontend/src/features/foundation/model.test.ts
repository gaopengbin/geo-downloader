import test from 'node:test'
import assert from 'node:assert/strict'
import {
  foundationQueryBounds,
  normalizeFoundationSettings,
  shouldUseGcjCoordinates,
} from './model.ts'
import { gcjToWgs, wgsToGcj } from './coordinates.ts'
test('rounded viewport queries contain the requested area and reject ambiguous/date-line bounds', () => {
  const input = { west: 116.3, south: 39.8, east: 116.5, north: 40.01 }
  const b = foundationQueryBounds(input, 10)!
  assert.ok(
    b.west <= input.west &&
      b.east >= input.east &&
      b.south <= input.south &&
      b.north >= input.north,
  )
  assert.deepEqual(foundationQueryBounds({ ...input, west: 116.301 }, 10), b)
  for (const bad of [
    { ...input, west: NaN },
    { ...input, west: 179, east: 181 },
    { ...input, west: 190, east: 200 },
    { ...input, south: 87, north: 89 },
  ])
    assert.equal(foundationQueryBounds(bad, 10), null)
})
test('persisted settings are limited to recognized layers and valid styles', () => {
  const s = normalizeFoundationSettings({
    fontSize: 100,
    layers: { water: { visible: true, color: 'url(private)', width: -1 } },
  })
  assert.equal(s.fontSize, 22)
  assert.equal(normalizeFoundationSettings({ fontSize: 13.8 }).fontSize, 14)
  assert.equal(s.layers.water.visible, true)
  assert.equal(s.layers.water.color, '#3185d6')
  assert.equal(s.layers.water.width, 2)
  assert.equal(s.layers.roads.visible, false)
  assert.equal(shouldUseGcjCoordinates('auto', 'amap_satellite'), true)
  assert.equal(shouldUseGcjCoordinates('auto', 'google_satellite'), false)
})
test('reference geometry can align with Amap without modifying exported WGS84 data', () => {
  const input: [number, number] = [116.397128, 39.916527]
  const shifted = wgsToGcj(...input)
  assert.ok(Math.abs(shifted[0] - 116.403372) < 0.000002)
  assert.ok(Math.abs(shifted[1] - 39.917931) < 0.000002)
  const original = gcjToWgs(...shifted)
  assert.ok(
    Math.abs(original[0] - input[0]) < 1e-8 &&
      Math.abs(original[1] - input[1]) < 1e-8,
  )
  assert.deepEqual(wgsToGcj(-73, 40), [-73, 40])
})
