import { useEffect, useRef, useState } from 'react'
import { Boxes, CalendarClock, ClipboardList, History as HistoryIcon, Image as ImageIcon, Layers3, ListChecks, Mountain, Settings, Shapes } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'
import { useTranslation } from 'react-i18next'

import { AppShell } from '@/components/layout/app-shell'
import { MapStatusBar } from '@/components/layout/map-status-bar'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AssistantButton } from '@/features/assistant/assistant-button'
import { BatchDialog } from '@/features/batch/batch-dialog'
import { TelemetryBootstrap } from '@/features/telemetry/telemetry-bootstrap'
import { trackTelemetry } from '@/features/telemetry/telemetry-client'
import { useTelemetryStore } from '@/features/telemetry/telemetry-store'
import { HelpButton } from '@/features/onboarding/help-button'
import { useOnboardingTour } from '@/features/onboarding/use-onboarding-tour'
import {
  DOWNLOAD_CENTER_TOUR_STEPS,
  IMAGERY_TOUR_STEPS,
  MVT_TOUR_STEPS,
  OSM_TOUR_STEPS,
  REGION_TOUR_STEPS,
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
import { OsmDownloadPolicyDialog } from '@/features/sources/osm-download-policy-dialog'
import { TasksPanel } from '@/features/tasks/tasks-panel'
import { HistoryPanel } from '@/features/history/history-panel'
import { PanelSection } from '@/components/layout/panel-section'
import { cn } from '@/lib/utils'
import { useAppStore, type AppMode, type SidebarTab } from '@/store/app-store'

interface ModeMeta {
  value: AppMode
  labelKey: string
  short: string
  descriptionKey: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

const MODES: ModeMeta[] = [
  {
    value: 'imagery',
    labelKey: 'app.modes.imagery.label',
    short: 'GeoTIFF',
    descriptionKey: 'app.modes.imagery.description',
    icon: ImageIcon,
  },
  {
    value: 'dem',
    labelKey: 'app.modes.dem.label',
    short: 'DEM',
    descriptionKey: 'app.modes.dem.description',
    icon: Mountain,
  },
  {
    value: 'wayback',
    labelKey: 'app.modes.wayback.label',
    short: 'Wayback',
    descriptionKey: 'app.modes.wayback.description',
    icon: CalendarClock,
  },
  {
    value: 'tiles3d',
    labelKey: 'app.modes.tiles3d.label',
    short: '3D',
    descriptionKey: 'app.modes.tiles3d.description',
    icon: Boxes,
  },
  {
    value: 'mvt',
    labelKey: 'app.modes.mvt.label',
    short: 'MVT',
    descriptionKey: 'app.modes.mvt.description',
    icon: Layers3,
  },
  {
    value: 'vector',
    labelKey: 'app.modes.vector.label',
    short: 'OSM',
    descriptionKey: 'app.modes.vector.description',
    icon: Shapes,
  },
]

type SidebarTabMeta = {
  value: SidebarTab
  labelKey: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

const SIDEBAR_TABS: SidebarTabMeta[] = [
  { value: 'download', labelKey: 'app.tabs.download', icon: ImageIcon },
  { value: 'history', labelKey: 'app.tabs.history', icon: ListChecks },
  { value: 'settings', labelKey: 'app.tabs.settings', icon: Settings },
]

function ModePlaceholder({ mode }: { mode: ModeMeta }) {
  const { t } = useTranslation()
  const Icon = mode.icon
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-4" />
          </div>
          <div>
            <CardTitle className="text-base">{t(mode.labelKey)}</CardTitle>
            <CardDescription className="text-xs">{t(mode.descriptionKey)}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-dashed bg-muted/40 p-6 text-center text-sm text-muted-foreground">
          {t('app.placeholder')}
        </div>
      </CardContent>
    </Card>
  )
}

function App() {
  const { t } = useTranslation()
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)
  const tab = useAppStore((s) => s.tab)
  const setTab = useAppStore((s) => s.setTab)
  const telemetryConsent = useTelemetryStore((s) => s.consent)
  const trackedModeRef = useRef<AppMode | null>(null)
  const trackedTabRef = useRef<SidebarTab | null>(null)

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

  useEffect(() => {
    if (trackedModeRef.current === mode) return
    trackedModeRef.current = mode
    void trackTelemetry('mode_changed', { mode })
  }, [mode])

  useEffect(() => {
    if (trackedTabRef.current === tab) return
    trackedTabRef.current = tab
    void trackTelemetry('sidebar_tab_changed', { tab })
  }, [tab])

  // 首次打开主界面的新手引导
  const mainTour = useOnboardingTour({
    id: 'main-v2',
    autoStartOnFirstVisit: telemetryConsent !== 'pending',
  })
  // 专项引导手动启动，不自动打扰用户。
  const regionTour = useOnboardingTour({
    id: 'region-v2',
    steps: REGION_TOUR_STEPS,
    autoStartOnFirstVisit: false,
  })
  const downloadCenterTour = useOnboardingTour({
    id: 'download-center-v2',
    steps: DOWNLOAD_CENTER_TOUR_STEPS,
    autoStartOnFirstVisit: false,
  })
  const imageryTour = useOnboardingTour({
    id: 'imagery-v2',
    steps: IMAGERY_TOUR_STEPS,
    autoStartOnFirstVisit: false,
  })
  const mvtTour = useOnboardingTour({
    id: 'mvt-v2',
    steps: MVT_TOUR_STEPS,
    autoStartOnFirstVisit: false,
  })
  const osmTour = useOnboardingTour({
    id: 'osm-v2',
    steps: OSM_TOUR_STEPS,
    autoStartOnFirstVisit: false,
  })
  const tiles3dTour = useOnboardingTour({
    id: 'tiles3d-v2',
    steps: TILES3D_TOUR_STEPS,
    autoStartOnFirstVisit: false,
  })
  const waybackTour = useOnboardingTour({
    id: 'wayback-v2',
    steps: WAYBACK_TOUR_STEPS,
    autoStartOnFirstVisit: false,
  })

  // 先切到目标上下文，再启动引导，避免 driver.js 指向仍挂载但被隐藏的面板。
  const startTourInContext = (
    runner: () => void,
    context: { mode?: AppMode; tab?: SidebarTab },
  ) => {
    const needsModeChange = context.mode !== undefined && mode !== context.mode
    const needsTabChange = context.tab !== undefined && tab !== context.tab
    if (needsModeChange && context.mode) setMode(context.mode)
    if (needsTabChange && context.tab) setTab(context.tab)
    if (needsModeChange || needsTabChange) window.setTimeout(runner, 250)
    else runner()
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
                title={t(m.descriptionKey)}
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
        <>
          <AssistantButton />
          <HelpButton
            onStartMain={mainTour.start}
            onStartRegion={() =>
              startTourInContext(regionTour.start, { mode: 'imagery', tab: 'download' })
            }
            onStartDownloadCenter={() =>
              startTourInContext(downloadCenterTour.start, { tab: 'history' })
            }
            onStartImagery={() =>
              startTourInContext(imageryTour.start, { mode: 'imagery', tab: 'download' })
            }
            onStartMvt={() =>
              startTourInContext(mvtTour.start, { mode: 'mvt', tab: 'download' })
            }
            onStartOsm={() =>
              startTourInContext(osmTour.start, { mode: 'vector', tab: 'download' })
            }
            onStartTiles3d={() =>
              startTourInContext(tiles3dTour.start, { mode: 'tiles3d', tab: 'download' })
            }
            onStartWayback={() =>
              startTourInContext(waybackTour.start, { mode: 'wayback', tab: 'download' })
            }
          />
        </>
      }
    >
      <div className="flex h-[calc(100vh-3rem)] w-screen flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 overflow-hidden">
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
            {SIDEBAR_TABS.map((tabMeta) => {
              const Icon = tabMeta.icon
              const active = tabMeta.value === tab
              return (
                <button
                  key={tabMeta.value}
                  type="button"
                  onClick={() => setTab(tabMeta.value)}
                  data-tour={
                    tabMeta.value === 'settings'
                      ? 'settings-tab'
                      : tabMeta.value === 'history'
                        ? 'history-tab'
                        : undefined
                  }
                  className={cn(
                    'relative flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors',
                    active
                      ? 'bg-background text-foreground'
                      : 'text-muted-foreground hover:bg-background/40 hover:text-foreground',
                  )}
                >
                  <Icon className={cn('size-3.5', active && 'text-primary')} />
                  {t(tabMeta.labelKey)}
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
            <div
              className={tab === 'history' ? 'space-y-3 p-3' : 'hidden'}
              data-agent-target="download-center"
              data-tour="download-center"
            >
              <PanelSection icon={ClipboardList} title={t('app.tasks.title')} description={t('app.tasks.description')} dataTour="active-tasks-section">
                <TasksPanel />
              </PanelSection>
              <PanelSection icon={HistoryIcon} title={t('app.tasks.historyTitle')} description={t('app.tasks.historyDescription')} dataTour="history-section">
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
        {/* 全局：OSM Standard 下载政策确认 */}
        <OsmDownloadPolicyDialog />
        {/* 全局：检查更新对话框 */}
        <UpdateDialog />
        {/* 全局：首次匿名统计授权 */}
        <TelemetryBootstrap />

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
        <MapStatusBar />
      </div>
    </AppShell>
  )
}

export default App
