import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historicalSourceInfo, historicalZoomLevels, sourceMatchesHistoryContext, matchesHistoricalProvider } from './historical-source-info.ts'

test('switching a detailed basemap to NASA retains supported levels and avoids unsupported requests', () => {
  assert.deepEqual(historicalZoomLevels('nasa_weld_1990', [15, 17]), [12])
  assert.deepEqual(historicalZoomLevels('nasa_weld_2000', [9, 12, 18]), [9, 12])
  assert.deepEqual(historicalZoomLevels('nasa_weld_1990', []), [])
  assert.deepEqual(historicalZoomLevels('eox_sentinel_2024', [12, 22]), [12])
  assert.deepEqual(historicalZoomLevels('google_satellite', [15, 22]), [15, 22])
  assert.equal(historicalSourceInfo('eox_sentinel_2017'), null)
})

test('historical versions belong to their Wayback provider and stay out of ordinary imagery', () => {
  const earthSource = `earth_history_${'a'.repeat(64)}`
  assert.equal(matchesHistoricalProvider(earthSource, 'earth'), true)
  assert.equal(sourceMatchesHistoryContext(earthSource), false)
  assert.equal(historicalSourceInfo(earthSource), null) // Earth dates come from the scoped catalogue, never a fixed-year regex.
  for (const id of ['nasa_weld_1990', 'eox_sentinel_2024', 'geovis_2021']) {
    assert.equal(sourceMatchesHistoryContext(id), false)
  }
  assert.equal(sourceMatchesHistoryContext('google_satellite'), true)
  assert.equal(sourceMatchesHistoryContext('nasa_weld_2000', 'nasa'), true)
  assert.equal(sourceMatchesHistoryContext('nasa_weld_2000', 'eox'), false)
  assert.equal(sourceMatchesHistoryContext('geovis_2025', 'geovis'), true)
})
