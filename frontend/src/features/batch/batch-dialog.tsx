import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useBatchStore } from '@/store/batch-store'
import { useImageryParamsStore } from '@/store/imagery-params-store'
import { useAppStore } from '@/store/app-store'
import { useSelectionStore } from '@/store/selection-store'
import { createDownloadTask } from '@/features/download/download-api'
import { getSettings } from '@/features/settings/settings-api'
import {
  focusImagerySourcePicker,
  requestOsmDownloadApproval,
} from '@/features/sources/osm-download-policy'
import {
  bboxAreaKm2,
  collectPropertyKeys,
  deduplicateFilenames,
  extractFeaturePolygon,
  featureBbox,
  recommendNameField,
  sanitizeFilename,
} from './batch-utils'
import type { DownloadRequest } from '@/types/api'

const INDEX_FIELD = '__index__'

function loadCurrentSettings() {
  return getSettings()
}

export function BatchDialog() {
  const features = useBatchStore((s) => s.features)
  const filename = useBatchStore((s) => s.filename)
  const stage = useBatchStore((s) => s.stage)
  const setStage = useBatchStore((s) => s.setStage)
  const close = useBatchStore((s) => s.close)
  const setExternalSelection = useSelectionStore((s) => s.setExternalSelection)
  const params = useImageryParamsStore()
  const qc = useQueryClient()

  const open = features != null && stage != null
  const total = features?.length ?? 0

  const propertyKeys = useMemo(() => (features ? collectPropertyKeys(features) : []), [features])
  const [nameField, setNameField] = useState<string>(INDEX_FIELD)
  const [batchConcurrency, setBatchConcurrency] = useState<number>(2)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [running, setRunning] = useState(false)

  // 进入 panel 阶段时初始化默认命名字段、全选
  useEffect(() => {
    if (stage === 'panel' && features) {
      const recommended = recommendNameField(propertyKeys)
      setNameField(recommended ?? INDEX_FIELD)
      setSelected(new Set(features.map((_, i) => i)))
    }
    if (stage == null) {
      setSelected(new Set())
      setRunning(false)
    }
  }, [stage, features, propertyKeys])

  const onClose = () => {
    if (running) return
    close()
  }

  // === 模式选择 ===
  const onPickMerge = () => {
    if (!features) return
    // 合并：把所有 polygon 合并成 selection（rings）
    const rings = features
      .map(extractFeaturePolygon)
      .filter((p): p is NonNullable<ReturnType<typeof extractFeaturePolygon>> => !!p)
      .flat()
    if (rings.length === 0) {
      toast.error('文件中未发现 Polygon / MultiPolygon')
      close()
      return
    }
    let n = -Infinity, s = Infinity, e = -Infinity, w = Infinity
    for (const r of rings) {
      for (const p of r) {
        if (p.lat > n) n = p.lat
        if (p.lat < s) s = p.lat
        if (p.lng > e) e = p.lng
        if (p.lng < w) w = p.lng
      }
    }
    setExternalSelection({ bounds: { north: n, south: s, east: e, west: w }, polygon: rings })
    toast.success(`已合并 ${features.length} 个要素为单个选区`)
    close()
  }

  const onPickBatch = () => setStage('panel')

  // === 批量下载 ===
  const startBatch = async () => {
    if (!features || selected.size === 0) return
    if (!params.ready || !params.source) {
      toast.error('请先在影像下载面板选择图源与参数')
      return
    }

    const policyDecision = await requestOsmDownloadApproval(
      params.source,
      params.sourceUrl,
    )
    if (policyDecision === 'switch') {
      close()
      useAppStore.getState().setMode('imagery')
      useAppStore.getState().setTab('download')
      focusImagerySourcePicker()
      return
    }
    if (policyDecision === 'cancel') return

    let dir: string | null = null
    try {
      const r = await openDialog({ directory: true, title: '选择批量下载输出目录' })
      dir = typeof r === 'string' ? r : null
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`选择目录失败：${msg}`)
      return
    }
    if (!dir) return

    const settings = await loadCurrentSettings().catch(() => null)
    const proxy =
      settings?.proxy_enabled && settings.proxy_url ? settings.proxy_url : null
    const tiandituToken = settings?.tianditu_token ?? null

    const indices = Array.from(selected).sort((a, b) => a - b)
    const ext =
      params.format === 'geotiff'
        ? '.tif'
        : params.format === 'png'
        ? '.png'
        : params.format === 'jpeg'
        ? '.jpg'
        : params.format === 'mbtiles'
        ? '.mbtiles'
        : params.format === 'gpkg'
        ? '.gpkg'
        : '' // tiles 目录无扩展名

    const rawNames = indices.map((i) => {
      const f = features[i]
      if (nameField === INDEX_FIELD) return String(i + 1).padStart(3, '0')
      return f.properties && f.properties[nameField] != null
        ? sanitizeFilename(f.properties[nameField], i + 1)
        : String(i + 1).padStart(3, '0')
    })
    const names = deduplicateFilenames(rawNames)

    const sep = dir.includes('/') ? '/' : '\\'
    const tasks = indices.map((i, k) => ({
      feature: features[i],
      filename: ext ? `${names[k]}_z${params.zoom}${ext}` : `${names[k]}_z${params.zoom}`,
      savePath: ext
        ? `${dir}${sep}${names[k]}_z${params.zoom}${ext}`
        : `${dir}${sep}${names[k]}_z${params.zoom}`,
    }))

    setRunning(true)
    let success = 0
    let failed = 0
    let queueIdx = 0
    const concurrency = Math.max(1, Math.min(batchConcurrency, tasks.length))

    const launchOne = async (task: (typeof tasks)[number]) => {
      const bbox = featureBbox(task.feature)
      if (!bbox) {
        failed++
        return
      }
      const polygon = extractFeaturePolygon(task.feature)
      const request: DownloadRequest = {
        bounds: bbox,
        zoom: params.zoom,
        zoom_max: params.zoomMax ?? null,
        source: params.source,
        format: params.format,
        save_path: task.savePath,
        concurrency: params.concurrency,
        proxy,
        tianditu_token: tiandituToken,
        crop_to_shape: params.cropToShape && polygon != null,
        polygon: params.cropToShape && polygon ? polygon : null,
        compression: params.format === 'geotiff' ? params.compression : 'none',
        build_pyramid: params.format === 'geotiff' && params.buildPyramid,
      }
      try {
        await createDownloadTask(request, task.filename, params.sourceName || params.source)
        success++
      } catch (err) {
        failed++
        console.error(`批量任务 ${task.filename} 创建失败`, err)
      }
    }

    const worker = async () => {
      while (true) {
        const my = queueIdx++
        if (my >= tasks.length) return
        await launchOne(tasks[my])
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))

    setRunning(false)
    qc.invalidateQueries({ queryKey: ['active-tasks'] })
    qc.invalidateQueries({ queryKey: ['resumable-tasks'] })
    if (failed > 0) {
      toast.warning(`批量任务已创建：成功 ${success}，失败 ${failed}`)
    } else {
      toast.success(`批量任务已创建：${success} 个`)
    }
    useAppStore.getState().setTab('history')
    close()
  }

  // === Mode 阶段 UI ===
  if (open && stage === 'mode') {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>多要素文件检测到 {total} 个要素</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {filename || '上传文件'} 包含 {total} 个要素，请选择处理方式：
            </p>
            <div className="space-y-2">
              <button
                type="button"
                onClick={onPickMerge}
                className="w-full rounded-md border bg-card p-3 text-left text-sm hover:bg-accent"
              >
                <div className="font-medium">合并为单个选区</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  将所有要素合并显示，按合并后的范围下载（一次任务）
                </div>
              </button>
              <button
                type="button"
                onClick={onPickBatch}
                className="w-full rounded-md border bg-card p-3 text-left text-sm hover:bg-accent"
              >
                <div className="font-medium">批量独立下载</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  每个要素生成单独的文件（仅桌面端 / 影像模式）
                </div>
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  // === Panel 阶段 UI ===
  if (open && stage === 'panel' && features) {
    const totalArea = features.reduce((acc, f) => {
      const bb = featureBbox(f)
      return acc + (bb ? bboxAreaKm2(bb) : 0)
    }, 0)
    const selectedArea = Array.from(selected).reduce((acc, i) => {
      const bb = featureBbox(features[i])
      return acc + (bb ? bboxAreaKm2(bb) : 0)
    }, 0)

    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>批量独立下载（{features.length} 个要素）</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">命名字段</Label>
              <Select value={nameField} onValueChange={setNameField}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {propertyKeys.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k === '__source_file' ? '来源文件名' : k}
                    </SelectItem>
                  ))}
                  <SelectItem value={INDEX_FIELD}>序号 (001, 002, ...)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">批量并发：{batchConcurrency}</Label>
              <Slider
                min={1}
                max={8}
                step={1}
                value={[batchConcurrency]}
                onValueChange={(v) => setBatchConcurrency(v[0] ?? batchConcurrency)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              已选 {selected.size} / {features.length} ·{' '}
              {selectedArea.toFixed(2)} / {totalArea.toFixed(2)} km²
            </span>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setSelected(new Set(features.map((_, i) => i)))}
              >
                全选
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setSelected(new Set())}
              >
                清空
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  setSelected((prev) => {
                    const next = new Set<number>()
                    for (let i = 0; i < features.length; i++) if (!prev.has(i)) next.add(i)
                    return next
                  })
                }}
              >
                反选
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto rounded-md border">
            {features.map((f, i) => {
              const bb = featureBbox(f)
              const area = bb ? bboxAreaKm2(bb) : 0
              const display =
                nameField === INDEX_FIELD
                  ? String(i + 1).padStart(3, '0')
                  : f.properties && f.properties[nameField] != null
                  ? String(f.properties[nameField])
                  : String(i + 1).padStart(3, '0')
              const checked = selected.has(i)
              return (
                <label
                  key={i}
                  className="flex cursor-pointer items-center gap-2 border-b border-border/40 px-2 py-1.5 text-xs last:border-b-0 hover:bg-accent/40"
                >
                  <input
                    type="checkbox"
                    className="size-3.5"
                    checked={checked}
                    onChange={(e) => {
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(i)
                        else next.delete(i)
                        return next
                      })
                    }}
                  />
                  <span className="w-10 text-muted-foreground">
                    {String(i + 1).padStart(3, '0')}
                  </span>
                  <span className="flex-1 truncate" title={display}>
                    {display}
                  </span>
                  <span className="text-muted-foreground">{area.toFixed(2)} km²</span>
                </label>
              )
            })}
          </div>

          {!params.ready || !params.source ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
              请先在影像下载面板选择图源 / 缩放 / 格式等参数
            </div>
          ) : (
            <div className="rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground">
              将使用：图源 <strong>{params.sourceName || params.source}</strong> · 缩放{' '}
              <strong>z{params.zoom}</strong>
              {params.zoomMax ? `~z${params.zoomMax}` : ''} · 格式{' '}
              <strong>{params.format}</strong>
              {params.format === 'geotiff' ? ` / ${params.compression}` : ''} · 单任务并发{' '}
              <strong>{params.concurrency}</strong>
              {params.cropToShape ? ' · 按要素裁剪' : ''}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={running}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void startBatch()}
              disabled={running || selected.size === 0 || !params.ready || !params.source}
            >
              {running ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <Play className="mr-1 size-3.5" />
              )}
              开始批量下载（{selected.size}）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return null
}
