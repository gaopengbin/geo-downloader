import assert from 'node:assert/strict'
import test from 'node:test'
import type { Feature, FeatureCollection, Polygon } from 'geojson'

import {
  extractAreaFeatures,
  featureAreaKm2,
  outerRingsFromAreaGeometry,
  regionAreaErrorMessage,
} from './geo-area.ts'

function polygonFeature(coordinates: Polygon['coordinates']): Feature<Polygon> {
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } }
}

test('extracts polygons recursively from a mixed geometry collection', () => {
  const input: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: 'mixed' },
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          {
            type: 'Polygon',
            coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          },
          {
            type: 'LineString',
            coordinates: [[2, 2], [3, 3]],
          },
          { type: 'Point', coordinates: [4, 4] },
        ],
      },
    }],
  }

  const features = extractAreaFeatures(input)
  assert.equal(features.length, 1)
  assert.equal(features[0].geometry.type, 'Polygon')
  assert.deepEqual(features[0].properties, { name: 'mixed' })
})

test('combines nested area geometry into a multipolygon', () => {
  const input: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: null,
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          {
            type: 'Polygon',
            coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          },
          {
            type: 'GeometryCollection',
            geometries: [{
              type: 'Polygon',
              coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]],
            }],
          },
        ],
      },
    }],
  }

  const features = extractAreaFeatures(input)
  assert.equal(features[0].geometry.type, 'MultiPolygon')
  assert.equal(outerRingsFromAreaGeometry(features[0].geometry).length, 2)
})

test('explains why open lines cannot be used as a download area', () => {
  const input: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: null,
      geometry: {
        type: 'LineString',
        coordinates: [[0, 0], [1, 1]],
      },
    }],
  }

  assert.equal(extractAreaFeatures(input).length, 0)
  assert.match(regionAreaErrorMessage(input), /开放线/)
  assert.match(regionAreaErrorMessage(input), /Polygon/)
})

test('distinguishes point-only files from line files', () => {
  const input: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: null,
      geometry: { type: 'Point', coordinates: [0, 0] },
    }],
  }

  assert.match(regionAreaErrorMessage(input), /点要素/)
})

test('calculates spherical polygon area instead of bounding-box area', () => {
  const triangle = polygonFeature([[[0, 0], [1, 0], [0, 1], [0, 0]]])
  const area = featureAreaKm2(triangle)
  assert.ok(area != null)
  assert.ok(area > 6_000 && area < 6_300)
})

test('subtracts polygon holes', () => {
  const outer = polygonFeature([[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]])
  const withHole = polygonFeature([
    [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]],
    [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]],
  ])
  assert.ok((featureAreaKm2(withHole) ?? Infinity) < (featureAreaKm2(outer) ?? 0))
})

test('rejects projected coordinates masquerading as longitude and latitude', () => {
  const projected = polygonFeature([[[500_000, 3_800_000], [500_100, 3_800_000], [500_000, 3_800_100]]])
  assert.equal(featureAreaKm2(projected), null)
})
