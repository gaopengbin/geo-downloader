import assert from 'node:assert/strict'
import test from 'node:test'

import {
  detectInitialLanguage,
  normalizeLanguage,
  persistLanguage,
  type AppLanguage,
} from './language.ts'
import enUS from './locales/en-US.ts'
import zhCN from './locales/zh-CN.ts'

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

function memoryStorage(initial?: string) {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next
    },
    value: () => value,
  }
}

test('normalizes Chinese locales and falls back other locales to English', () => {
  assert.equal(normalizeLanguage('zh-Hans-CN'), 'zh-CN')
  assert.equal(normalizeLanguage('zh-TW'), 'zh-CN')
  assert.equal(normalizeLanguage('en-GB'), 'en-US')
  assert.equal(normalizeLanguage('fr-FR'), 'en-US')
})

test('stored user preference wins over the system language', () => {
  const storage = memoryStorage('en-US')
  assert.equal(detectInitialLanguage(storage, 'zh-CN'), 'en-US')
})

test('invalid stored values fall back to the normalized system language', () => {
  assert.equal(detectInitialLanguage(memoryStorage('ja-JP'), 'zh-CN'), 'zh-CN')
  assert.equal(detectInitialLanguage(memoryStorage(), 'de-DE'), 'en-US')
})

test('persists a supported language preference', () => {
  const storage = memoryStorage()
  persistLanguage('en-US' satisfies AppLanguage, storage)
  assert.equal(storage.value(), 'en-US')
})

test('keeps Chinese and English resource keys in sync', () => {
  assert.deepEqual(flattenKeys(enUS).sort(), flattenKeys(zhCN).sort())
})
