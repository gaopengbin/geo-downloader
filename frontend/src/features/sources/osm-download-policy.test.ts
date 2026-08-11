import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OSM_DOWNLOAD_POLICY_EVENT,
  OsmDownloadPolicySession,
  requestOsmDownloadApproval,
  type OsmDownloadPolicyDecision,
  type OsmDownloadPolicyRequest,
} from './osm-download-policy.ts'

test('only the built-in OSM Standard source requires confirmation', () => {
  const session = new OsmDownloadPolicySession()

  assert.equal(
    session.requiresConfirmation(
      'osm',
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    ),
    true,
  )
  assert.equal(
    session.requiresConfirmation(
      'custom-osm',
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    ),
    false,
  )
  assert.equal(
    session.requiresConfirmation('osm', 'https://tiles.example.com/{z}/{x}/{y}.png'),
    false,
  )
  assert.equal(session.requiresConfirmation('arcgis_satellite'), false)
})

test('acknowledgement lasts for the current application session', () => {
  const session = new OsmDownloadPolicySession()

  assert.equal(session.requiresConfirmation('osm'), true)
  session.acknowledge()
  assert.equal(session.requiresConfirmation('osm'), false)
})

test('approval requests preserve switch, cancel, and continue decisions', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: new EventTarget(),
  })
  const decisions: OsmDownloadPolicyDecision[] = ['switch', 'cancel', 'continue']
  let requestCount = 0
  window.addEventListener(OSM_DOWNLOAD_POLICY_EVENT, (event) => {
    requestCount += 1
    const detail = (event as CustomEvent<OsmDownloadPolicyRequest>).detail
    detail.resolve(decisions.shift() ?? 'cancel')
  })

  const url = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  assert.equal(await requestOsmDownloadApproval('osm', url), 'switch')
  assert.equal(await requestOsmDownloadApproval('osm', url), 'cancel')
  assert.equal(await requestOsmDownloadApproval('osm', url), 'continue')
  assert.equal(await requestOsmDownloadApproval('osm', url), 'continue')
  assert.equal(requestCount, 3)
})
