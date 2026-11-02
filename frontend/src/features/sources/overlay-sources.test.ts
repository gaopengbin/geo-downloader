import assert from 'node:assert/strict'
import test from 'node:test'
import { moveOverlay, overlayCandidates, rememberedOverlayIds, validOverlayIds } from './overlay-sources.ts'

const sources = {
  base: { name: 'Imagery', url: 'https://test.invalid/{z}/{x}/{y}.png' },
  custom_roads: { id: 'untrusted_other_id', name: 'My roads', url: 'https://test.invalid/roads/{z}/{x}/{-y}', headers: { Authorization: 'test-only' }, subdomains: ['a'], max_zoom: 16 },
  label: { name: 'Labels', url: 'https://test.invalid/labels/{z}/{x}/{y}.png' },
  vector: { name: 'MVT', url: 'https://test.invalid/{z}/{x}/{y}.pbf' },
  dem_terrarium: { name: 'DEM', url: 'https://test.invalid/dem/{z}/{x}/{y}.png' },
  empty: { name: 'No URL' },
}

test('custom raster overlays need no name convention and retain request options', () => {
  const candidates = overlayCandidates(sources, 'base')
  assert.deepEqual(candidates.map((source) => source.id).sort(), ['custom_roads', 'label'])
  const roads = candidates.find((source) => source.id === 'custom_roads')!
  assert.equal(roads.url, sources.custom_roads.url)
  assert.deepEqual(roads.headers, sources.custom_roads.headers)
  assert.deepEqual(roads.subdomains, ['a'])
  assert.equal(roads.max_zoom, 16)
})

test('downloads retain selected stacking order, drop stale/base/non-raster IDs and duplicates', () => {
  assert.deepEqual(validOverlayIds(['custom_roads', 'label', 'custom_roads', 'base', 'missing', 'vector', 'dem_terrarium'], sources, 'base'), ['custom_roads', 'label'])
  assert.deepEqual(validOverlayIds(['custom_roads'], {}, 'base'), [])
})

test('existing per-mode cia/cva preferences map to editable sources without duplicates', () => {
  assert.deepEqual(rememberedOverlayIds({ cia: true, cva: false, custom_roads: true, tianditu_satellite_label: true }), ['tianditu_satellite_label', 'custom_roads'])
  assert.deepEqual(rememberedOverlayIds(), [])
})

test('reordering preserves all IDs and the original selection', () => {
  const original = ['label', 'custom_roads']
  assert.deepEqual(moveOverlay(original, 1, -1), ['custom_roads', 'label'])
  assert.deepEqual(original, ['label', 'custom_roads'])
  assert.deepEqual(moveOverlay(original, 0, 1), ['custom_roads', 'label'])
  assert.equal(moveOverlay(original, 0, -1), original)
})
