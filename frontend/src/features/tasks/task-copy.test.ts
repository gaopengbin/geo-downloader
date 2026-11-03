import assert from 'node:assert/strict'
import test from 'node:test'

import { getTaskErrorMessage, getTaskMessage, getTaskStatusKey } from './task-copy.ts'
import type { TaskInfo } from '@/types/api'
import { getTaskHeading } from './task-heading.ts'

test('maps every known task state to a translation key', () => {
  assert.equal(getTaskStatusKey('pending'), 'tasks.status.pending')
  assert.equal(getTaskStatusKey('completed_with_gaps'), 'tasks.status.completed_with_gaps')
  assert.equal(getTaskStatusKey('building_pyramid'), 'tasks.status.building_pyramid')
})

test('preserves unknown backend states for forward compatibility', () => {
  assert.equal(getTaskStatusKey('future_state'), null)
})

test('OSM recovery progress is localized without hiding unknown backend messages', () => {
  const translate = (key: string, values?: Record<string, string | number>) => JSON.stringify({ key, values })
  const task = (message: string, source = 'osm_vector') => ({ source, status: 'downloading', message } as TaskInfo)
  assert.equal(getTaskMessage(task('OVERPASS_REQUEST:2:3:overpass.private.coffee'), translate),
    translate('tasks.osm.request', { current: 2, total: 3, host: 'overpass.private.coffee' }))
  assert.equal(getTaskMessage(task('OVERPASS_WAIT:30'), translate), translate('tasks.osm.wait', { seconds: 30 }))
  assert.equal(getTaskMessage(task('OVERPASS_FALLBACK:3:3'), translate), translate('tasks.osm.fallback', { current: 3, total: 3 }))
  assert.equal(getTaskMessage(task('OVERPASS_QUEUED'), translate), translate('tasks.osm.queued'))
  assert.equal(getTaskMessage(task('OVERPASS_ERROR: server disconnected'), translate), translate('tasks.osm.recovering'))
  assert.equal(getTaskMessage(task('future protocol'), translate), 'future protocol')
  assert.equal(getTaskMessage(task('OVERPASS_WAIT:30', 'other'), translate), 'OVERPASS_WAIT:30')
})

test('OSM failures distinguish unavailability, incomplete data and rejected queries', () => {
  const translate = (key: string) => key
  assert.equal(getTaskErrorMessage('OSM_SERVICE_UNAVAILABLE: connection failed', translate), 'tasks.osm.unavailable')
  assert.equal(getTaskErrorMessage('OSM_QUERY_INCOMPLETE: timeout with partial elements', translate), 'tasks.osm.incomplete')
  assert.equal(getTaskErrorMessage('OSM_REQUEST_REJECTED: HTTP 400', translate), 'tasks.osm.rejected')
  assert.equal(getTaskErrorMessage('HTTP 429 from a different provider', translate), 'HTTP 429 from a different provider')
})

test('auto task headings show source/date/levels once without losing multiple levels', () => {
  assert.deepEqual(getTaskHeading('Google Earth 2026-07-14 z17', 'Google Earth 历史影像 2026-07-14', 17),
    { title: 'Google Earth 2026-07-14', source: undefined, level: 'z17' })
  assert.deepEqual(getTaskHeading('天地图 卫星 z15~z18', '天地图 卫星', 15),
    { title: '天地图 卫星', source: undefined, level: 'z15~z18' })
  assert.deepEqual(getTaskHeading('ArcGIS 卫星 z10,15,18', 'ArcGIS 卫星', 10),
    { title: 'ArcGIS 卫星', source: undefined, level: 'z10,15,18' })
  assert.deepEqual(getTaskHeading('OSM 道路', 'OSM 道路', 0),
    { title: 'OSM 道路', source: undefined, level: undefined })
})

test('custom names, differing imagery dates and mismatched levels retain source details', () => {
  for (const [name, source, zoom] of [
    ['朝阳区变化对比', 'Google Earth 历史影像 2026-07-14', 17],
    ['Google Earth 2013-10-16 z17', 'Google Earth 历史影像 2026-07-14', 17],
    ['天地图 卫星 z18', '天地图 卫星', 17],
  ] as const) {
    assert.deepEqual(getTaskHeading(name, source, zoom), { title: name, source, level: `z${zoom}` })
  }
  assert.deepEqual(getTaskHeading('自定义图源 z17', '自定义图源 z17', 17),
    { title: '自定义图源 z17', source: undefined, level: 'z17' })
})
