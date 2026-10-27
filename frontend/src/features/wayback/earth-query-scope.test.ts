import test from 'node:test'
import assert from 'node:assert/strict'
import { fitEarthQueryZoom } from './earth-query-scope.ts'

test('national high-detail request uses a bounded overview grid', () => {
  assert.equal(fitEarthQueryZoom({west:73.502355,south:3.39716187,east:135.09567,north:53.563269},17),4)
})
test('local imagery retains the requested detail and explicit lower levels', () => {
  const local = {west:-122.402,south:37.790,east:-122.400,north:37.792}
  assert.equal(fitEarthQueryZoom(local,17),17)
  assert.equal(fitEarthQueryZoom(local,10),10)
})
