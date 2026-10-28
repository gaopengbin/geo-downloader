import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHeaderRows } from './request-headers.ts'

const row = (name: string, value: string) => ({ id: name, name, value })
test('normalizes names and preserves credentials, punctuation, empty values', () => {
  const result = parseHeaderRows([row(' Authorization ', 'Bearer test-only'), row('Cookie', 'a=b; c=d=='),
    row('Referer', 'https://example.test/map?x=1'), row('X-Empty', ''), row('', '')])
  assert.deepEqual({ ...result }, { authorization: 'Bearer test-only', cookie: 'a=b; c=d==',
    referer: 'https://example.test/map?x=1', 'x-empty': '' })
})
test('rejects duplicates, incomplete rows, managed headers and injected lines without echoing secrets', () => {
  for (const rows of [[row('a', '1'), row('A', '2')], [row('', 'test-only')], [row('bad name', 'test-only')],
    [row('Host', 'test-only')], [row('a', 'test-only\r\nX: injected')], [row('a', 'test-only\x00')]]) {
    assert.throws(() => parseHeaderRows(rows), (error: Error) => !error.message.includes('test-only'))
  }
  assert.throws(() => parseHeaderRows([row('a', 'x'.repeat(16385))]))
  assert.throws(() => parseHeaderRows(Array.from({ length: 65 }, (_, i) => row(`x-${i}`, 'v'))))
})
