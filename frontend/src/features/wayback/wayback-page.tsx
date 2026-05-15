import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Download, FolderOpen, History, Loader2, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { isTauriRuntime } from '@/lib/tauri'
import { PanelSection } from '@/components/layout/panel-section'
import { StatCard } from '@/components/layout/stat-card'
import { RegionSelector } from '@/features/region/region-selector'
import { getSettings } from '@/features/settings/settings-api'
import { estimateDownload } from '@/features/download/download-api'
import { buildSelectionCropPolygon } from '@/features/download/crop-utils'
import {
  BuildPyramidToggle,
  SelectionCropToggle,
  TiffCompressionSelect,
  type TiffCompression,
} from '@/features/download/output-controls'
import { useSelectionStore } from '@/store/selection-store'
import { useAppStore } from '@/store/app-store'
import { useWaybackStore } from '@/store/wayback-store'
import {
  createWaybackTask,
  downloadWaybackIncremental,
  getWaybackScanProgress,
  getWaybackVersions,
  probeWaybackMaxZoom,
  scanWaybackMetadata,
} from './wayback-api'
import type {
  DownloadEstimate,
  DownloadRequest,
  WaybackReleaseSummary,
  WaybackVersion,
} from '@/types/api'

type WbMode = 'single' | 'batch' | 'incremental'

const FORMAT_OPTIONS = [
  { value: 'geotiff', label: 'GeoTIFF (.tif)' },
  { value: 'png', label: 'PNG (.png)' },
  { value: 'jpeg', label: 'JPEG (.jpg)' },
  { value: 'mbtiles', label: 'MBTiles (.mbtiles)' },
  { value: 'gpkg', label: 'GeoPackage (.gpkg)' },
]

function extOf(format: string) {
  switch (format) {
    case 'geotiff':
      return 'tif'
    case 'png':
      return 'png'
    case 'mbtiles':
      return 'mbtiles'
    case 'gpkg':
      return 'gpkg'
    default:
      return 'jpg'
  }
}

function formatZoomLabel(levels: number[]) {
  if (levels.length === 0) return 'z?'
  if (levels.length === 1) return `z${levels[0]}`
  const isContig = levels.every((z, i) => i === 0 || z === levels[i - 1] + 1)
  if (isContig) return `z${levels[0]}-${levels[levels.length - 1]}`
  return `z${levels.join('-')}`
}

function timestampNow() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function joinPath(dir: string, file: string) {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${file}` : `${dir}${sep}${file}`
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'wayback'
}

function looksLikeFilePath(path: string, ext: string): boolean {
  return path.trim().toLowerCase().endsWith(`.${ext.toLowerCase()}`)
}

function formatBytes(mb?: number | null): string {
  if (mb == null || !Number.isFinite(mb)) return '-'
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(2)} MB`
}

export function WaybackPage() {
  const inTauri = isTauriRuntime()
  const qc = useQueryClient()

  const bounds = useSelectionStore((s) => s.bounds)
  const polygon = useSelectionStore((s) => s.polygon)
  const setPreviewVersionId = useWaybackStore((s) => s.setPreviewVersionId)
  const previewVersionId = useWaybackStore((s) => s.previewVersionId)

  const [wbMode, setWbMode] = useState<WbMode>('single')
  const [versionId, setVersionId] = useState<string>('')
  const [zoomLevels, setZoomLevels] = useState<number[]>([13])
  const [format, setFormat] = useState<string>('geotiff')
  const [compression, setCompression] = useState<string>('lzw')
  const [cropToShape, setCropToShape] = useState<boolean>(true)
  const [buildPyramid, setBuildPyramid] = useState<boolean>(false)
  const [concurrency, setConcurrency] = useState<number>(8)
  const [taskName, setTaskName] = useState<string>('')
  const [singleSaveDir, setSingleSaveDir] = useState<string>('')
  const [batchSaveDir, setBatchSaveDir] = useState<string>('')
  const [incrementalSaveDir, setIncrementalSaveDir] = useState<string>('')
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set())
  const [scanMode, setScanMode] = useState<'fast' | 'fine' | 'official'>('official')
  const [releaseDateFrom, setReleaseDateFrom] = useState<string>('')
  const [releaseDateTo, setReleaseDateTo] = useState<string>('')
  const [coverageThreshold, setCoverageThreshold] = useState<number>(5)
  const [dominantThreshold, setDominantThreshold] = useState<number>(50)
  const [onlyLatestPerYear, setOnlyLatestPerYear] = useState<boolean>(false)
  const [scanReleases, setScanReleases] = useState<WaybackReleaseSummary[]>([])
  const [scanReleasesScanned, setScanReleasesScanned] = useState<number>(0)
  const [scanProgress, setScanProgress] = useState<{
    current: number
    total: number
    footprints: number
    elapsed: number
  } | null>(null)
  const [estimate, setEstimate] = useState<DownloadEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [incSelected, setIncSelected] = useState<Set<string>>(new Set())
  const scanAbortRef = useRef(false)
  const supportsSelectionCrop =
    format === 'geotiff' || format === 'png' || format === 'mbtiles' || format === 'gpkg'
  const effectiveCropToShape = cropToShape && supportsSelectionCrop

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    enabled: inTauri,
  })
  // 全局并发统一从设置中获取（不在面板中暴露调节器）
  useEffect(() => {
    const c = settingsQuery.data?.default_concurrency
    if (typeof c === 'number' && c > 0) setConcurrency(c)
  }, [settingsQuery.data?.default_concurrency])
  const proxy =
    settingsQuery.data?.proxy_enabled && settingsQuery.data.proxy_url
      ? settingsQuery.data.proxy_url
      : null

  const versionsQuery = useQuery({
    queryKey: ['wayback-versions', proxy ?? ''],
    queryFn: () => getWaybackVersions(proxy),
    enabled: inTauri,
    staleTime: 5 * 60_000,
  })

  // 默认选第一个版本
  useEffect(() => {
    const list = versionsQuery.data
    if (list && list.length > 0 && !versionId) {
      setVersionId(list[0].id)
    }
  }, [versionsQuery.data, versionId])

  // 同步 Wayback 预览图层（仅在单/批模式下展示当前选中版本）
  useEffect(() => {
    if (wbMode === 'incremental') {
      setPreviewVersionId(null)
      return
    }
    setPreviewVersionId(versionId || null)
  }, [versionId, wbMode, setPreviewVersionId])

  // 时间轴 → 侧栏：当外部（时间轴）改变 previewVersionId 时同步 select
  useEffect(() => {
    if (wbMode === 'incremental') return
    if (previewVersionId && previewVersionId !== versionId) {
      setVersionId(previewVersionId)
    }
  }, [previewVersionId, wbMode, versionId])

  // 离开页面时移除 wayback 预览
  useEffect(() => {
    return () => setPreviewVersionId(null)
  }, [setPreviewVersionId])

  const sortedVersions: WaybackVersion[] = useMemo(
    () => versionsQuery.data ?? [],
    [versionsQuery.data],
  )

  const selectedVersion = sortedVersions.find((v) => v.id === versionId) ?? null
  const sortedLevels = useMemo(
    () => [...new Set(zoomLevels)].sort((a, b) => a - b),
    [zoomLevels],
  )
  const zoom = sortedLevels[0] ?? 13
  const zMaxLevel = sortedLevels[sortedLevels.length - 1] ?? zoom
  const zMaxValue = zMaxLevel > zoom ? zMaxLevel : null
  const zLevelsForApi: number[] | null = sortedLevels.length > 0 ? sortedLevels : null
  const zLabel = formatZoomLabel(sortedLevels.length > 0 ? sortedLevels : [zoom])
  const currentOutputPath =
    wbMode === 'single'
      ? singleSaveDir
      : wbMode === 'batch'
        ? batchSaveDir
        : incrementalSaveDir
  const outputPathPlaceholder = '选择下载保存目录，文件名会自动生成'

  const setCurrentOutputPath = (path: string) => {
    if (wbMode === 'single') setSingleSaveDir(path)
    else if (wbMode === 'batch') setBatchSaveDir(path)
    else setIncrementalSaveDir(path)
  }

  const makeDefaultFilename = (date: string, stem = 'wayback') =>
    `${sanitizeName(stem)}_${date}_${zLabel}_${timestampNow()}.${extOf(format)}`

  const pickOutputPath = async () => {
    const picked = await openDialog({
      directory: true,
      title:
        wbMode === 'single'
          ? '选择 Wayback 保存目录'
          : wbMode === 'batch'
            ? '选择批量下载保存目录'
            : '选择增量下载保存目录',
    })
    if (picked) setCurrentOutputPath(picked as string)
    return picked as string | null
  }

  const probeMutation = useMutation({
    mutationFn: async () => {
      if (!versionId) throw new Error('请先选择版本')
      // 取选区中心点
      const b = bounds
      let lat = 39.9
      let lng = 116.4
      if (b) {
        lat = (b.north + b.south) / 2
        lng = (b.east + b.west) / 2
      }
      return probeWaybackMaxZoom(versionId, lat, lng, proxy)
    },
    onSuccess: (z) => {
      setZoomLevels([z])
      toast.success(`最大缩放 z${z}`)
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`探测失败：${msg}`)
    },
  })

  // 自动估算：单版本模式下，参数变化后 400ms 防抖触发，结果显示在缩放下方
  useEffect(() => {
    if (wbMode !== 'single') return
    if (!bounds) {
      setEstimate(null)
      return
    }
    const t = window.setTimeout(() => {
      setEstimating(true)
      estimateDownload(bounds, zoom, format, effectiveCropToShape, zMaxValue, zLevelsForApi, {
        sourceId: 'wayback_satellite',
        buildPyramid: format === 'geotiff' ? buildPyramid : false,
        compression: format === 'geotiff' ? compression : 'none',
      })
        .then((res) => setEstimate(res))
        .catch(() => setEstimate(null))
        .finally(() => setEstimating(false))
    }, 400)
    return () => window.clearTimeout(t)
  }, [wbMode, bounds, zoom, zMaxValue, zLevelsForApi, format, cropToShape, effectiveCropToShape, compression, buildPyramid])

  // ========== 单个下载 ==========
  const singleMutation = useMutation({
    mutationFn: async () => {
      if (!versionId || !selectedVersion) throw new Error('请先选择版本')
      if (!bounds) throw new Error('请先选择下载区域')

      const ext = extOf(format)
      let saveDirOrPath = singleSaveDir.trim()
      if (!saveDirOrPath) {
        const picked = await openDialog({
          directory: true,
          title: '选择 Wayback 保存目录',
        })
        if (!picked) throw new Error('__user_cancelled__')
        saveDirOrPath = picked as string
        setSingleSaveDir(saveDirOrPath)
      }
      const defaultFilename = makeDefaultFilename(
        selectedVersion.date,
        taskName.trim() || 'wayback',
      )
      const savePath = looksLikeFilePath(saveDirOrPath, ext)
        ? saveDirOrPath
        : joinPath(saveDirOrPath, defaultFilename)

      const cropPolygon = buildSelectionCropPolygon(bounds, polygon, effectiveCropToShape)
      const request: DownloadRequest = {
        bounds,
        zoom,
        zoom_max: zMaxValue,
        zoom_levels: zLevelsForApi,
        source: 'esri_wayback',
        format,
        save_path: savePath,
        concurrency,
        proxy,
        polygon: cropPolygon,
        crop_to_shape: cropPolygon != null,
        tianditu_token: null,
        compression: format === 'geotiff' ? compression : 'none',
        build_pyramid: format === 'geotiff' && buildPyramid,
      }
      const finalTaskName = taskName.trim() || `Wayback ${selectedVersion.date} ${zLabel}`
      return createWaybackTask(request, versionId, selectedVersion.date, finalTaskName)
    },
    onSuccess: () => {
      toast.success('Wayback 下载任务已创建')
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(`下载失败：${msg}`)
    },
  })

  // ========== 批量下载 ==========
  const batchMutation = useMutation({
    mutationFn: async () => {
      if (!bounds) throw new Error('请先选择下载区域')
      if (batchSelected.size === 0) throw new Error('请至少选择一个版本')
      let dir = batchSaveDir.trim()
      if (!dir) {
        const picked = await openDialog({
          directory: true,
          title: '选择批量下载保存目录',
        })
        if (!picked) throw new Error('__user_cancelled__')
        dir = picked as string
        setBatchSaveDir(dir)
      }

      const ext = extOf(format)
      const versions = sortedVersions.filter((v) => batchSelected.has(v.id))
      const cropPolygon = buildSelectionCropPolygon(bounds, polygon, effectiveCropToShape)

      let created = 0
      for (const v of versions) {
        const filename = `wayback_${v.date}_${zLabel}_${timestampNow()}.${ext}`
        const savePath = joinPath(dir, filename)
        const request: DownloadRequest = {
          bounds,
          zoom,
          zoom_max: zMaxValue,
          zoom_levels: zLevelsForApi,
          source: 'esri_wayback',
          format,
          save_path: savePath,
          concurrency,
          proxy,
          polygon: cropPolygon,
          crop_to_shape: cropPolygon != null,
          tianditu_token: null,
          compression: format === 'geotiff' ? compression : 'none',
          build_pyramid: format === 'geotiff' && buildPyramid,
        }
        try {
          const finalTaskName = taskName.trim()
            ? `${taskName.trim()} ${v.date} ${zLabel}`
            : `Wayback ${v.date} ${zLabel}`
          await createWaybackTask(request, v.id, v.date, finalTaskName)
          created += 1
        } catch (e) {
          console.error(`批量任务 ${v.date} 创建失败:`, e)
        }
      }
      return created
    },
    onSuccess: (n) => {
      toast.success(`已创建 ${n} 个批量任务`)
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(`批量下载失败：${msg}`)
    },
  })

  // ========== 增量扫描 ==========
  const scanMutation = useMutation({
    mutationFn: async (opts: { forceRefresh?: boolean } = {}) => {
      const forceRefresh = opts.forceRefresh ?? false
      if (!bounds) throw new Error('请先选择下载区域')
      const zMin = Math.max(zoom - 1, 1)
      const zMaxScan = Math.min(zoom + 1, 22)
      const bbox: [number, number, number, number] = [
        bounds.west,
        bounds.south,
        bounds.east,
        bounds.north,
      ]
      scanAbortRef.current = false
      setScanReleases([])
      setIncSelected(new Set())
      setScanProgress(null)

      const res = await scanWaybackMetadata({
        bbox,
        zoom_min: zMin,
        zoom_max: zMaxScan,
        force_refresh: forceRefresh,
        proxy,
        scan_mode: scanMode,
        release_date_from: releaseDateFrom || null,
        release_date_to: releaseDateTo || null,
      })

      if (res.kind === 'result') {
        return res
      }

      // 后台扫描中，轮询进度
      const scanId = res.scan_id
      while (!scanAbortRef.current) {
        await new Promise((r) => setTimeout(r, 1500))
        const prog = await getWaybackScanProgress(scanId).catch(() => null)
        if (!prog) {
          // 扫描完成 → 重新查缓存
          const final = await scanWaybackMetadata({
            bbox,
            zoom_min: zMin,
            zoom_max: zMaxScan,
            force_refresh: false,
            proxy,
            scan_mode: scanMode,
            release_date_from: releaseDateFrom || null,
            release_date_to: releaseDateTo || null,
          })
          if (final.kind === 'result') return final
          throw new Error('扫描完成但未取得结果')
        }
        setScanProgress({
          current: prog.current,
          total: prog.total,
          footprints: prog.footprints_so_far,
          elapsed: prog.elapsed_sec,
        })
      }
      throw new Error('__user_cancelled__')
    },
    onSuccess: (res) => {
      if (res.kind !== 'result') return
      setScanReleases(res.releases ?? [])
      setScanReleasesScanned(res.releases_scanned ?? 0)
      setScanProgress(null)
      toast.success(`扫描完成：${res.releases.length} 个 release`)
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(`扫描失败：${msg}`)
      setScanProgress(null)
    },
  })

  // 增量结果过滤
  const filteredReleases: WaybackReleaseSummary[] = useMemo(() => {
    const cov = coverageThreshold / 100
    const dom = dominantThreshold / 100
    let items = scanReleases.filter(
      (r) =>
        (r.coverage_ratio ?? 0) >= cov &&
        (r.dominant_ratio ?? 0) >= dom &&
        r.dominant_capture_date,
    )
    if (onlyLatestPerYear) {
      const seen = new Map<string, WaybackReleaseSummary>()
      for (const r of items) {
        const year = r.dominant_capture_date.slice(0, 4)
        const prev = seen.get(year)
        if (!prev || (r.release_num ?? 0) > (prev.release_num ?? 0)) {
          seen.set(year, r)
        }
      }
      items = Array.from(seen.values()).sort(
        (a, b) => (b.release_num ?? 0) - (a.release_num ?? 0),
      )
    }
    return items
  }, [scanReleases, coverageThreshold, dominantThreshold, onlyLatestPerYear])

  // 选中默认全选
  useEffect(() => {
    setIncSelected(new Set(filteredReleases.map((r) => r.release_id)))
  }, [filteredReleases])

  const incDownloadMutation = useMutation({
    mutationFn: async () => {
      if (!bounds) throw new Error('请先选择下载区域')
      if (incSelected.size === 0) throw new Error('请至少选择一个 release')
      let dir = incrementalSaveDir.trim()
      if (!dir) {
        const picked = await openDialog({ directory: true, title: '选择保存目录' })
        if (!picked) throw new Error('__user_cancelled__')
        dir = picked as string
        setIncrementalSaveDir(dir)
      }

      const ext = extOf(format)
      const savePathBase = joinPath(dir, `${sanitizeName(taskName.trim() || 'wayback_inc')}.${ext}`)
      const cropPolygon = buildSelectionCropPolygon(bounds, polygon, effectiveCropToShape)
      const footprints = filteredReleases
        .filter((r) => incSelected.has(r.release_id))
        .map((r) => ({
          release_id: r.release_id,
          release_date: r.release_date,
          capture_date_str: r.dominant_capture_date,
          source_name: r.source_name,
          resolution_m: r.resolution_m,
        }))
      const result = await downloadWaybackIncremental({
        bounds,
        zoom,
        zoom_max: zMaxValue,
        zoom_levels: zLevelsForApi,
        format,
        save_path: savePathBase,
        footprints,
        crop_to_shape: cropPolygon != null,
        polygon: cropPolygon?.[0] ?? null,
        compression: format === 'geotiff' ? compression : 'none',
        build_pyramid: format === 'geotiff' && buildPyramid,
        task_name_prefix: taskName.trim() || null,
        proxy,
      })
      return result.task_ids.length
    },
    onSuccess: (n) => {
      toast.success(`已创建 ${n} 个增量下载任务`)
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(`下载失败：${msg}`)
    },
  })

  return (
    <div className="space-y-4">
      <RegionSelector />

      <PanelSection
        icon={History}
        title="Esri Wayback 历史影像"
        description="按时间轴访问 Esri 全球历史影像"
        dataTour="wayback-section"
        action={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            title="刷新版本列表"
            onClick={() => versionsQuery.refetch()}
            disabled={versionsQuery.isFetching}
          >
            {versionsQuery.isFetching ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        }
      >
        {/* 版本下拉 */}
        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            影像日期
          </Label>
          <Select value={versionId} onValueChange={setVersionId}>
            <SelectTrigger>
              <SelectValue placeholder={versionsQuery.isLoading ? '加载中...' : '选择日期'} />
            </SelectTrigger>
            <SelectContent>
              {sortedVersions.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.date}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 缩放级别（任意多选 chip） */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">缩放级别（任意多选）</Label>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                已选 {sortedLevels.length} 级
                {sortedLevels.length > 0 ? ` · ${zLabel}` : ''}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => probeMutation.mutate()}
                disabled={probeMutation.isPending}
                title="探测当前选区可达的最大 zoom"
              >
                {probeMutation.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <>
                    <Search className="size-3" />
                    <span className="ml-1">探测</span>
                  </>
                )}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-11 gap-1">
            {Array.from({ length: 22 }, (_, i) => i + 1).map((z) => {
              const checked = sortedLevels.includes(z)
              return (
                <button
                  key={z}
                  type="button"
                  onClick={() => {
                    setZoomLevels((prev) => {
                      const set = new Set(prev)
                      if (set.has(z)) set.delete(z)
                      else set.add(z)
                      const next = Array.from(set).sort((a, b) => a - b)
                      return next.length > 0 ? next : [z]
                    })
                  }}
                  className={`h-7 rounded border text-xs transition ${
                    checked
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-foreground hover:bg-muted'
                  }`}
                  title={`z${z}`}
                >
                  {z}
                </button>
              )
            })}
          </div>
          <div className="flex flex-wrap gap-1 text-xs">
            <button
              type="button"
              className="rounded border px-2 py-0.5 hover:bg-muted"
              onClick={() => {
                const arr: number[] = []
                for (let z = 10; z <= 14; z++) arr.push(z)
                setZoomLevels(arr)
              }}
            >
              z10-14
            </button>
            <button
              type="button"
              className="rounded border px-2 py-0.5 hover:bg-muted"
              onClick={() => {
                const arr: number[] = []
                for (let z = 14; z <= 18; z++) arr.push(z)
                setZoomLevels(arr)
              }}
            >
              z14-18
            </button>
            <button
              type="button"
              className="rounded border px-2 py-0.5 hover:bg-muted"
              onClick={() => {
                const arr: number[] = []
                for (let z = 15; z <= 19; z++) arr.push(z)
                setZoomLevels(arr)
              }}
            >
              z15-19
            </button>
            <button
              type="button"
              className="rounded border px-2 py-0.5 hover:bg-muted text-muted-foreground"
              onClick={() => setZoomLevels([13])}
            >
              重置(z13)
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            点击数字勾选/取消，可任意离散组合（如 z10、z15、z18 同时下载）。多级别会按 z&lt;N&gt; 子目录分级保存。
          </p>
        </div>

        {/* 自动估算结果 */}
        {wbMode === 'single' && bounds && (
          <StatCard variant="compact">
            {estimating ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                估算中…
              </span>
            ) : estimate ? (
              <>
                预计下载{' '}
                <strong>{estimate.tile_count.toLocaleString()}</strong> 个瓦片
                {' · '}输出约{' '}
                <strong>
                  {formatBytes(
                    estimate.estimated_output_mb ?? estimate.raw_size_mb ?? estimate.estimated_size_mb,
                  )}
                </strong>
                {' · '}流量约{' '}
                <span className="text-muted-foreground">
                  {formatBytes(estimate.tile_download_mb ?? estimate.estimated_size_mb)}
                </span>
                {estimate.warning && (
                  <div className="mt-1 text-amber-600 dark:text-amber-400">
                    {estimate.warning}
                  </div>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">等待估算…</span>
            )}
          </StatCard>
        )}

        {/* 输出参数 */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs">输出格式</Label>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMAT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {format === 'geotiff' && (
            <TiffCompressionSelect
              value={compression as TiffCompression}
              onChange={setCompression}
              triggerClassName="h-8 text-xs"
            />
          )}
        </div>

        {format === 'geotiff' && (
          <BuildPyramidToggle checked={buildPyramid} onChange={setBuildPyramid} />
        )}

        {supportsSelectionCrop && (
          <SelectionCropToggle
            bounds={bounds}
            polygon={polygon}
            checked={cropToShape}
            onChange={setCropToShape}
          />
        )}

        <div className="space-y-1.5">
          <Label className="text-xs">
            任务名称 <span className="text-muted-foreground">(可选)</span>
          </Label>
          <Input
            value={taskName}
            onChange={(e) => setTaskName(e.target.value)}
            placeholder={
              selectedVersion
                ? `留空则自动生成，例如 Wayback ${selectedVersion.date} ${zLabel}`
                : '留空则自动生成'
            }
            className="h-8 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">保存目录</Label>
          <div className="flex gap-1.5">
            <Input
              value={currentOutputPath}
              onChange={(e) => setCurrentOutputPath(e.target.value)}
              placeholder={outputPathPlaceholder}
              className="h-8 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              title="选择保存目录"
              onClick={() => void pickOutputPath()}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {wbMode === 'single'
              ? '单个版本会在该目录下自动生成文件名；也可手动输入完整文件路径。'
              : '批量/增量会在该目录下按日期生成多个文件，避免互相覆盖。'}
          </p>
        </div>

        <Separator />

        <Tabs value={wbMode} onValueChange={(v) => setWbMode(v as WbMode)}>
          <TabsList className="grid h-8 w-full grid-cols-3" data-tour="wayback-mode-tabs">
            <TabsTrigger value="single" className="text-xs">单个</TabsTrigger>
            <TabsTrigger value="batch" className="text-xs">批量</TabsTrigger>
            <TabsTrigger value="incremental" className="text-xs">增量</TabsTrigger>
          </TabsList>

          {/* 单个下载 */}
          <TabsContent value="single" className="mt-3 space-y-2">
            <Button
              type="button"
              size="sm"
              className="w-full"
              onClick={() => singleMutation.mutate()}
              disabled={singleMutation.isPending || !bounds || !versionId}
            >
              {singleMutation.isPending ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <Download className="mr-1 size-3.5" />
              )}
              下载历史影像
            </Button>
          </TabsContent>

          {/* 批量下载 */}
          <TabsContent value="batch" className="mt-3 space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setBatchSelected(new Set(sortedVersions.map((v) => v.id)))}
              >
                全选
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setBatchSelected(new Set())}
              >
                清空
              </Button>
              <span className="ml-auto text-muted-foreground">已选 {batchSelected.size}</span>
            </div>
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded border bg-background/50 p-2 text-xs">
              {sortedVersions.map((v) => (
                <label key={v.id} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={batchSelected.has(v.id)}
                    onChange={(e) => {
                      const next = new Set(batchSelected)
                      if (e.target.checked) next.add(v.id)
                      else next.delete(v.id)
                      setBatchSelected(next)
                    }}
                    className="size-3.5"
                  />
                  <span>{v.date}</span>
                  <span className="truncate text-muted-foreground">{v.title}</span>
                </label>
              ))}
            </div>
            <Button
              size="sm"
              className="w-full"
              onClick={() => batchMutation.mutate()}
              disabled={batchMutation.isPending || batchSelected.size === 0 || !bounds}
            >
              {batchMutation.isPending ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <Download className="mr-1 size-3.5" />
              )}
              批量下载选中版本
            </Button>
          </TabsContent>

          {/* 增量下载 */}
          <TabsContent value="incremental" className="mt-3 space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <Label className="text-xs">扫描模式</Label>
              <Select value={scanMode} onValueChange={(v) => setScanMode(v as 'fast' | 'fine' | 'official')}>
                <SelectTrigger className="h-7 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="official">极速（ESRI 官方版）</SelectItem>
                  <SelectItem value="fast">fast（AOI 全面）</SelectItem>
                  <SelectItem value="fine">fine（多层准确）</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="ml-auto h-7 text-xs"
                onClick={() => scanMutation.mutate({})}
                disabled={scanMutation.isPending || !bounds}
              >
                {scanMutation.isPending ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : (
                  <Search className="mr-1 size-3" />
                )}
                {scanReleases.length > 0 ? '重新扫描' : '扫描影像清单'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => scanMutation.mutate({ forceRefresh: true })}
                disabled={scanMutation.isPending || !bounds}
                title="跳过本地缓存，强制向 ESRI 服务器重新扫描"
              >
                <RefreshCw className="mr-1 size-3" />
                强制刷新
              </Button>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Label className="text-xs">时间范围</Label>
              <DatePicker
                value={releaseDateFrom}
                onChange={setReleaseDateFrom}
                placeholder="起始日期"
                maxDate={releaseDateTo || undefined}
              />
              <span className="text-muted-foreground">~</span>
              <DatePicker
                value={releaseDateTo}
                onChange={setReleaseDateTo}
                placeholder="截止日期"
                minDate={releaseDateFrom || undefined}
              />
            </div>

            {scanProgress && (
              <div className="space-y-1 rounded border bg-muted/20 p-2 text-xs">
                <div className="flex justify-between">
                  <span>
                    {scanProgress.current} / {scanProgress.total}
                  </span>
                  <span>{scanProgress.elapsed}s</span>
                </div>
                <div className="h-1 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${
                        scanProgress.total > 0
                          ? Math.round((scanProgress.current / scanProgress.total) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <div className="text-muted-foreground">
                  已发现 {scanProgress.footprints} 个 footprint
                </div>
              </div>
            )}

            {scanReleases.length > 0 && (
              <>
                <div className="rounded border bg-muted/20 p-2 text-xs">
                  扫描了 <strong>{scanReleasesScanned}</strong> 个 release，区域内有数据{' '}
                  <strong>{scanReleases.length}</strong> 个
                </div>

                <details className="rounded border bg-muted/10 px-2 py-1 text-xs">
                  <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                    字段含义说明
                  </summary>
                  <div className="mt-2 space-y-1.5 text-muted-foreground">
                    <div>
                      <span className="font-medium text-foreground">主导日期</span>
                      ：该 release 在 AOI 内出现频率最高的影像拍摄日期（来自元数据 SRC_DATE2 字段）。
                    </div>
                    <div>
                      <span className="font-medium text-foreground">数据源 / 分辨率</span>
                      ：主导日期对应栅格的来源（如 Vivid Advanced、Maxar）和空间分辨率（米/像素）。
                    </div>
                    <div>
                      <span className="font-medium text-foreground">release</span>
                      ：Wayback 发布日，可能与拍摄日期相差数月～数年（Esri 入库延迟）。
                    </div>
                    <div>
                      <span className="font-medium text-foreground">主导 %</span>
                      ：主导日期 footprint 面积 / 该 release 在 AOI 内全部 footprint 面积。值越接近 100% 表示 AOI 内基本是同一天的影像。
                    </div>
                    <div>
                      <span className="font-medium text-foreground">覆盖 %</span>
                      ：该 release 在 AOI 内 footprint 合计 / AOI 总面积。100% 表示该 release 完整覆盖你的范围。
                    </div>
                    <div>
                      <span className="font-medium text-foreground">共 N 个日期</span>
                      ：该 release 在 AOI 内包含多个不同拍摄日的影像（拼接图），可在下载后按需裁剪。
                    </div>
                    <div>
                      <span className="font-medium text-foreground">圆点颜色</span>
                      ：绿=Vivid 系列、蓝=Maxar 系列、灰=其他。
                    </div>
                    {scanMode === 'official' && (
                      <div className="rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-foreground">
                        当前为「极速（ESRI 官方版）」模式，仅探测 AOI 中心 1 个瓦片，
                        <span className="font-medium">主导 % 与覆盖 % 退化为二值（≈ 0% 或 ≈ 100%）</span>
                        ，对应官方「Only versions with local changes」逻辑。如需准确比例请改用 fast/fine 模式。
                      </div>
                    )}
                  </div>
                </details>

                <div className="space-y-1.5 rounded border bg-background/50 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Label className="w-20 text-xs">覆盖率 ≥</Label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={coverageThreshold}
                      onChange={(e) => setCoverageThreshold(Number(e.target.value))}
                      className="h-7 w-16 text-xs"
                    />
                    <span>%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="w-20 text-xs">主导日期 ≥</Label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={dominantThreshold}
                      onChange={(e) => setDominantThreshold(Number(e.target.value))}
                      className="h-7 w-16 text-xs"
                    />
                    <span>%</span>
                  </div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={onlyLatestPerYear}
                      onChange={(e) => setOnlyLatestPerYear(e.target.checked)}
                      className="size-3.5"
                    />
                    每年只保留最新 release
                  </label>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() =>
                      setIncSelected(new Set(filteredReleases.map((r) => r.release_id)))
                    }
                  >
                    全选
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setIncSelected(new Set())}
                  >
                    清空
                  </Button>
                  <span className="ml-auto text-muted-foreground">
                    {filteredReleases.length} 个 release · 已选 {incSelected.size}
                  </span>
                </div>

                <div className="max-h-64 space-y-0.5 overflow-y-auto rounded border bg-background/50 p-2 text-xs">
                  {filteredReleases.length === 0 ? (
                    <div className="py-3 text-center text-muted-foreground">无符合条件的 release</div>
                  ) : (
                    filteredReleases.map((r) => {
                      const cov = Math.round((r.coverage_ratio ?? 0) * 100)
                      const dom = Math.round((r.dominant_ratio ?? 0) * 100)
                      const dotColor = (r.source_name ?? '').includes('Vivid')
                        ? '#4caf50'
                        : (r.source_name ?? '').includes('Maxar')
                          ? '#2196f3'
                          : '#9e9e9e'
                      return (
                        <label key={r.release_id} className="flex cursor-pointer items-start gap-2">
                          <input
                            type="checkbox"
                            checked={incSelected.has(r.release_id)}
                            onChange={(e) => {
                              const next = new Set(incSelected)
                              if (e.target.checked) next.add(r.release_id)
                              else next.delete(r.release_id)
                              setIncSelected(next)
                            }}
                            className="mt-0.5 size-3.5"
                          />
                          <span
                            className="mt-1 inline-block size-2 shrink-0 rounded-full"
                            style={{ background: dotColor }}
                          />
                          <span className="flex-1">
                            <span className="font-medium">{r.dominant_capture_date}</span>
                            <span className="text-muted-foreground">
                              {' · '}
                              {r.source_name || '未知源'} ·{' '}
                              {r.resolution_m > 0 ? `${r.resolution_m.toFixed(2)}m` : '?'}
                            </span>
                            <div className="text-muted-foreground">
                              release {r.release_date} · 主导 {dom}%
                              {r.captures.length > 1 && ` · 共 ${r.captures.length} 个日期`}
                            </div>
                          </span>
                          <span className="shrink-0 text-muted-foreground">覆盖 {cov}%</span>
                        </label>
                      )
                    })
                  )}
                </div>

                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => incDownloadMutation.mutate()}
                  disabled={
                    incDownloadMutation.isPending || incSelected.size === 0 || !bounds
                  }
                >
                  {incDownloadMutation.isPending ? (
                    <Loader2 className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <Download className="mr-1 size-3.5" />
                  )}
                  下载选中的 release
                </Button>
              </>
            )}
          </TabsContent>
        </Tabs>
      </PanelSection>
    </div>
  )
}
