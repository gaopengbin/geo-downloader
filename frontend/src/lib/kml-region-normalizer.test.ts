import assert from 'node:assert/strict'
import test from 'node:test'
import type { FeatureCollection } from 'geojson'

import { normalizeClosedKmlBoundaries } from './kml-region-normalizer.ts'

test('converts a closed KML line into a polygon', () => {
  const input: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: 'boundary' },
      geometry: {
        type: 'LineString',
        coordinates: [[108, 34], [109, 34], [109, 35], [108, 34]],
      },
    }],
  }

  const output = normalizeClosedKmlBoundaries(input) as FeatureCollection
  assert.equal(output.features[0].geometry?.type, 'Polygon')
  assert.deepEqual(output.features[0].properties, { name: 'boundary' })
})

test('converts multiple closed KML lines into a multipolygon', () => {
  const input: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: null,
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [[0, 0], [1, 0], [1, 1], [0, 0]],
          [[2, 2], [3, 2], [3, 3], [2, 2]],
        ],
      },
    }],
  }

  const output = normalizeClosedKmlBoundaries(input) as FeatureCollection
  const geometry = output.features[0].geometry
  assert.equal(geometry?.type, 'MultiPolygon')
  if (geometry?.type === 'MultiPolygon') {
    assert.equal(geometry.coordinates.length, 2)
  }
})

test('collapses a KML MultiGeometry of closed lines into a multipolygon', () => {
  const input: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: 'multi-boundary' },
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          {
            type: 'LineString',
            coordinates: [[0, 0], [1, 0], [1, 1], [0, 0]],
          },
          {
            type: 'LineString',
            coordinates: [[2, 2], [3, 2], [3, 3], [2, 2]],
          },
        ],
      },
    }],
  }

  const output = normalizeClosedKmlBoundaries(input) as FeatureCollection
  const geometry = output.features[0].geometry
  assert.equal(geometry?.type, 'MultiPolygon')
  if (geometry?.type === 'MultiPolygon') {
    assert.equal(geometry.coordinates.length, 2)
  }
})

test('does not convert open lines into areas', () => {
  const input: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: null,
      geometry: {
        type: 'LineString',
        coordinates: [[0, 0], [1, 0], [1, 1]],
      },
    }],
  }

  const output = normalizeClosedKmlBoundaries(input) as FeatureCollection
  assert.equal(output.features[0].geometry?.type, 'LineString')
})

test('leaves standard polygon geometry unchanged', () => {
  const coordinates = [[[0, 0], [2, 0], [2, 2], [0, 0]]]
  const input: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { source: 'standard-kml' },
      geometry: { type: 'Polygon', coordinates },
    }],
  }

  const output = normalizeClosedKmlBoundaries(input) as FeatureCollection
  assert.equal(output.features[0].geometry?.type, 'Polygon')
  assert.deepEqual(output.features[0].geometry, input.features[0].geometry)
})

test('preserves mixed geometry collections while normalizing closed lines', () => {
  const input: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: null,
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          {
            type: 'LineString',
            coordinates: [[0, 0], [1, 0], [1, 1], [0, 0]],
          },
          {
            type: 'LineString',
            coordinates: [[2, 2], [3, 2], [3, 3]],
          },
        ],
      },
    }],
  }

  const output = normalizeClosedKmlBoundaries(input) as FeatureCollection
  const geometry = output.features[0].geometry
  assert.equal(geometry?.type, 'GeometryCollection')
  if (geometry?.type === 'GeometryCollection') {
    assert.equal(geometry.geometries[0].type, 'Polygon')
    assert.equal(geometry.geometries[1].type, 'LineString')
  }
})
