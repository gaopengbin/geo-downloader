import assert from 'node:assert/strict'
import test from 'node:test'
import { moveOverlay, overlayCandidates, rememberedOverlayIds, validOverlayIds } from './overlay-sources.ts'
import { enabledOverlayIds, normalizeOverlaySelection, reorderOverlaySelection, restoreOverlaySelections } from './layer-selection.ts'

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

test('upgrading preserves download intent, including explicit empty lists, before preview preferences', () => {
  const restored = restoreOverlaySelections({ selectedSourceByMode: { imagery: 'base' }, overlayVisibilityByMode: {
    imagery: { cia: true }, wayback: { cva: true, custom_roads: false }, dem: { cia: true },
  } }, { overlaySourcesByMode: { imagery: ['label', 'custom_roads', 'base'], dem: [] } })
  assert.deepEqual(restored.imagery, [{ sourceId: 'label', visible: true }, { sourceId: 'custom_roads', visible: true }])
  assert.deepEqual(restored.dem, [])
  assert.deepEqual(restored.wayback, [{ sourceId: 'tianditu_vector_label', visible: true }, { sourceId: 'custom_roads', visible: false }])
})

test('canonical empty selections never resurrect stale legacy preferences on restart', () => {
  assert.deepEqual(restoreOverlaySelections({ overlayLayersByMode: { imagery: [] }, overlayVisibilityByMode: { imagery: { cia: true } } },
    { overlaySourcesByMode: { imagery: ['label'] } }).imagery, [])
})

test('reorder preserves hidden layers, numeric source ordering and immutable snapshots', () => {
  const current = [{ sourceId: '10', visible: false }, { sourceId: '2', visible: true }]
  const updated = reorderOverlaySelection(current, ['2', 'new', '10', '2'])
  assert.deepEqual(updated, [{ sourceId: '2', visible: true }, { sourceId: 'new', visible: true }, { sourceId: '10', visible: false }])
  assert.deepEqual(current, [{ sourceId: '10', visible: false }, { sourceId: '2', visible: true }])
  assert.deepEqual(normalizeOverlaySelection(updated, '2'), [{ sourceId: 'new', visible: true }, { sourceId: '10', visible: false }])
})

test('map and task use the same visible raster stack, excluding base, stale and unsupported layers', () => {
  const selection = normalizeOverlaySelection([{ sourceId: 'label', visible: false }, 'custom_roads', 'vector', 'missing', 'base'])
  assert.deepEqual(enabledOverlayIds(selection, sources, 'base'), ['custom_roads'])
  const enabled = selection.map((entry) => entry.sourceId === 'label' ? { ...entry, visible: true } : entry)
  assert.deepEqual(enabledOverlayIds(enabled, sources, 'base'), ['label', 'custom_roads'])
})
