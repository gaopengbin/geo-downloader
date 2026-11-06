import test from 'node:test'
import assert from 'node:assert/strict'
import { convertOvitalUrl, OvitalUrlError } from './ovital-url.ts'
test('Ovital tile variables become existing GeoD tokens without changing authentication bytes', () => {
  const url =
    'https://tiles.example.test/wmts?x={$x}&y={$y}&z={$z}&tk=a%2Bb%3D&signature=ABC%2fDEF'
  assert.equal(
    convertOvitalUrl(url).url,
    'https://tiles.example.test/wmts?x={x}&y={y}&z={z}&tk=a%2Bb%3D&signature=ABC%2fDEF',
  )
  assert.equal(
    convertOvitalUrl('/getomap_200_{$z}_{$x}_{$y}_0_0.png', '127.0.0.1:9999')
      .url,
    'http://127.0.0.1:9999/getomap_200_{z}_{x}_{y}_0_0.png',
  )
  assert.equal(
    convertOvitalUrl(
      'https://{s}.example.test/%7B%24z%7D/%7B%24x%7D/%7B%24y%7D.png',
    ).url,
    'https://{s}.example.test/{z}/{x}/{y}.png',
  )
  assert.equal(
    convertOvitalUrl('https://tiles.example.test/{$q}.png').url,
    'https://tiles.example.test/{q}.png',
  )
  assert.equal(
    convertOvitalUrl('https://tiles.example.test/{$z}/{$x}/{$-y}.png').url,
    'https://tiles.example.test/{z}/{x}/{-y}.png',
  )
})
test('unsupported time expressions and geographic tile grids are not silently misinterpreted', () => {
  for (const [url, code] of [
    ['/getomap_200_{$z}_{$x}_{$y}_0_0.png', 'absolute'],
    ['https://x.test/{$dy}/{$z}/{$x}/{$y}', 'variables'],
    ['https://x.test/wmts?TILEMATRIXSET=c&x={$x}&y={$y}&z={$z}', 'projection'],
    ['https://x.test/plain.png', 'placeholders'],
  ]) {
    assert.throws(
      () => convertOvitalUrl(url),
      (error) => error instanceof OvitalUrlError && error.code === code,
    )
  }
  assert.equal(
    convertOvitalUrl('https://x.test/{z}/{x}/{y}.png').changed,
    false,
  )
})
