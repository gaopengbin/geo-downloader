import { readFileSync } from 'node:fs'

const knowledgeUrl = new URL('./knowledge/articles.json', import.meta.url)
const chineseSequence = /[\u3400-\u9fff]+/gu
const latinToken = /[a-z0-9][a-z0-9._/-]*/gu

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function tokenize(value) {
  const normalized = String(value ?? '').normalize('NFKC').toLowerCase()
  const tokens = [...(normalized.match(latinToken) ?? [])]

  for (const sequence of normalized.match(chineseSequence) ?? []) {
    tokens.push(sequence)
    if (sequence.length === 1) {
      tokens.push(sequence)
      continue
    }
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.push(sequence.slice(index, index + 2))
    }
  }

  return unique(tokens)
}

function validateKnowledgeBase(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.articles)) {
    throw new Error('GeoD knowledge base has an unsupported schema')
  }

  const ids = new Set()
  for (const article of value.articles) {
    if (
      !article ||
      typeof article.id !== 'string' ||
      typeof article.title !== 'string' ||
      typeof article.summary !== 'string' ||
      typeof article.body !== 'string' ||
      !Array.isArray(article.keywords) ||
      !Array.isArray(article.actions)
    ) {
      throw new Error('GeoD knowledge base contains an invalid article')
    }
    if (ids.has(article.id)) throw new Error(`Duplicate knowledge article: ${article.id}`)
    ids.add(article.id)
  }

  return value
}

export function loadKnowledgeBase(url = knowledgeUrl) {
  return validateKnowledgeBase(JSON.parse(readFileSync(url, 'utf8')))
}

export const DEFAULT_KNOWLEDGE_BASE = loadKnowledgeBase()

function scoreArticle(query, queryTokens, article) {
  const title = article.title.normalize('NFKC').toLowerCase()
  const summary = article.summary.normalize('NFKC').toLowerCase()
  const body = article.body.normalize('NFKC').toLowerCase()
  const keywords = article.keywords.map((keyword) => keyword.normalize('NFKC').toLowerCase())
  let score = 0

  if (title.includes(query)) score += 18
  if (keywords.some((keyword) => keyword.includes(query) || query.includes(keyword))) score += 12
  if (summary.includes(query)) score += 8
  if (body.includes(query)) score += 4

  for (const token of queryTokens) {
    if (token.length < 2) continue
    if (title.includes(token)) score += 6
    if (keywords.some((keyword) => keyword.includes(token) || token.includes(keyword))) score += 5
    if (summary.includes(token)) score += 2
    if (body.includes(token)) score += 1
  }

  return score
}

export function searchKnowledge(query, knowledgeBase = DEFAULT_KNOWLEDGE_BASE, limit = 3) {
  const normalizedQuery = String(query ?? '').normalize('NFKC').trim().toLowerCase()
  if (!normalizedQuery) return []
  const queryTokens = tokenize(normalizedQuery)

  const ranked = knowledgeBase.articles
    .map((article) => ({
      article,
      score: scoreArticle(normalizedQuery, queryTokens, article),
    }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.article.id.localeCompare(right.article.id))
  const minimumScore = Math.max(5, (ranked[0]?.score ?? 0) * 0.45)

  return ranked
    .filter((result) => result.score >= minimumScore)
    .slice(0, Math.max(1, Math.min(8, limit)))
    .map(({ article, score }) => ({ ...article, score }))
}

export function publicKnowledgeSources(results) {
  return results.map(({ id, title, summary, actions }) => ({
    id,
    title,
    summary,
    actions,
  }))
}

export function buildKnowledgeContext(results, contentVersion) {
  if (results.length === 0) {
    return [
      'No GeoD knowledge article matched this question.',
      'Do not invent product behavior. Ask for the exact module, operation and error when needed.',
    ].join('\n')
  }

  const articles = results.map((article) => {
    const actions =
      article.actions.length > 0
        ? article.actions.map((action) => `- [${action.label}](${action.href})`).join('\n')
        : '- None'
    return [
      `SOURCE ${article.id}: ${article.title}`,
      `Summary: ${article.summary}`,
      `Content: ${article.body}`,
      'Allowed navigation links:',
      actions,
    ].join('\n')
  })

  return [
    `GeoD knowledge base version: ${contentVersion}`,
    'Use the sources below as the product source of truth.',
    'When a source supports the answer, cite it as [知识库: source-id].',
    'Only copy geod:// links listed below. Never construct a new geod:// link.',
    '',
    ...articles,
  ].join('\n\n')
}
