import assert from 'node:assert/strict'
import test from 'node:test'
import { clampSidebarWidth, sidebarWidthFromDrag, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from './sidebar-width.ts'

test('sidebar cannot be dragged below readable card width or past the maximum', () => {
  assert.equal(clampSidebarWidth(280), SIDEBAR_MIN_WIDTH)
  assert.equal(clampSidebarWidth(-1000), SIDEBAR_MIN_WIDTH)
  assert.equal(clampSidebarWidth(5000), SIDEBAR_MAX_WIDTH)
  assert.equal(clampSidebarWidth(440), 440)
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_DEFAULT_WIDTH)
})

test('drag width is relative to its starting position, including when the sidebar is not at x=0', () => {
  assert.equal(sidebarWidthFromDrag(440, 700, 720), 460)
  assert.equal(sidebarWidthFromDrag(440, 700, 100), SIDEBAR_MIN_WIDTH)
  assert.equal(sidebarWidthFromDrag(440, 700, 2000), SIDEBAR_MAX_WIDTH)
})
