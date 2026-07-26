import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  buildKnowledgeContext,
  DEFAULT_KNOWLEDGE_BASE,
  searchKnowledge,
} from '../knowledge-base.mjs'

const cases = JSON.parse(
  readFileSync(new URL('./knowledge-cases.json', import.meta.url), 'utf8'),
)
const desktopActionRegistry = readFileSync(
  new URL('../../../frontend/src/features/assistant/assistant-actions.ts', import.meta.url),
  'utf8',
)

test('knowledge base has a version and unique article ids', () => {
  assert.match(DEFAULT_KNOWLEDGE_BASE.contentVersion, /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/)
  const ids = DEFAULT_KNOWLEDGE_BASE.articles.map((article) => article.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.length >= 30, true)
})

test('retrieval ranks the cache migration article for a system drive question', () => {
  const results = searchKnowledge('C盘被缓存占满了，怎么迁移缓存目录？')

  assert.equal(results[0]?.id, 'cache-migration')
  assert.ok(results.some((result) => result.id === 'cache-capacity'))
  assert.equal(results.some((result) => result.id === 'empty-tile-probe'), false)
})

test('retrieved context exposes citations and only curated action links', () => {
  const results = searchKnowledge('Wayback 历史影像怎么下载？')
  const context = buildKnowledgeContext(results, DEFAULT_KNOWLEDGE_BASE.contentVersion)

  assert.match(context, /SOURCE wayback-workflow/)
  assert.match(context, /geod:\/\/navigate\/wayback-download/)
  assert.match(context, /\[知识库: source-id\]/)
})

test('curated support questions retrieve the expected primary article', () => {
  for (const entry of cases) {
    const results = searchKnowledge(entry.query)
    assert.equal(
      results[0]?.id,
      entry.expected,
      `${entry.query} retrieved ${results.map((result) => result.id).join(', ')}`,
    )
  }
})

test('all knowledge actions use the registered navigation scheme', () => {
  for (const article of DEFAULT_KNOWLEDGE_BASE.articles) {
    for (const action of article.actions) {
      assert.match(action.href, /^geod:\/\/navigate\/[a-z0-9-]+$/)
      const actionId = action.href.slice('geod://navigate/'.length)
      assert.match(
        desktopActionRegistry,
        new RegExp(`(?:['"]${actionId}['"]|\\b${actionId})\\s*:`),
        `unregistered desktop action ${actionId}`,
      )
    }
  }
})
