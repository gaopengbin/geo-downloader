import { toast } from 'sonner'

import { useAppStore, type AppMode, type SidebarTab } from '@/store/app-store'

export const ASSISTANT_ACTION_EVENT = 'geod:assistant-action'

interface AssistantNavigationAction {
  id: string
  label: string
  tab?: SidebarTab
  mode?: AppMode
  selector?: string
  event?: string
}

const ACTIONS = {
  download: {
    id: 'download',
    label: '资源下载',
    tab: 'download',
    selector: '[data-tour="download-panel"]',
  },
  'download-center': {
    id: 'download-center',
    label: '下载中心',
    tab: 'history',
    selector: '[data-agent-target="download-center"]',
  },
  settings: {
    id: 'settings',
    label: '设置',
    tab: 'settings',
    selector: '[data-agent-target="settings-panel"]',
  },
  'settings-cache': {
    id: 'settings-cache',
    label: '瓦片缓存设置',
    tab: 'settings',
    selector: '[data-agent-target="settings-cache"]',
  },
  'settings-tokens': {
    id: 'settings-tokens',
    label: '访问令牌设置',
    tab: 'settings',
    selector: '[data-agent-target="settings-tokens"]',
  },
  'settings-proxy': {
    id: 'settings-proxy',
    label: '网络代理设置',
    tab: 'settings',
    selector: '[data-agent-target="settings-proxy"]',
  },
  'settings-download': {
    id: 'settings-download',
    label: '默认下载参数',
    tab: 'settings',
    selector: '[data-agent-target="settings-download"]',
  },
  'settings-advanced': {
    id: 'settings-advanced',
    label: '高级设置',
    tab: 'settings',
    selector: '[data-agent-target="settings-advanced"]',
  },
  'settings-sources': {
    id: 'settings-sources',
    label: '图源管理',
    tab: 'settings',
    selector: '[data-agent-target="settings-other"]',
    event: 'open-sources',
  },
  'imagery-sources': {
    id: 'imagery-sources',
    label: '影像图源',
    tab: 'download',
    mode: 'imagery',
    selector: '[data-tour="imagery-source-section"]',
  },
  'imagery-download': {
    id: 'imagery-download',
    label: '影像下载',
    tab: 'download',
    mode: 'imagery',
    selector: '[data-tour="download-panel"]',
  },
  'imagery-output': {
    id: 'imagery-output',
    label: '影像输出参数',
    tab: 'download',
    mode: 'imagery',
    selector: '[data-tour="imagery-output-section"]',
  },
  'dem-download': {
    id: 'dem-download',
    label: 'DEM 下载',
    tab: 'download',
    mode: 'dem',
    selector: '[data-tour="download-panel"]',
  },
  'wayback-download': {
    id: 'wayback-download',
    label: 'Wayback 历史影像',
    tab: 'download',
    mode: 'wayback',
    selector: '[data-tour="wayback-section"]',
  },
  'tiles3d-download': {
    id: 'tiles3d-download',
    label: '3D Tiles 下载',
    tab: 'download',
    mode: 'tiles3d',
    selector: '[data-tour="tiles3d-source-section"]',
  },
  'mvt-download': {
    id: 'mvt-download',
    label: 'MVT 下载',
    tab: 'download',
    mode: 'mvt',
    selector: '[data-tour="download-panel"]',
  },
  'osm-download': {
    id: 'osm-download',
    label: 'OSM 下载',
    tab: 'download',
    mode: 'vector',
    selector: '[data-tour="download-panel"]',
  },
  map: {
    id: 'map',
    label: '地图',
    selector: '[data-tour="map-canvas"]',
  },
} as const satisfies Record<string, AssistantNavigationAction>

export type AssistantActionId = keyof typeof ACTIONS

export function parseAssistantActionHref(
  href: string | undefined,
): AssistantNavigationAction | null {
  if (!href) return null
  try {
    const url = new URL(href)
    if (
      url.protocol !== 'geod:' ||
      url.hostname !== 'navigate' ||
      url.search ||
      url.hash
    ) {
      return null
    }
    const id = url.pathname.replace(/^\/+|\/+$/g, '') as AssistantActionId
    return (ACTIONS[id] as AssistantNavigationAction | undefined) ?? null
  } catch {
    return null
  }
}

function revealTarget(selector: string, attempt = 0) {
  const target = document.querySelector<HTMLElement>(selector)
  if (!target) {
    if (attempt < 10) {
      window.setTimeout(() => revealTarget(selector, attempt + 1), 80)
    }
    return
  }

  const collapsibleHeader = target.querySelector<HTMLElement>(
    ':scope > header[role="button"]',
  )
  if (collapsibleHeader && target.children.length === 1) {
    collapsibleHeader.click()
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  const highlightClasses = [
    'ring-2',
    'ring-primary',
    'ring-offset-2',
    'ring-offset-background',
  ]
  target.classList.add(...highlightClasses)
  window.setTimeout(() => target.classList.remove(...highlightClasses), 1400)
}

export function executeAssistantActionHref(href: string) {
  const action = parseAssistantActionHref(href)
  if (!action) {
    toast.error('这个助手操作不受支持')
    return false
  }

  const app = useAppStore.getState()
  if (action.mode) app.setMode(action.mode)
  if (action.tab) app.setTab(action.tab)

  window.setTimeout(() => {
    if (action.selector) revealTarget(action.selector)
    if (action.event) {
      window.dispatchEvent(
        new CustomEvent(ASSISTANT_ACTION_EVENT, {
          detail: { action: action.event },
        }),
      )
    }
  }, 60)

  toast.success(`已定位到${action.label}`)
  return true
}
