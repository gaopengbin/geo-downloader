import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTileUrl, tileCoordsToQuadKey } from './tile-url.ts'

test('builds a Bing quadkey from XYZ coordinates', () => {
  assert.equal(tileCoordsToQuadKey({ x: 3, y: 5, z: 3 }), '213')
  assert.equal(
    resolveTileUrl('https://tiles.test/{q}.jpeg?z={z}', { x: 3, y: 5, z: 3 }),
    'https://tiles.test/213.jpeg?z=3',
  )
})

test('resolves TMS inverted Y without changing cache coordinates', () => {
  assert.equal(
    resolveTileUrl('https://tiles.test/{z}/{x}/{-y}.png', { x: 2, y: 1, z: 3 }),
    'https://tiles.test/3/2/6.png',
  )
})
