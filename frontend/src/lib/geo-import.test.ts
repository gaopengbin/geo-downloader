import assert from 'node:assert/strict'
import test from 'node:test'

import type { GeoJsonObject } from 'geojson'
import { validateWgs84Coordinates } from './geo-import.ts'

test('accepts valid WGS84 polygon coordinates', () => {
  const value = {
    type: 'Polygon',
    coordinates: [[[108, 34], [109, 34], [109, 35], [108, 34]]],
  } as GeoJsonObject
  assert.deepEqual(validateWgs84Coordinates(value), {
    valid: true,
    coordinateCount: 4,
    invalidCount: 0,
    firstInvalid: null,
  })
})

test('reports projected meter coordinates before they reach Leaflet', () => {
  const value = {
    type: 'Polygon',
    coordinates: [[[500_000, 3_800_000], [500_100, 3_800_000], [500_000, 3_800_100]]],
  } as GeoJsonObject
  const result = validateWgs84Coordinates(value)
  assert.equal(result.valid, false)
  assert.equal(result.invalidCount, 3)
  assert.deepEqual(result.firstInvalid, [500_000, 3_800_000])
})

test('rejects NaN and Infinity coordinates', () => {
  const value = {
    type: 'Point',
    coordinates: [Number.NaN, Number.POSITIVE_INFINITY],
  } as GeoJsonObject
  const result = validateWgs84Coordinates(value)
  assert.equal(result.valid, false)
  assert.equal(result.invalidCount, 1)
})
