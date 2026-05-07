import { useEffect, useRef, useState } from 'react'
import { Boxes, CalendarClock, ClipboardList, History as HistoryIcon, Image as ImageIcon, Layers3, ListChecks, Mountain, Settings, Shapes } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BatchDialog } from '@/features/batch/batch-dialog'
import { HelpButton } from '@/features/onboarding/help-button'
import { useOnboardingTour } from '@/features/onboarding/use-onboarding-tour'
import {
  IMAGERY_TOUR_STEPS,
  TILES3D_TOUR_STEPS,
  WAYBACK_TOUR_STEPS,
} from '@/features/onboarding/tour-config'
import { UpdateDialog } from '@/features/update/update-dialog'
import { checkForUpdates } from '@/features/update/update-api'
import { ImageryPage } from '@/features/imagery/imagery-page'
import { Tiles3dPage } from '@/features/tiles3d/tiles3d-page'
import { WaybackPage } from '@/features/wayback/wayback-page'
import { VectorPage } from '@/features/vector/vector-page'
import { MapCanvas } from '@/features/map/map-canvas'
import { CesiumCanvas } from '@/features/map/cesium-canvas'
import { WaybackTimeline } from '@/features/wayback/wayback-timeline'
import { SettingsPanel } from '@/features/settings/settings-panel'
import { TasksPanel } from '@/features/tasks/tasks-panel'
import { HistoryPanel } from '@/features/history/history-panel'
import { PanelSection } from '@/components/layout/panel-section'
import { cn } from '@/lib/utils'
import { useAppStore, type AppMode, type SidebarTab } from '@/store/app-store'

interface ModeMeta {
  value: AppMode
  label: string
  short: string
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

const MODES: ModeMeta[] = [
  {
    value: 'imagery',
    label: '影像下载',
    short: 'GeoTIFF',
    description: '单级别 / 多级别瓦片下载，支持自定义图源与断点续传。',
    icon: ImageIcon,
  },
  {
    value: 'dem',
    label: 'DEM 高程',
    short: 'DEM',
    description: '地形高程瓦片下载与裁剪。',
    icon: Mountain,
  },
  {
    value: 'wayback',
    label: 'Wayback 历史影像',
    short: 'Wayback',
    description: 'Esri Wayback fast/fine 扫描、时间轴与增量下载。',
    icon: CalendarClock,
  },
  {
    value: 'tiles3d',
    label: '3D Tiles',
    short: '3D',
    description: 'Cesium 3D Tiles 在线下载、本地预览与模型调控。',
    icon: Boxes,
  },
  {
    value: 'mvt',
    label: '矢量切片',
    short: 'MVT',
    description: 'MVT / PBF 矢量瓦片下载（需自定义图源，如 Maptiler / Mapbox）。',
    icon: Layers3,
  },
  {
    value: 'vector',
    label: '矢量数据 (OSM)',
    short: 'OSM',
    description: 'OSM Overpass 道路 / 建筑 / POI 等要素数据下载（GeoJSON）。',
    icon: Shapes,
  },
]

type SidebarTabMeta = {
  value: SidebarTab
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

const SIDEBAR_TABS: SidebarTabMeta[] = [
  { value: 'download', label: '资源下载', icon: ImageIcon },
  { value: 'history', label: '下载中心', icon: ListChecks },
  { value: 'settings', label: '设置', icon: Settings },
]

function ModePlaceholder({ mode }: { mode: ModeMeta }) {
  const Icon = mode.icon
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-4" />
          </div>
          <div>
            <CardTitle className="text-base">{mode.label}</CardTitle>
            <CardDescription className="text-xs">{mode.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-dashed bg-muted/40 p-6 text-center text-sm text-muted-foreground">
          该模块尚未迁移到 React 版
        </div>
      </CardContent>
    </Card>
  )
}

function App() {
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)
  const tab = useAppStore((s) => s.tab)
  const setTab = useAppStore((s) => s.setTab)

  // 侧边栏拖拽宽度
  const [sidebarWidth, setSidebarWidth] = useState(380)
  const draggingRef = useRef(false)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const w = Math.max(280, Math.min(600, e.clientX))
      setSidebarWidth(w)
    }
    const onUp = () => {
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 启动后静默检查一次更新
  useEffect(() => {
    void checkForUpdates(true)
  }, [])

  // 首次打开主界面的新手引导
  const mainTour = useOnboardingTour({ id: 'main-v1' })
  // 三个模式的详细引导（手动启动，不自动弹出）
  const imageryTour = useOnboardingTour({
    id: 'imagery-v1',
    steps: IMAGERY_TOUR_STEPS,
    autoStartOnFirstVisit: false,
  })
  const tiles3dTour = useOnboardingTour({
    id: 'tiles3d-v1',
    steps: TILES3D_TOUR_STEPS,
    autoStartOnFirstVisit: false,
  })
  const waybackTour = useOnboardingTour({
    id: 'wayback-v1',
    steps: WAYBACK_TOUR_STEPS,
    autoStartOnFirstVisit: false,
  })

  // 切换模式后等待 DOM 挂载再启动对应引导
  const startTourForMode = (target: AppMode, runner: () => void) => {
    if (mode !== target) {
      setMode(target)
      // 错开一个 tick，让面板完成重渲染
      window.setTimeout(runner, 200)
    } else {
      runner()
    }
  }

  const currentMode = MODES.find((m) => m.value === mode) ?? MODES[0]

  return (
    <AppShell
      modeSlot={
        <div
          data-tour="mode-tabs"
          className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-1 shadow-inner"
        >
          {MODES.map((m) => {
            const Icon = m.icon
            const active = m.value === mode
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => setMode(m.value)}
                title={m.description}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all',
                  active
                    ? 'bg-background text-foreground shadow-sm ring-1 ring-border/50'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                )}
              >
                <Icon className={cn('size-3.5 transition-colors', active && 'text-primary')} />
                {m.short}
              </button>
            )
          })}
        </div>
      }
      headerExtras={
        <HelpButton
          onStartMain={mainTour.start}
          onStartImagery={() => startTourForMode('imagery', imageryTour.start)}
          onStartTiles3d={() => startTourForMode('tiles3d', tiles3dTour.start)}
          onStartWayback={() => startTourForMode('wayback', waybackTour.start)}
        />
      }
    >
      <div className="flex h-[calc(100vh-3rem)] w-screen overflow-hidden">
        {/* 左侧控制面板 */}
        <aside
          className="flex h-full shrink-0 flex-col border-r bg-background"
          style={{ width: sidebarWidth }}
        >
          {/* Tab 头 */}
          <div
            data-tour="sidebar-tabs"
            className="flex shrink-0 items-stretch border-b border-border/60 bg-muted/30"
          >
            {SIDEBAR_TABS.map((t) => {
              const Icon = t.icon
              const active = t.value === tab
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTab(t.value)}
                  data-tour={t.value === 'settings' ? 'settings-tab' : undefined}
                  className={cn(
                    'relative flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors',
                    active
                      ? 'bg-background text-foreground'
                      : 'text-muted-foreground hover:bg-background/40 hover:text-foreground',
                  )}
                >
                  <Icon className={cn('size-3.5', active && 'text-primary')} />
                  {t.label}
                  {active && (
                    <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-t bg-primary" />
                  )}
                </button>
              )
            })}
          </div>

          {/* Tab 内容（保持挂载，仅切换显隐，避免重置表单状态） */}
          <div className="flex-1 overflow-y-auto" data-tour="download-panel">
            <div className={tab === 'download' ? 'p-3' : 'hidden'}>
              {mode === 'imagery' ? (
                <ImageryPage key="imagery" mode="imagery" />
              ) : mode === 'dem' ? (
                <ImageryPage key="dem" mode="dem" />
              ) : mode === 'wayback' ? (
                <WaybackPage />
              ) : mode === 'tiles3d' ? (
                <Tiles3dPage />
              ) : mode === 'vector' ? (
                <VectorPage />
              ) : mode === 'mvt' ? (
                <ImageryPage mode="mvt" />
              ) : (
                <ModePlaceholder mode={currentMode} />
              )}
            </div>
            <div className={tab === 'history' ? 'space-y-3 p-3' : 'hidden'}>
              <PanelSection icon={ClipboardList} title="任务" description="进行中 / 暂停 / 可恢复">
                <TasksPanel />
              </PanelSection>
              <PanelSection icon={HistoryIcon} title="历史记录" description="已完成 / 失败 / 已删除">
                <HistoryPanel />
              </PanelSection>
            </div>
            <div className={tab === 'settings' ? 'p-3' : 'hidden'}>
              <SettingsPanel />
            </div>
          </div>
        </aside>

        {/* 全局：批量下载对话框 */}
        <BatchDialog />
        {/* 全局：检查更新对话框 */}
        <UpdateDialog />

        {/* 拖拽条 */}
        <div
          role="separator"
          aria-orientation="vertical"
          className="group relative h-full w-1 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary"
          onMouseDown={() => {
            draggingRef.current = true
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>

        {/* 右侧地图：Leaflet（默认）与 Cesium（3D Tiles 模式）同时挂载，按 mode CSS 切换显隐 */}
        <main className="relative h-full flex-1" data-tour="map-canvas">
          <div
            className="absolute inset-0"
            style={{ display: mode === 'tiles3d' ? 'none' : 'block' }}
            aria-hidden={mode === 'tiles3d'}
          >
            <MapCanvas />
            <WaybackTimeline />
          </div>
          <CesiumCanvas />
        </main>
      </div>
    </AppShell>
  )
}

export default App
