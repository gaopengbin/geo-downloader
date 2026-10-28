export type HeaderRow = { id: string; name: string; value: string }

const managed = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer'])

export function parseHeaderRows(rows: HeaderRow[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (const [index, row] of rows.entries()) {
    if (!row.name && !row.value) continue
    const name = row.name.trim().toLowerCase()
    if (!name || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
      throw new Error(`第 ${index + 1} 项请求头名称无效`)
    }
    if (managed.has(name)) throw new Error(`第 ${index + 1} 项由 HTTP 客户端管理，请移除`)
    if (Object.hasOwn(result, name)) throw new Error(`第 ${index + 1} 项请求头名称重复`)
    if (Array.from(row.value).some((character) => {
      const code = character.charCodeAt(0)
      return (code < 32 && code !== 9) || code === 127
    })) {
      throw new Error(`第 ${index + 1} 项请求头值不能含换行或控制字符`)
    }
    if (new TextEncoder().encode(row.value).length > 16384) throw new Error(`第 ${index + 1} 项请求头内容过长`)
    result[name] = row.value
  }
  if (Object.keys(result).length > 64) throw new Error('自定义请求头最多 64 项')
  if (Object.entries(result).reduce((total, [name, value]) => total + name.length + new TextEncoder().encode(value).length, 0) > 65536) {
    throw new Error('自定义请求头总长度不能超过 64 KB')
  }
  return result
}
