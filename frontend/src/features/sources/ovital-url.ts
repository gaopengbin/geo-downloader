export class OvitalUrlError extends Error {
  code: 'absolute' | 'variables' | 'placeholders' | 'projection'
  constructor(code: 'absolute' | 'variables' | 'placeholders' | 'projection') {
    super(code)
    this.code = code
    this.name = 'OvitalUrlError'
  }
}
/** Convert only documented tile variables, preserving every other query byte. */
export function convertOvitalUrl(
  input: string,
  server = '',
): { url: string; changed: boolean } {
  let value = input.trim().replace(/^URL\s*[:：]\s*/i, '')
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    value = value.slice(1, -1).trim()
  if (value.startsWith('/') && server.trim()) {
    let base = server.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(base)) base = `http://${base}`
    value = base + value
  }
  const original = value
  value = value
    .replace(
      /%7b%24(-?y|x|z|q|s)%7d/gi,
      (_token, key: string) => `{${key.toLowerCase()}}`,
    )
    .replace(
      /\{\$(-?y|x|z|q|s)\}/gi,
      (_token, key: string) => `{${key.toLowerCase()}}`,
    )
  if (/\{\$|%7b%24/i.test(value)) throw new OvitalUrlError('variables')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new OvitalUrlError('absolute')
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new OvitalUrlError('absolute')
  if (
    [...parsed.searchParams].some(
      ([key, val]) =>
        /^(tilematrixset|srs|crs)$/i.test(key) &&
        /^(c|EPSG(?::|::)(4326|4490))$/i.test(val),
    )
  )
    throw new OvitalUrlError('projection')
  if (
    !value.includes('{q}') &&
    !(
      value.includes('{x}') &&
      /\{(?:-?y)\}/.test(value) &&
      value.includes('{z}')
    )
  )
    throw new OvitalUrlError('placeholders')
  return { url: value, changed: value !== original }
}
