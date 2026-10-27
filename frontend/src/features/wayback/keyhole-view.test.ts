import test from 'node:test'
import assert from 'node:assert/strict'
import { keyholeViewKey } from './keyhole-view.ts'
import { matchesHistoricalProvider, sourceMatchesHistoryContext } from '../sources/historical-source-info.ts'

test('date catalog follows actual source level and spatial cells', () => {
  const view={longitude:-122.401,latitude:37.79068788,zoom:14}
  assert.equal(keyholeViewKey(view),'15/5242/19823')
  assert.equal(keyholeViewKey({...view,longitude:view.longitude+0.00001}),keyholeViewKey(view))
  assert.notEqual(keyholeViewKey({...view,zoom:15}),keyholeViewKey(view))
  assert.notEqual(keyholeViewKey({...view,longitude:view.longitude+0.02}),keyholeViewKey(view))
})
test('streaming and frozen Keyhole sources stay exclusively in Earth Wayback', () => {
  const source=`earth_keyhole_${'a'.repeat(64)}`
  assert.ok(matchesHistoricalProvider(source,'earth'))
  assert.equal(sourceMatchesHistoryContext(source),false)
  assert.equal(sourceMatchesHistoryContext(source,'esri' as never),false)
})
