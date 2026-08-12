import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { Download, FolderOpen, Loader2, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { GeoJsonObject } from 'geojson'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { PanelSection } from '@/components/layout/panel-section'

import { useSelectionStore } from '@/store/selection-store'
import { useAppStore } from '@/store/app-store'
import { useVectorLayersStore } from '@/store/vector-layers-store'
import { isTauriRuntime } from '@/lib/tauri'
import { getSettings } from '@/features/settings/settings-api'
import {
  parseRegionFile,
  REGION_FILE_ACCEPT_ATTR,
  UnsupportedRegionFileError,
} from '@/lib/geo-import'
import { createOsmDownloadTask } from './vector-api'
import { downloadAdminBoundaryFile } from '@/features/admin/admin-api'

type FeatureType = 'roads' | 'buildings' | 'waterways' | 'landuse' | 'pois' | 'railways' | 'natural'

const FEATURE_OPTIONS: { value: FeatureType; label: string }[] = [
  { value: 'roads', label: '道路' },
  { value: 'buildings', label: '建筑' },
  { value: 'waterways', label: '水系' },
  { value: 'landuse', label: '土地利用' },
  { value: 'pois', label: '兴趣点 (POI)' },
  { value: 'railways', label: '铁路' },
  { value: 'natural', label: '自然要素' },
]

function countFeatures(geojson: GeoJsonObject): number {
  const obj = geojson as { type?: string; features?: unknown[] }
  if (obj.type === 'FeatureCollection') return obj.features?.length ?? 0
  if (obj.type === 'Feature') return 1
  return 0
}

export function VectorPanel() {
  const inTauri = isTauriRuntime()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const [featureType, setFeatureType] = useState<FeatureType>('roads')
  const [osmTaskName, setOsmTaskName] = useState('')
  const [statusMsg, setStatusMsg] = useState<string>('绘制区域或选择行政区划后可下载')

  const bounds = useSelectionStore((s) => s.bounds)
  const polygon = useSelectionStore((s) => s.polygon)
  const currentAdminCode = useAppStore((s) => s.currentAdminCode)

  const layers = useVectorLayersStore((s) => s.layers)
  const addLayer = useVectorLayersStore((s) => s.addLayer)
  const clearLayers = useVectorLayersStore((s) => s.clear)

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings, enabled: inTauri })

  // 状态文本随选区/行政区变化更新
  useEffect(() => {
    if (bounds && currentAdminCode) setStatusMsg('可下载 OSM 和行政边界')
    else if (bounds) setStatusMsg('可下载 OSM（选择行政区可下载边界）')
    else if (currentAdminCode) setStatusMsg('可下载行政边界（绘制区域可下载 OSM）')
    else setStatusMsg('绘制区域或选择行政区划后可下载')
  }, [bounds, currentAdminCode])

  const proxy =
    settingsQuery.data?.proxy_enabled && settingsQuery.data.proxy_url
      ? settingsQuery.data.proxy_url
      : null

  const osmMutation = useMutation({
    mutationFn: async () => {
      if (!bounds) throw new Error('请先绘制或选择一个区域')
      const featLabel = FEATURE_OPTIONS.find((o) => o.value === featureType)?.label ?? featureType
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const defaultName = `osm_${featureType}_${ts}.geojson`
      const savePath = await saveDialog({
        defaultPath: defaultName,
        filters: [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }],
      })
      if (!savePath) throw new Error('__user_cancelled__')

      const taskName = osmTaskName.trim() || `OSM ${featLabel}`
      // OSM Overpass 只接受单个外环
      const osmRing = polygon && polygon.length > 0 ? polygon[0] : null
      return createOsmDownloadTask(
        bounds,
        featureType,
        savePath as string,
        proxy,
        osmRing,
        taskName,
      )
    },
    onSuccess: () => {
      toast.success('OSM 下载任务已创建')
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(`OSM 下载失败：${msg}`)
    },
  })

  const adminMutation = useMutation({
    mutationFn: async () => {
      if (!currentAdminCode) throw new Error('请先选择行政区划')
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const defaultName = `admin_${currentAdminCode}_${ts}.geojson`
      const savePath = await saveDialog({
        defaultPath: defaultName,
        filters: [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }],
      })
      if (!savePath) throw new Error('__user_cancelled__')
      await downloadAdminBoundaryFile(currentAdminCode, savePath as string)
      return savePath as string
    },
    onSuccess: (path) => {
      toast.success(`已保存：${path}`)
      qc.invalidateQueries({ queryKey: ['download-history'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(`边界下载失败：${msg}`)
    },
  })

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    let added = 0
    for (const file of Array.from(files)) {
      try {
        let geojson: GeoJsonObject
        try {
          geojson = await parseRegionFile(file)
        } catch (e) {
          if (e instanceof UnsupportedRegionFileError) {
            toast.error(e.message)
            continue
          }
          throw e
        }
        const featureCount = countFeatures(geojson)
        addLayer({ filename: file.name, geojson, featureCount })
        added += 1
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`加载 ${file.name} 失败：${msg}`)
      }
    }
    if (added > 0) toast.success(`已加载 ${added} 个矢量文件`)
  }

  return (
    <PanelSection icon={Download} title="矢量数据" description="OSM / 边界 / 本地导入" dataTour="osm-panel">
      <div className="space-y-1.5" data-tour="osm-feature-type">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">OSM 要素类型</Label>
        <Select value={featureType} onValueChange={(v) => setFeatureType(v as FeatureType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FEATURE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5 border-t border-border/60 pt-3" data-tour="vector-output-section">
        <Label className="text-xs">
          OSM 任务名称 <span className="text-muted-foreground">(可选)</span>
        </Label>
        <Input
          value={osmTaskName}
          onChange={(e) => setOsmTaskName(e.target.value)}
          placeholder="留空则自动生成，例如 OSM 道路"
          className="h-8 text-xs"
        />
      </div>

      <div className="grid grid-cols-2 gap-2" data-tour="osm-download-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={!bounds || osmMutation.isPending}
          onClick={() => osmMutation.mutate()}
        >
          {osmMutation.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="mr-1 h-3.5 w-3.5" />
          )}
          下载 OSM
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!currentAdminCode || adminMutation.isPending}
          onClick={() => adminMutation.mutate()}
        >
          {adminMutation.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="mr-1 h-3.5 w-3.5" />
          )}
          下载边界
        </Button>
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <FolderOpen className="mr-1 h-3.5 w-3.5" />
          加载本地
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={layers.length === 0}
          onClick={() => {
            clearLayers()
            toast.success('已清除矢量图层')
          }}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          清除图层
        </Button>
      </div>

      {layers.length > 0 && (
        <div className="space-y-1 rounded border bg-background/50 p-2 text-xs">
          {layers.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5 truncate">
                <Upload className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate" title={l.filename}>
                  {l.filename}
                </span>
                <span className="shrink-0 text-muted-foreground">({l.featureCount})</span>
              </div>
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => useVectorLayersStore.getState().removeLayer(l.id)}
                aria-label="移除"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{statusMsg}</p>

      <input
        ref={fileRef}
        type="file"
        accept={REGION_FILE_ACCEPT_ATTR}
        multiple
        className="hidden"
        onChange={(e) => {
          void onPickFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </PanelSection>
  )
}
