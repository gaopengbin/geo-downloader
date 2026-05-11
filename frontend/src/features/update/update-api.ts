import { isTauriRuntime } from '@/lib/tauri'
import { useUpdateStore } from './update-store'

const GITHUB_REPO = 'gaopengbin/geo-downloader'

interface GithubAsset {
  name: string
  browser_download_url: string
}

interface GithubRelease {
  tag_name: string
  html_url: string
  body?: string
  draft?: boolean
  prerelease?: boolean
  assets?: GithubAsset[]
}

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('-')
    const main = core.split('.').map((n) => parseInt(n, 10) || 0)
    const preParts = pre
      ? pre.split('.').map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p))
      : null
    return { main, pre: preParts }
  }
  const va = parse(a)
  const vb = parse(b)
  for (let i = 0; i < 3; i++) {
    const na = va.main[i] || 0
    const nb = vb.main[i] || 0
    if (na !== nb) return na > nb ? 1 : -1
  }
  if (!va.pre && !vb.pre) return 0
  if (!va.pre) return 1
  if (!vb.pre) return -1
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const pa = va.pre[i]
    const pb = vb.pre[i]
    if (pa === undefined) return -1
    if (pb === undefined) return 1
    if (typeof pa === 'number' && typeof pb === 'number') {
      if (pa !== pb) return pa > pb ? 1 : -1
    } else if (typeof pa === typeof pb) {
      if (pa !== pb) return (pa as string) > (pb as string) ? 1 : -1
    } else {
      return typeof pa === 'number' ? -1 : 1
    }
  }
  return 0
}

export interface ReleaseNoteGroup {
  section: string
  items: string[]
}

/**
 * 从 GitHub Release body（Markdown）中提取关键更新点，按 `## 小节` 分组。
 *
 * 解析规则：
 * 1. 优先识别 `## 关键改进` 小节（如有），直接返回其内容作为单组结果。
 * 2. 否则按 `## 小节标题` 分组，只取**顶级** bullet（行首无缩进 `- ` / `* `），
 *    跳过子 bullet 避免噪音。
 * 3. 每个 bullet 提取主题：
 *    - 有 `**粗体**` 取粗体；
 *    - 否则取 ` — ` / ` -- ` / ` - ` 破折号前部分；
 *    - 否则取整行（去 markdown 标记）。
 * 4. 字符上限 200，返回小节数 ≤ 6，每小节 items ≤ 6。
 */
export function extractKeyUpdates(body?: string): ReleaseNoteGroup[] {
  if (!body) return []

  const lines = body.split('\n')
  const groups: ReleaseNoteGroup[] = []
  let currentGroup: ReleaseNoteGroup | null = null

  const stripMarkdown = (s: string): string =>
    s
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown 链接 [text](url) → text
      .replace(/\*\*/g, '') // 去粗体标记
      .replace(/`([^`]+)`/g, '$1') // 去代码反引号
      .replace(/\s+/g, ' ') // 折叠多空格
      .trim()

  const extractTopic = (raw: string): string => {
    // 优先：起始处的 **加粗主题**
    const headBoldMatch = raw.match(/^\*\*(.+?)\*\*/)
    if (headBoldMatch) return stripMarkdown(headBoldMatch[1])

    // 其次：包含 ` — `（破折号）则取破折号前的主题
    const dashMatch = raw.match(/^(.+?)\s+[—–-]{1,2}\s+/)
    if (dashMatch) return stripMarkdown(dashMatch[1])

    // 否则：整行（截断到 200）
    const stripped = stripMarkdown(raw)
    return stripped.length > 200 ? stripped.slice(0, 197) + '…' : stripped
  }

  for (const rawLine of lines) {
    // 识别 `## 小节标题`
    const headingMatch = rawLine.match(/^##\s+(.+?)\s*$/)
    if (headingMatch) {
      const title = headingMatch[1].trim()
      // 跳过「已知问题 / Known issues / Notes」类附录
      if (/^(已知|known|notes?|注意)/i.test(title)) {
        currentGroup = null
        continue
      }
      currentGroup = { section: title, items: [] }
      groups.push(currentGroup)
      continue
    }

    // 识别**顶级** bullet（行首必须是 `- ` 或 `* `，不允许前导空格 / Tab）
    const topBulletMatch = rawLine.match(/^[-*]\s+(.+?)\s*$/)
    if (!topBulletMatch) continue
    if (!currentGroup) continue

    const topic = extractTopic(topBulletMatch[1])
    if (topic.length > 0 && currentGroup.items.length < 6) {
      currentGroup.items.push(topic)
    }
  }

  // 「关键改进」/「亮点」/「Highlights」小节存在时只取它（避免重复）
  const highlight = groups.find((g) =>
    /^(关键改进|亮点|highlights?|tl;?dr)/i.test(g.section),
  )
  if (highlight && highlight.items.length > 0) {
    return [highlight]
  }

  // 否则返回所有非空小节，限制 6 个小节
  return groups.filter((g) => g.items.length > 0).slice(0, 6)
}

async function getCurrentVersion(): Promise<string> {
  if (!isTauriRuntime()) return '0.0.0'
  const { getVersion } = await import('@tauri-apps/api/app')
  return getVersion()
}

export async function checkForUpdates(silent: boolean) {
  if (!isTauriRuntime()) return

  const store = useUpdateStore.getState()
  store.setStatus({ kind: 'checking' })

  try {
    const currentVersion = await getCurrentVersion()
    const isPrerelease = currentVersion.includes('-')
    const apiUrl = isPrerelease
      ? `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=5`
      : `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

    const resp = await fetch(apiUrl)
    if (!resp.ok) throw new Error('获取更新信息失败')
    const payload = (await resp.json()) as GithubRelease | GithubRelease[]
    const data = Array.isArray(payload) ? payload.find((r) => !r.draft) : payload
    if (!data) throw new Error('未找到可用的发布版本')

    const latestVersion = data.tag_name.replace(/^v/, '')

    if (compareVersions(latestVersion, currentVersion) > 0) {
      const setupAsset = (data.assets ?? []).find(
        (a) => a.name.endsWith('_setup.exe') || a.name.endsWith('-setup.exe'),
      )
      store.showDialog({
        currentVersion,
        latestVersion,
        noteGroups: extractKeyUpdates(data.body),
        downloadUrl: setupAsset?.browser_download_url ?? null,
        releaseUrl: data.html_url,
      })
    } else if (!silent) {
      store.setStatus({ kind: 'latest', message: '已是最新版本' })
    } else {
      store.setStatus({ kind: 'idle' })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.setStatus({ kind: 'error', message: '检查更新失败：' + message })
  }
}
