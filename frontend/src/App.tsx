import { Boxes, CalendarClock, Image as ImageIcon, Map, Mountain, Shapes } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AboutDialog } from '@/features/about/about-dialog'
import { ImageryPage } from '@/features/imagery/imagery-page'
import { SettingsDialog } from '@/features/settings/settings-dialog'
import { SourcesDialog } from '@/features/sources/sources-dialog'
import { TasksDialog } from '@/features/tasks/tasks-dialog'
import { useAppStore, type AppMode } from '@/store/app-store'

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
    short: '影像',
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
    value: 'vector',
    label: '矢量瓦片',
    short: '矢量',
    description: '矢量瓦片 / Shapefile 批量下载。',
    icon: Shapes,
  },
]

function ModePlaceholder({ mode }: { mode: ModeMeta }) {
  const Icon = mode.icon
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-5" />
          </div>
          <div>
            <CardTitle>{mode.label}</CardTitle>
            <CardDescription>{mode.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid min-h-[420px] place-items-center rounded-xl border border-dashed bg-muted/40 text-center">
          <div>
            <Icon className="mx-auto mb-4 size-10 text-muted-foreground" />
            <p className="text-sm font-medium">该模块尚未迁移到 React 版</p>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              当前生产入口仍为旧版 static 前端，React 版按规划文档逐步切片。
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function App() {
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)

  return (
    <AppShell>
      <section className="flex min-h-[calc(100vh-3rem)] flex-col bg-muted/30">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b bg-background/80 px-6 py-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Map className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold leading-none">GeoDownloader</h1>
                <Badge variant="secondary">Phase 1 · 骨架</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                React + Vite + shadcn 渐进迁移工作台
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <TasksDialog />
            <SourcesDialog />
            <SettingsDialog />
            <AboutDialog />
          </div>
        </header>

        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as AppMode)}
          className="flex flex-1 flex-col"
        >
          <div className="border-b bg-background px-6 py-3">
            <TabsList>
              {MODES.map((m) => {
                const Icon = m.icon
                return (
                  <TabsTrigger key={m.value} value={m.value}>
                    <Icon className="size-4" />
                    {m.short}
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </div>

          <div className="flex-1 p-5">
            {MODES.map((m) => (
              <TabsContent key={m.value} value={m.value} className="mt-0">
                {m.value === 'imagery' ? <ImageryPage /> : <ModePlaceholder mode={m} />}
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </section>
    </AppShell>
  )
}

export default App
