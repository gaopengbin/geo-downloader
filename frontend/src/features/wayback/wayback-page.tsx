import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Download, FolderOpen, History, Loader2, RefreshCw, Search, Square } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'

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
  GeoTiffSidecarToggle,
  SelectionCropToggle,
  TiffCompressionSelect,
  type TiffCompression,
} from '@/features/download/output-controls'
import { useSelectionStore } from '@/store/selection-store'
import { useAppStore } from '@/store/app-store'
import { useWaybackStore } from '@/store/wayback-store'
import {
  cancelWaybackScan,
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
  const { t, i18n } = useTranslation()
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
  const [generateSidecars, setGenerateSidecars] = useState<boolean>(false)
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
  const [hideUnchanged, setHideUnchanged] = useState<boolean>(false)
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
  const activeScanIdRef = useRef<string | null>(null)
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
    const list = versionsQuery.data?.versions
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
    () => versionsQuery.data?.versions ?? [],
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
  const outputPathPlaceholder = t('wayback.outputPlaceholder')

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
          ? t('wayback.directory.single')
          : wbMode === 'batch'
            ? t('wayback.directory.batch')
            : t('wayback.directory.incremental'),
    })
    if (picked) setCurrentOutputPath(picked as string)
    return picked as string | null
  }

  const probeMutation = useMutation({
    mutationFn: async () => {
      if (!versionId) throw new Error(t('wayback.errors.selectVersion'))
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
      toast.success(t('wayback.toast.maxZoom', { zoom: z }))
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t('wayback.toast.probeFailed', { message: msg }))
    },
  })

  // 自动估算：单版本模式下，参数变化后 400ms 防抖触发，结果显示在缩放下方
  useEffect(() => {
    if (wbMode !== 'single') return
    if (!bounds) {
      setEstimate(null)
      return
    }
    const timer = window.setTimeout(() => {
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
    return () => window.clearTimeout(timer)
  }, [wbMode, bounds, zoom, zMaxValue, zLevelsForApi, format, cropToShape, effectiveCropToShape, compression, buildPyramid])

  // ========== 单个下载 ==========
  const singleMutation = useMutation({
    mutationFn: async () => {
      if (!versionId || !selectedVersion) throw new Error(t('wayback.errors.selectVersion'))
      if (!bounds) throw new Error(t('wayback.errors.selectRegion'))

      const ext = extOf(format)
      let saveDirOrPath = singleSaveDir.trim()
      if (!saveDirOrPath) {
        const picked = await openDialog({
          directory: true,
          title: t('wayback.directory.single'),
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
        generate_sidecars: format === 'geotiff' && generateSidecars,
      }
      const finalTaskName = taskName.trim() || `Wayback ${selectedVersion.date} ${zLabel}`
      return createWaybackTask(request, versionId, selectedVersion.date, finalTaskName)
    },
    onSuccess: () => {
      toast.success(t('wayback.toast.taskCreated'))
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(t('wayback.toast.downloadFailed', { message: msg }))
    },
  })

  // ========== 批量下载 ==========
  const batchMutation = useMutation({
    mutationFn: async () => {
      if (!bounds) throw new Error(t('wayback.errors.selectRegion'))
      if (batchSelected.size === 0) throw new Error(t('wayback.errors.selectOneVersion'))
      let dir = batchSaveDir.trim()
      if (!dir) {
        const picked = await openDialog({
          directory: true,
          title: t('wayback.directory.batch'),
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
          generate_sidecars: format === 'geotiff' && generateSidecars,
        }
        try {
          const finalTaskName = taskName.trim()
            ? `${taskName.trim()} ${v.date} ${zLabel}`
            : `Wayback ${v.date} ${zLabel}`
          await createWaybackTask(request, v.id, v.date, finalTaskName)
          created += 1
        } catch (e) {
          console.error(t('wayback.logs.batchTaskFailed', { date: v.date }), e)
        }
      }
      return created
    },
    onSuccess: (n) => {
      toast.success(t('wayback.toast.batchCreated', { count: n }))
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(t('wayback.toast.batchFailed', { message: msg }))
    },
  })

  // ========== 增量扫描 ==========
  const scanMutation = useMutation({
    mutationFn: async (opts: { forceRefresh?: boolean } = {}) => {
      const forceRefresh = opts.forceRefresh ?? false
      if (!bounds) throw new Error(t('wayback.errors.selectRegion'))
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

      if (scanAbortRef.current) {
        if (res.kind === 'scanning') {
          await cancelWaybackScan(res.scan_id).catch(() => false)
        }
        throw new Error('__user_cancelled__')
      }

      if (res.kind === 'result') {
        return res
      }

      // 后台扫描中，轮询进度
      const scanId = res.scan_id
      activeScanIdRef.current = scanId
      while (!scanAbortRef.current) {
        await new Promise((r) => setTimeout(r, 1500))
        if (scanAbortRef.current) break
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
          throw new Error(t('wayback.errors.scanNoResult'))
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
      toast.success(t('wayback.toast.scanComplete', { count: res.releases.length }))
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(t('wayback.toast.scanFailed', { message: msg }))
      setScanProgress(null)
    },
    onSettled: () => {
      activeScanIdRef.current = null
      setScanProgress(null)
    },
  })

  const stopScan = () => {
    scanAbortRef.current = true
    const scanId = activeScanIdRef.current
    if (scanId) {
      void cancelWaybackScan(scanId).catch((error) => {
        console.warn(t('wayback.logs.stopScanFailed'), error)
      })
    }
  }

  useEffect(() => {
    return () => {
      scanAbortRef.current = true
      const scanId = activeScanIdRef.current
      if (scanId) void cancelWaybackScan(scanId).catch(() => undefined)
    }
  }, [])

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
    if (hideUnchanged) {
      items = items.filter((r, i, arr) => {
        const next = arr[i + 1]
        return !next || r.dominant_capture_date !== next.dominant_capture_date
      })
    }
    return items
  }, [scanReleases, coverageThreshold, dominantThreshold, onlyLatestPerYear, hideUnchanged])

  // 选中默认全选
  useEffect(() => {
    setIncSelected(new Set(filteredReleases.map((r) => r.release_id)))
  }, [filteredReleases])

  const incDownloadMutation = useMutation({
    mutationFn: async () => {
      if (!bounds) throw new Error(t('wayback.errors.selectRegion'))
      if (incSelected.size === 0) throw new Error(t('wayback.errors.selectOneRelease'))
      let dir = incrementalSaveDir.trim()
      if (!dir) {
        const picked = await openDialog({ directory: true, title: t('wayback.directory.generic') })
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
        generate_sidecars: format === 'geotiff' && generateSidecars,
        task_name_prefix: taskName.trim() || null,
        proxy,
      })
      return result.task_ids.length
    },
    onSuccess: (n) => {
      toast.success(t('wayback.toast.incrementalCreated', { count: n }))
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(t('wayback.toast.downloadFailed', { message: msg }))
    },
  })

  return (
    <div className="space-y-4">
      <RegionSelector />

      <PanelSection
        icon={History}
        title={t('wayback.panelTitle')}
        description={t('wayback.panelDescription')}
        dataTour="wayback-section"
        action={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            title={t('wayback.refreshVersions')}
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
            {t('wayback.imageryDate')}
          </Label>
          <Select value={versionId} onValueChange={setVersionId}>
            <SelectTrigger>
              <SelectValue placeholder={versionsQuery.isLoading ? t('common.loading') : t('wayback.selectDate')} />
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
            <Label className="text-xs">{t('wayback.zoom.title')}</Label>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                {t('wayback.zoom.selected', { count: sortedLevels.length })}
                {sortedLevels.length > 0 ? ` · ${zLabel}` : ''}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => probeMutation.mutate()}
                disabled={probeMutation.isPending}
                title={t('wayback.zoom.probeTitle')}
              >
                {probeMutation.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <>
                    <Search className="size-3" />
                    <span className="ml-1">{t('wayback.zoom.probe')}</span>
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
              {t('wayback.zoom.reset')}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('wayback.zoom.hint')}
          </p>
        </div>

        {/* 自动估算结果 */}
        {wbMode === 'single' && bounds && (
          <StatCard variant="compact">
            {estimating ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {t('wayback.estimate.estimating')}
              </span>
            ) : estimate ? (
              <>
                {t('wayback.estimate.expected')}{' '}
                <strong>{t('wayback.estimate.tiles', { count: estimate.tile_count.toLocaleString(i18n.resolvedLanguage) })}</strong>
                {' · '}{t('wayback.estimate.output')}{' '}
                <strong>
                  {formatBytes(
                    estimate.estimated_output_mb ?? estimate.raw_size_mb ?? estimate.estimated_size_mb,
                  )}
                </strong>
                {' · '}{t('wayback.estimate.traffic')}{' '}
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
              <span className="text-muted-foreground">{t('wayback.estimate.waiting')}</span>
            )}
          </StatCard>
        )}

        {/* 输出参数 */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('wayback.outputFormat')}</Label>
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
          <div className="space-y-2">
            <BuildPyramidToggle checked={buildPyramid} onChange={setBuildPyramid} />
            <GeoTiffSidecarToggle
              checked={generateSidecars}
              onChange={setGenerateSidecars}
            />
          </div>
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
            {t('wayback.taskName')}{' '}
            <span className="text-muted-foreground">({t('common.optional')})</span>
          </Label>
          <Input
            value={taskName}
            onChange={(e) => setTaskName(e.target.value)}
            placeholder={
              selectedVersion
                ? t('wayback.taskNameExample', { date: selectedVersion.date, zoom: zLabel })
                : t('wayback.taskNameAuto')
            }
            className="h-8 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t('wayback.saveDirectory')}</Label>
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
              title={t('wayback.directory.generic')}
              onClick={() => void pickOutputPath()}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {wbMode === 'single'
              ? t('wayback.directory.singleHint')
              : t('wayback.directory.multipleHint')}
          </p>
        </div>

        <Separator />

        <Tabs value={wbMode} onValueChange={(v) => setWbMode(v as WbMode)}>
          <TabsList className="grid h-8 w-full grid-cols-3" data-tour="wayback-mode-tabs">
            <TabsTrigger value="single" className="text-xs">{t('wayback.mode.single')}</TabsTrigger>
            <TabsTrigger value="batch" className="text-xs">{t('wayback.mode.batch')}</TabsTrigger>
            <TabsTrigger value="incremental" className="text-xs">{t('wayback.mode.incremental')}</TabsTrigger>
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
              {t('wayback.downloadImagery')}
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
                {t('wayback.selectAll')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setBatchSelected(new Set())}
              >
                {t('wayback.clear')}
              </Button>
              <span className="ml-auto text-muted-foreground">{t('wayback.selected', { count: batchSelected.size })}</span>
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
              {t('wayback.batchDownload')}
            </Button>
          </TabsContent>

          {/* 增量下载 */}
          <TabsContent value="incremental" className="mt-3 space-y-2">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs">
              <Label className="whitespace-nowrap text-xs">{t('wayback.scan.mode')}</Label>
              <Select value={scanMode} onValueChange={(v) => setScanMode(v as 'fast' | 'fine' | 'official')}>
                <SelectTrigger className="h-7 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="official">{t('wayback.scan.official')}</SelectItem>
                  <SelectItem value="fast">{t('wayback.scan.fast')}</SelectItem>
                  <SelectItem value="fine">{t('wayback.scan.fine')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant={scanMutation.isPending ? 'outline' : 'default'}
                className="h-7 min-w-0 text-xs"
                onClick={scanMutation.isPending ? stopScan : () => scanMutation.mutate({})}
                disabled={!scanMutation.isPending && !bounds}
              >
                {scanMutation.isPending ? (
                  <Square className="mr-1 size-3" />
                ) : (
                  <Search className="mr-1 size-3" />
                )}
                {scanMutation.isPending
                  ? t('wayback.scan.stop')
                  : scanReleases.length > 0
                    ? t('wayback.scan.rescan')
                    : t('wayback.scan.start')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 min-w-0 text-xs"
                onClick={() => scanMutation.mutate({ forceRefresh: true })}
                disabled={scanMutation.isPending || !bounds}
                title={t('wayback.scan.forceRefreshTitle')}
              >
                <RefreshCw className="mr-1 size-3" />
                {t('wayback.scan.forceRefresh')}
              </Button>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Label className="text-xs">{t('wayback.scan.dateRange')}</Label>
              <DatePicker
                value={releaseDateFrom}
                onChange={setReleaseDateFrom}
                placeholder={t('wayback.scan.startDate')}
                maxDate={releaseDateTo || undefined}
              />
              <span className="text-muted-foreground">~</span>
              <DatePicker
                value={releaseDateTo}
                onChange={setReleaseDateTo}
                placeholder={t('wayback.scan.endDate')}
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
                  {t('wayback.scan.footprints', { count: scanProgress.footprints })}
                </div>
              </div>
            )}

            {scanReleases.length > 0 && (
              <>
                <div className="rounded border bg-muted/20 p-2 text-xs">
                  {t('wayback.scan.summary', { scanned: scanReleasesScanned, found: scanReleases.length })}
                </div>

                <details className="rounded border bg-muted/10 px-2 py-1 text-xs">
                  <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                    {t('wayback.details.title')}
                  </summary>
                  <div className="mt-2 space-y-1.5 text-muted-foreground">
                    <div>
                      <span className="font-medium text-foreground">{t('wayback.details.dominantDate')}</span>
                      {': '}{t('wayback.details.dominantDateDescription')}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">{t('wayback.details.sourceResolution')}</span>
                      {': '}{t('wayback.details.sourceResolutionDescription')}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">{t('wayback.details.release')}</span>
                      {': '}{t('wayback.details.releaseDescription')}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">{t('wayback.details.dominantRatio')}</span>
                      {': '}{t('wayback.details.dominantRatioDescription')}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">{t('wayback.details.coverageRatio')}</span>
                      {': '}{t('wayback.details.coverageRatioDescription')}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">{t('wayback.details.dateCount')}</span>
                      {': '}{t('wayback.details.dateCountDescription')}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">{t('wayback.details.dotColor')}</span>
                      {': '}{t('wayback.details.dotColorDescription')}
                    </div>
                    {scanMode === 'official' && (
                      <div className="rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-foreground">
                        {t('wayback.details.officialWarning')}
                      </div>
                    )}
                  </div>
                </details>

                <div className="space-y-1.5 rounded border bg-background/50 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Label className="w-20 text-xs">{t('wayback.filters.coverage')}</Label>
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
                    <Label className="w-20 text-xs">{t('wayback.filters.dominantDate')}</Label>
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
                    {t('wayback.filters.latestPerYear')}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={hideUnchanged}
                      onChange={(e) => setHideUnchanged(e.target.checked)}
                      className="size-3.5"
                    />
                    {t('wayback.filters.hideUnchanged')}
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
                    {t('wayback.selectAll')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setIncSelected(new Set())}
                  >
                    {t('wayback.clear')}
                  </Button>
                  <span className="ml-auto text-muted-foreground">
                    {t('wayback.releases.summary', { count: filteredReleases.length, selected: incSelected.size })}
                  </span>
                </div>

                <div className="max-h-64 space-y-0.5 overflow-y-auto rounded border bg-background/50 p-2 text-xs">
                  {filteredReleases.length === 0 ? (
                    <div className="py-3 text-center text-muted-foreground">{t('wayback.releases.empty')}</div>
                  ) : (
                    filteredReleases.map((r, idx) => {
                      const cov = Math.round((r.coverage_ratio ?? 0) * 100)
                      const dom = Math.round((r.dominant_ratio ?? 0) * 100)
                      const nextRelease = filteredReleases[idx + 1]
                      const isUnchanged = nextRelease && r.dominant_capture_date === nextRelease.dominant_capture_date
                      const dotColor = (r.source_name ?? '').includes('Vivid')
                        ? '#4caf50'
                        : (r.source_name ?? '').includes('Maxar')
                          ? '#2196f3'
                          : '#9e9e9e'
                      return (
                        <label key={r.release_id} className={`flex cursor-pointer items-start gap-2${isUnchanged ? ' opacity-45' : ''}`}>
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
                              {r.source_name || t('wayback.releases.unknownSource')} ·{' '}
                              {r.resolution_m > 0 ? `${r.resolution_m.toFixed(2)}m` : '?'}
                            </span>
                            <div className="text-muted-foreground">
                              {t('wayback.releases.metadata', { date: r.release_date, ratio: dom })}
                              {r.captures.length > 1 && t('wayback.releases.dateCount', { count: r.captures.length })}
                            </div>
                          </span>
                          <span className="shrink-0 text-muted-foreground">
                            {isUnchanged ? t('wayback.releases.unchanged') : t('wayback.releases.coverage', { ratio: cov })}
                          </span>
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
                  {t('wayback.releases.download')}
                </Button>
              </>
            )}
          </TabsContent>
        </Tabs>
      </PanelSection>
    </div>
  )
}
