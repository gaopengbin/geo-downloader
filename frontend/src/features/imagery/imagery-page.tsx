import { useEffect, useMemo, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, ExternalLink, FolderOpen, Info, Loader2, Layers, SlidersHorizontal } from 'lucide-react'
import { ask as askDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
import { toast } from 'sonner'
import { z } from 'zod'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
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

import { createDownloadTask, estimateDownload, probeTile } from '@/features/download/download-api'
import { buildSelectionCropPolygon } from '@/features/download/crop-utils'
import {
  BuildPyramidToggle,
  GeoTiffSidecarToggle,
  SelectionCropToggle,
  TiffCompressionSelect,
} from '@/features/download/output-controls'
import { RegionSelector } from '@/features/region/region-selector'
import { getSettings } from '@/features/settings/settings-api'
import { getTileSourcesMerged } from '@/features/sources/sources-api'
import {
  focusImagerySourcePicker,
  requestOsmDownloadApproval,
} from '@/features/sources/osm-download-policy'
import { isMvtUrl } from '@/features/mvt/is-mvt-url'
import { useSelectionStore, type MapBounds } from '@/store/selection-store'
import { useMultiFeatureSubmit } from '@/features/region/use-multi-feature-submit'
import { DispatchModeRadio } from '@/features/region/dispatch-mode-radio'
import { useAppStore, type AppMode } from '@/store/app-store'
import { useImageryParamsStore } from '@/store/imagery-params-store'
import type { DownloadEstimate, DownloadRequest, OutputFormat } from '@/types/api'
import { StatCard } from '@/components/layout/stat-card'
import { PanelSection } from '@/components/layout/panel-section'

const FORMAT_OPTIONS = [
  { value: 'geotiff', labelKey: 'download.formats.geotiff' },
  { value: 'png', labelKey: 'download.formats.png' },
  { value: 'jpeg', labelKey: 'download.formats.jpeg' },
  { value: 'tiles', labelKey: 'download.formats.tiles' },
  { value: 'mbtiles', labelKey: 'download.formats.mbtiles' },
  { value: 'gpkg', labelKey: 'download.formats.gpkg' },
] as const

const MVT_FORMAT_OPTIONS = [
  { value: 'pbf', labelKey: 'download.formats.pbf' },
  { value: 'mbtiles', labelKey: 'download.formats.mvtMbtiles' },
] as const

function zoomLevelKey(z: number): string {
  if (z <= 3) return 'download.zoom.levels.global'
  if (z <= 5) return 'download.zoom.levels.continent'
  if (z <= 7) return 'download.zoom.levels.country'
  if (z <= 9) return 'download.zoom.levels.province'
  if (z <= 11) return 'download.zoom.levels.city'
  if (z <= 13) return 'download.zoom.levels.district'
  if (z <= 15) return 'download.zoom.levels.street'
  if (z <= 17) return 'download.zoom.levels.building'
  if (z <= 19) return 'download.zoom.levels.detail'
  return 'download.zoom.levels.ultra'
}

// GCJ-02 偏移图源（中国区域）
const GCJ02_SOURCES = new Set(['google_map', 'gaode_map', 'gaode_satellite'])

// DEM 源识别，与后端 dem::is_dem_source 保持一致
function isDemSource(key: string): boolean {
  return key === 'dem_terrarium'
}

// DEM 数据集元信息：原始分辨率 / 覆盖范围 / 编码格式。仅做 UI 提示。
const DEM_META_SOURCES = new Set(['dem_terrarium'])

// 给定 zoom 估算 Web Mercator 在赤道处的像素地面分辨率（米/像素）
function metersPerPixelAtEquator(z: number): number {
  return 156543.03392 / 2 ** z
}

function formatMeters(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`
  if (m >= 10) return `${m.toFixed(0)} m`
  if (m >= 1) return `${m.toFixed(1)} m`
  return `${(m * 100).toFixed(0)} cm`
}

// 近似计算选区面积（km²）
function estimateAreaKm2(b: MapBounds): number {
  if (!b) return 0
  const dLat = Math.abs(b.north - b.south)
  const dLng = Math.abs(b.east - b.west)
  const meanLat = (b.north + b.south) / 2
  // 1° lat ≈ 111.32 km, 1° lng ≈ 111.32 * cos(lat) km
  const km = dLat * 111.32 * (dLng * 111.32 * Math.cos((meanLat * Math.PI) / 180))
  return km
}

const createDownloadSchema = (t: TFunction) => z.object({
  source: z.string().min(1, t('download.validation.source')),
  zoom_levels: z.array(z.number().int().min(1).max(22)).min(1, t('download.validation.zoom')),
  format: z.enum(['geotiff', 'png', 'jpeg', 'tiles', 'mbtiles', 'gpkg', 'pbf']),
  compression: z.enum(['none', 'lzw', 'deflate']),
  build_pyramid: z.boolean(),
  generate_sidecars: z.boolean(),
  overlay_sources: z.array(z.string()),
  concurrency: z.number().int().min(1).max(100),
  save_path: z.string().min(1, t('download.validation.savePath')),
  task_name: z.string().optional(),
})

type DownloadFormValues = z.infer<ReturnType<typeof createDownloadSchema>>

const DEFAULT_VALUES: DownloadFormValues = {
  source: '',
  zoom_levels: [15],
  format: 'geotiff',
  compression: 'lzw',
  build_pyramid: false,
  generate_sidecars: false,
  overlay_sources: [],
  concurrency: 30,
  save_path: '',
  task_name: '',
}

function formatBytes(mb?: number | null): string {
  if (mb == null || !Number.isFinite(mb)) return '-'
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(2)} MB`
}

const FORMAT_EXT: Record<DownloadFormValues['format'], string> = {
  geotiff: 'tif',
  png: 'png',
  jpeg: 'jpg',
  tiles: '',
  mbtiles: 'mbtiles',
  gpkg: 'gpkg',
  pbf: '',
}

// 在文件名扩展名前、或者目录名末尾追加时间戳防重名覆盖
function tsStamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function appendTimestamp(path: string, format: DownloadFormValues['format']): string {
  if (!path) return path
  const ts = tsStamp()
  if (format === 'tiles' || format === 'pbf') {
    // 目录类输出：在用户所选目录内部新建带时间戳的子目录，
    // 而不是在同级新建 <chosen>_<ts>，避免污染父目录。
    const sep = path.includes('\\') ? '\\' : '/'
    const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path
    const lastSep = trimmed.lastIndexOf(sep)
    const baseName = lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed
    const childName = baseName ? `${baseName}_${ts}` : ts
    return `${trimmed}${sep}${childName}`
  }
  const sep = path.includes('\\') ? '\\' : '/'
  const lastSep = path.lastIndexOf(sep)
  const dotIdx = path.lastIndexOf('.')
  if (dotIdx > lastSep && dotIdx !== -1) {
    return `${path.slice(0, dotIdx)}_${ts}${path.slice(dotIdx)}`
  }
  return `${path}_${ts}`
}

function sanitizeFileBase(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'download'
}

// 当用户选择的是目录（多级别 / 多要素拆分），后端仍要求 save_path 为文件路径，
// 此处自动拼接默认文件名。已经是文件路径则原样返回。
function resolveSavePath(
  input: string,
  format: DownloadFormValues['format'],
  defaultBaseName = 'download',
): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return trimmed
  if (format === 'tiles' || format === 'pbf') return trimmed
  const ext = FORMAT_EXT[format] || 'tif'
  const lower = trimmed.toLowerCase()
  // 已含期望扩展名 → 视为文件
  if (ext && lower.endsWith(`.${ext}`)) return trimmed
  // 视为目录，拼接默认文件名
  const sep = trimmed.includes('\\') ? '\\' : '/'
  const base = `${sanitizeFileBase(defaultBaseName)}.${ext}`
  return trimmed.endsWith(sep) ? `${trimmed}${base}` : `${trimmed}${sep}${base}`
}

function BoundsInputs({ showError = true }: { showError?: boolean } = {}) {
  const { t } = useTranslation()
  const bounds = useSelectionStore((s) => s.bounds)
  const polygon = useSelectionStore((s) => s.polygon)
  const setBoundsFromInputs = useSelectionStore((s) => s.setBoundsFromInputs)

  // 显示保留 4 位小数；本地输入文本与外部 bounds 解耦，避免破坏正在输入的内容
  const fmt = (n: number | undefined | null) =>
    n == null || !Number.isFinite(n) ? '' : Number(n.toFixed(4)).toString()
  const [text, setText] = useState({
    north: fmt(bounds?.north),
    south: fmt(bounds?.south),
    east: fmt(bounds?.east),
    west: fmt(bounds?.west),
  })
  // 当外部 bounds 变化（地图绘制/上传边界/行政区）时同步显示
  useEffect(() => {
    setText({
      north: fmt(bounds?.north),
      south: fmt(bounds?.south),
      east: fmt(bounds?.east),
      west: fmt(bounds?.west),
    })
  }, [bounds?.north, bounds?.south, bounds?.east, bounds?.west])

  const update = (key: keyof MapBounds, raw: string) => {
    setText((t) => ({ ...t, [key]: raw }))
    const v = Number(raw)
    if (!Number.isFinite(v)) return
    const base: MapBounds = bounds ?? { north: 0, south: 0, east: 0, west: 0 }
    setBoundsFromInputs({ ...base, [key]: v })
  }

  const valid = bounds && bounds.north > bounds.south && bounds.east > bounds.west

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('download.bounds.title')}
        </h3>
        {polygon && (
          <Badge variant="outline" className="text-xs">
            {t('download.bounds.polygonPoints', { count: polygon[0]?.length ?? 0 })}
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="b-north" className="text-xs">{t('download.bounds.north')}</Label>
          <Input
            id="b-north"
            type="number"
            step="0.0001"
            value={text.north}
            onChange={(e) => update('north', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="b-south" className="text-xs">{t('download.bounds.south')}</Label>
          <Input
            id="b-south"
            type="number"
            step="0.0001"
            value={text.south}
            onChange={(e) => update('south', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="b-west" className="text-xs">{t('download.bounds.west')}</Label>
          <Input
            id="b-west"
            type="number"
            step="0.0001"
            value={text.west}
            onChange={(e) => update('west', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="b-east" className="text-xs">{t('download.bounds.east')}</Label>
          <Input
            id="b-east"
            type="number"
            step="0.0001"
            value={text.east}
            onChange={(e) => update('east', e.target.value)}
          />
        </div>
      </div>
      {showError && bounds && !valid && (
        <p className="text-xs text-destructive">{t('download.bounds.invalid')}</p>
      )}
    </section>
  )
}

export function ImageryPage({ mode = 'imagery' }: { mode?: 'imagery' | 'dem' | 'mvt' } = {}) {
  const { t, i18n } = useTranslation()
  const isDemMode = mode === 'dem'
  const isMvtMode = mode === 'mvt'
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const tiandituToken = settingsQuery.data?.tianditu_token ?? null
  const sourcesQuery = useQuery({
    queryKey: ['tile-sources-merged', tiandituToken],
    queryFn: () => getTileSourcesMerged(tiandituToken),
  })

  const sourceList = useMemo(() => {
    const all = Object.entries(sourcesQuery.data ?? {})
      .map(([k, v]) => ({ key: k, ...v }))
      .filter((s) => {
        const id = (s.id as string) ?? s.key
        if (isMvtMode) return isMvtUrl((s as { url?: string }).url)
        if (isDemMode) return isDemSource(id)
        return !isDemSource(id) && !isMvtUrl((s as { url?: string }).url)
      })
    return all.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [sourcesQuery.data, isDemMode, isMvtMode])

  // 同步从 store 读取持久化值作为表单初值，避免组件每次重挂时表单
  // 短暂闪现 DEFAULT_VALUES（mode 切换时 ImageryPage 销毁重挂特别明显）。
  // 注意：不依赖 settings/sources 异步数据，仅用持久化值；后续 init effect
  // 仍会在数据到达后做 fallback 与校验。
  const initialFormValues = useMemo<DownloadFormValues>(() => {
    const persisted = useImageryParamsStore.getState()
    const remembered = useAppStore.getState().selectedSourceByMode[mode] ?? ''
    const fmt: DownloadFormValues['format'] = isDemMode
      ? 'geotiff'
      : isMvtMode
        ? 'pbf'
        : (persisted.format as DownloadFormValues['format']) ?? 'geotiff'
    const rememberedZooms = persisted.zoomLevelsByMode?.[mode]
    const rememberedOverlays = persisted.overlaySourcesByMode?.[mode]
    return {
      ...DEFAULT_VALUES,
      source: remembered,
      format: fmt,
      compression: persisted.compression,
      build_pyramid: persisted.buildPyramid,
      generate_sidecars: persisted.generateSidecars,
      concurrency:
        typeof persisted.concurrency === 'number'
          ? Math.min(100, Math.max(1, persisted.concurrency))
          : DEFAULT_VALUES.concurrency,
      zoom_levels:
        rememberedZooms && rememberedZooms.length > 0
          ? rememberedZooms
          : isMvtMode
            ? [10, 11, 12, 13, 14]
            : DEFAULT_VALUES.zoom_levels,
      overlay_sources:
        rememberedOverlays && !isMvtMode && !isDemMode ? rememberedOverlays : [],
      save_path: persisted.savePathByMode?.[mode] ?? '',
    }
    // mode 是 prop，组件 mount 时确定，不会在生命周期中变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const downloadSchema = useMemo(() => createDownloadSchema(t), [t])

  const form = useForm<DownloadFormValues>({
    resolver: zodResolver(downloadSchema),
    defaultValues: initialFormValues,
    mode: 'onSubmit',
    reValidateMode: 'onSubmit',
  })
  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { errors, submitCount },
  } = form

  const [initedForMode, setInitedForMode] = useState<AppMode | null>(null)
  const [cropToShape, setCropToShape] = useState(
    () => useImageryParamsStore.getState().cropToShape,
  )
  useEffect(() => {
    if (initedForMode === mode) return
    if (!settingsQuery.data || !sourcesQuery.data || sourceList.length === 0) return
    const s = settingsQuery.data
    const persistedParams = useImageryParamsStore.getState()
    // 优先从 store 中取本 mode 上次选中的图源（切换 tab 后回来要还原）
    const remembered = useAppStore.getState().selectedSourceByMode[mode] ?? null
    const isValidRemembered =
      remembered != null &&
      sourcesQuery.data[remembered] != null &&
      (isDemMode ? isDemSource(remembered) : !isDemSource(remembered))

    let firstSourceId: string
    if (isValidRemembered) {
      firstSourceId = remembered as string
    } else if (isDemMode) {
      firstSourceId =
        sourceList.find((x) => ((x.id as string) ?? x.key) === 'dem_terrarium')?.id ??
        sourceList[0]?.id ??
        sourceList[0]?.key ??
        ''
    } else if (isMvtMode) {
      firstSourceId = sourceList[0]?.id ?? sourceList[0]?.key ?? ''
    } else {
      firstSourceId =
        (s.default_source && sourcesQuery.data[s.default_source] && !isDemSource(s.default_source)
          ? s.default_source
          : null) ??
        sourceList[0]?.id ??
        sourceList[0]?.key ??
        ''
    }
    setValue('source', firstSourceId ?? '')
    // 同步写入 store，避免依赖下方 useEffect[source, mode] 在 StrictMode 下双挂载
    // 时可能被 fallback 到默认值覆盖。
    if (firstSourceId) {
      useAppStore.getState().setSelectedSourceForMode(mode, firstSourceId)
    }
    if (typeof persistedParams.concurrency === 'number') {
      setValue('concurrency', Math.min(100, Math.max(1, persistedParams.concurrency)))
    } else if (typeof s.default_concurrency === 'number') {
      setValue('concurrency', s.default_concurrency)
    }
    // 仅在未持久化过本 mode 的 zoom_levels 时才用 settings 默认值，
    // 避免覆盖刚从 store 恢复的值。
    const hasRememberedZooms = (persistedParams.zoomLevelsByMode?.[mode]?.length ?? 0) > 0
    if (!hasRememberedZooms && typeof s.default_zoom === 'number') {
      setValue('zoom_levels', [s.default_zoom])
    }
    setValue('compression', persistedParams.compression)
    setValue('build_pyramid', persistedParams.buildPyramid)
    setValue('generate_sidecars', persistedParams.generateSidecars)
    setCropToShape(persistedParams.cropToShape)
    // save_path 仅在 useForm defaultValues 从 store 恢复一次，这里不覆盖。
    if (isDemMode) {
      setValue('format', 'geotiff')
    } else if (isMvtMode) {
      if (!hasRememberedZooms) setValue('zoom_levels', [10, 11, 12, 13, 14])
      setValue('format', 'pbf')
    } else {
      const fmt = (persistedParams.format ?? s.default_format ?? 'geotiff') as OutputFormat
      if (['geotiff', 'png', 'jpeg', 'tiles', 'mbtiles', 'gpkg'].includes(fmt as string)) {
        setValue('format', fmt as DownloadFormValues['format'])
      }
    }
    setInitedForMode(mode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, settingsQuery.data, sourcesQuery.data, sourceList])

  const source = useWatch({ control, name: 'source' })
  const format = useWatch({ control, name: 'format' })
  const zoomLevels = useWatch({ control, name: 'zoom_levels' }) ?? []
  const sortedLevels = useMemo(() => [...zoomLevels].sort((a, b) => a - b), [zoomLevels])
  const zoom = sortedLevels[0] ?? 15
  const zoomMax = sortedLevels[sortedLevels.length - 1] ?? zoom
  const compression = useWatch({ control, name: 'compression' })
  const buildPyramid = useWatch({ control, name: 'build_pyramid' })
  const generateSidecars = useWatch({ control, name: 'generate_sidecars' })
  const overlaySources = (useWatch({ control, name: 'overlay_sources' }) ?? []) as string[]
  const concurrency = useWatch({ control, name: 'concurrency' })

  const [estimate, setEstimate] = useState<DownloadEstimate | null>(null)
  const qc = useQueryClient()
  const dispatchCtx = useMultiFeatureSubmit()
  const supportsSelectionCrop = (format === 'geotiff' || format === 'png') && !isMvtMode
  const effectiveCropToShape = cropToShape && supportsSelectionCrop

  const submitMutation = useMutation({
    mutationFn: async (values: DownloadFormValues) => {
      const { bounds, polygon } = useSelectionStore.getState()
      if (!bounds) throw new Error(t('download.validation.bounds'))
      const sourceMeta = sourcesQuery.data?.[values.source]
      const policyDecision = await requestOsmDownloadApproval(
        values.source,
        sourceMeta?.url,
      )
      if (policyDecision === 'switch') {
        focusImagerySourcePicker()
        throw new Error('__user_cancelled__')
      }
      if (policyDecision === 'cancel') throw new Error('__user_cancelled__')
      const levels = [...values.zoom_levels].sort((a, b) => a - b)
      const zMin = levels[0]
      const zMax = levels[levels.length - 1]
      // 探测选区中心瓦片是否有数据（按最高级别探测）
      const probeZoom = zMax
      const centerLat = (bounds.north + bounds.south) / 2
      const centerLng = (bounds.east + bounds.west) / 2
      try {
        const probe = await probeTile(
          values.source,
          probeZoom,
          centerLat,
          centerLng,
          settingsQuery.data?.tianditu_token ?? null,
          settingsQuery.data?.proxy_enabled && settingsQuery.data.proxy_url
            ? settingsQuery.data.proxy_url
            : null,
        )
        if (!probe.has_data) {
          const maxZoom = sourceMeta?.max_zoom ?? '?'
          const action = settingsQuery.data?.empty_tile_probe_action ?? 'continue'
          const requestFailed =
            typeof probe.status_code === 'number' &&
            (probe.status_code < 200 || probe.status_code >= 300)
          const warning = requestFailed
            ? t('download.probe.requestFailed', {
                message: probe.message ?? `HTTP ${probe.status_code}`,
              })
            : t('download.probe.empty', {
                zoom: probeZoom,
                message: probe.message ?? t('download.probe.emptyFallback'),
              })
          const guidance = requestFailed
            ? t('download.probe.requestGuidance')
            : t('download.probe.coverageGuidance', { maxZoom })
          if (action === 'ask') {
            const proceed = await askDialog(
              t('download.probe.continueQuestion', { warning, guidance }),
              { title: t('download.probe.title'), kind: 'warning' },
            )
            if (!proceed) throw new Error('__user_cancelled__')
          } else if (action === 'cancel') {
            toast.warning(t('download.probe.stopped', { warning }))
            throw new Error('__user_cancelled__')
          } else {
            toast.warning(t('download.probe.continued', { warning }))
          }
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        if (m === '__user_cancelled__') throw e
        // 探测本身失败不阻断下载，仅提示
        toast.warning(t('download.probe.failed', { message: m }))
      }

      const cropPolygon = buildSelectionCropPolygon(bounds, polygon, effectiveCropToShape)
      const levelLabel = levels.length === 1
        ? `z${zMin}`
        : (levels.length === zMax - zMin + 1 ? `z${zMin}~z${zMax}` : `z${levels.join(',')}`)
      // SQLite 系格式（mbtiles/gpkg）在 Windows 中文路径下，QGIS / GDAL 会因
      // SQLite 打开失败报"无效图层"。所以默认文件名走 ASCII-safe 的图源 id。
      // 其他栅格格式保留中文人类可读名。用户手填的 task_name 始终透传。
      const isSqlitePack = values.format === 'mbtiles' || values.format === 'gpkg'
      const fallbackName = isSqlitePack
        ? `${values.source}_${levelLabel}`
        : `${sourceMeta?.name ?? values.source} ${levelLabel}`
      const finalName = (values.task_name && values.task_name.trim()) || fallbackName
      const resolvedSavePath = resolveSavePath(
        values.save_path,
        values.format,
        finalName,
      )
      const request: DownloadRequest = {
        bounds,
        zoom: zMin,
        zoom_max: zMax > zMin ? zMax : null,
        zoom_levels: levels,
        source: values.source,
        format: values.format,
        save_path: appendTimestamp(resolvedSavePath, values.format),
        concurrency: values.concurrency,
        tianditu_token: settingsQuery.data?.tianditu_token ?? null,
        proxy:
          settingsQuery.data?.proxy_enabled && settingsQuery.data.proxy_url
            ? settingsQuery.data.proxy_url
            : null,
        crop_to_shape: cropPolygon != null,
        polygon: cropPolygon,
        compression: values.format === 'geotiff' ? values.compression : 'none',
        build_pyramid: values.format === 'geotiff' && values.build_pyramid,
        generate_sidecars: values.format === 'geotiff' && values.generate_sidecars,
        overlay_sources:
          (values.overlay_sources && values.overlay_sources.length > 0 && !isMvtMode && !isDemMode && values.format !== 'pbf')
            ? values.overlay_sources.filter((id) => id && id !== values.source)
            : null,
      }
      return createDownloadTask(request, finalName, sourceMeta?.name ?? values.source)
    },
    onSuccess: (res) => {
      toast.success(t('download.toast.created', {
        id: res.task_id.slice(0, 8),
        count: res.tile_count.toLocaleString(i18n.resolvedLanguage),
      }))
      // 自动跳转到下载中心，刷新任务列表
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
      qc.invalidateQueries({ queryKey: ['resumable-tasks'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(t('download.toast.createError', { message: msg }))
    },
  })

  const onSubmit = handleSubmit(async (v) => {
    try {
      await dispatchCtx.runSubmit(async (perFeatureName) => {
        if (perFeatureName == null) {
          await submitMutation.mutateAsync(v)
          return
        }
        // 拆分模式：把 save_path 视作目录，为每个要素拼接独立文件名
        const safe = perFeatureName.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'feature'
        const ext = FORMAT_EXT[v.format] || 'tif'
        const dir = (v.save_path ?? '').trim()
        let saveOverride = dir
        const isFolderOut = v.format === 'tiles' || v.format === 'pbf'
        if (dir && !isFolderOut) {
          const sep = dir.includes('\\') ? '\\' : '/'
          const fname = `${safe}.${ext}`
          saveOverride = dir.endsWith(sep) ? `${dir}${fname}` : `${dir}${sep}${fname}`
        } else if (dir && isFolderOut) {
          const sep = dir.includes('\\') ? '\\' : '/'
          saveOverride = dir.endsWith(sep) ? `${dir}${safe}` : `${dir}${sep}${safe}`
        }
        const overridden = {
          ...v,
          save_path: saveOverride,
          task_name: `${(v.task_name && v.task_name.trim()) || ''} - ${perFeatureName}`.replace(/^ - /, ''),
        }
        await submitMutation.mutateAsync(overridden)
      })
    } catch {
      /* errors are surfaced by submitMutation.onError */
    }
  })

  const pickSavePath = async () => {
    try {
      const current = (form.getValues('save_path') ?? '').trim()
      const chosen = await openDialog({
        directory: true,
        multiple: false,
        title: t('download.output.chooseDirectory'),
        defaultPath: current || undefined,
      })
      if (chosen) {
        setValue('save_path', chosen as string, { shouldValidate: true })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('download.toast.pathError', { message: msg }))
    }
  }

  const sourcesLoading = sourcesQuery.isLoading || settingsQuery.isLoading
  const polygon = useSelectionStore((s) => s.polygon)
  const bounds = useSelectionStore((s) => s.bounds)

  const showGcj02 = !isDemMode && GCJ02_SOURCES.has(source)
  const areaKm2 = bounds ? estimateAreaKm2(bounds) : 0

  // 自动估算：bounds / zoom / format 等参数变化后 400ms 防抖触发
  useEffect(() => {
    if (!bounds) {
      setEstimate(null)
      return
    }
    const handle = window.setTimeout(() => {
      const zMax = zoomMax > zoom ? zoomMax : null
      estimateDownload(bounds, zoom, format, effectiveCropToShape, zMax, sortedLevels, {
        sourceId: source,
        buildPyramid: format === 'geotiff' ? buildPyramid : false,
        compression: format === 'geotiff' ? compression : 'none',
      })
        .then((data) => setEstimate(data))
        .catch(() => {
          /* 自动估算失败不打扰用户 */
        })
    }, 400)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, zoom, zoomMax, sortedLevels, format, cropToShape, polygon, source, compression, buildPyramid])

  // 注意：此处不再用 useEffect[source, mode] 写 store，因为 useWatch 是异步更新
  // + StrictMode 双挂载，可能出现“上一个 mode 的 source 被临时写入新 mode”的错误。
  // 改为在 init effect 末尾与 Select onValueChange 处同步写 store。

  // 同步影像下载参数到全局 store，供批量下载对话框读取
  const sourceMetaName =
    sourceList.find((s) => s.key === source)?.name ?? source
  const sourceMetaUrl =
    sourceList.find((s) => s.key === source)?.url ?? ''
  useEffect(() => {
    if (isDemMode || isMvtMode) return
    useImageryParamsStore.getState().set({
      source,
      sourceName: sourceMetaName,
      sourceUrl: sourceMetaUrl,
      zoom,
      zoomMax: zoomMax > zoom ? zoomMax : null,
      format: format as OutputFormat,
      compression: compression as 'none' | 'lzw' | 'deflate',
      buildPyramid: !!buildPyramid,
      generateSidecars: !!generateSidecars,
      cropToShape: effectiveCropToShape,
      concurrency,
    })
  }, [
    isDemMode,
    isMvtMode,
    source,
    sourceMetaName,
    sourceMetaUrl,
    zoom,
    zoomMax,
    format,
    compression,
    buildPyramid,
    generateSidecars,
    effectiveCropToShape,
    concurrency,
  ])

  // 按 mode 持久化 zoom_levels / overlay_sources，供下次启动恢复。
  useEffect(() => {
    if (zoomLevels.length === 0) return
    useImageryParamsStore.getState().setZoomLevelsForMode(mode, zoomLevels)
  }, [mode, zoomLevels])
  useEffect(() => {
    if (isDemMode || isMvtMode) return
    useImageryParamsStore.getState().setOverlaySourcesForMode(mode, overlaySources)
  }, [mode, isDemMode, isMvtMode, overlaySources])
  // 保存目录按 mode 持久化（submit 时会自动 appendTimestamp，不会覆盖以前的下载）。
  const savePath = useWatch({ control, name: 'save_path' }) ?? ''
  useEffect(() => {
    useImageryParamsStore.getState().setSavePathForMode(mode, savePath)
  }, [mode, savePath])

  return (
    <div className="space-y-3">
      <RegionSelector
        extras={
          <div className="space-y-3 border-t border-border/60 pt-3">
            <BoundsInputs showError={submitCount > 0} />

            {bounds && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Info className="size-3.5" /> {t('download.area')}
                </span>
                <span className="font-mono">
                  <span className="font-semibold text-foreground">{areaKm2.toFixed(2)}</span>
                  <span className="ml-0.5 text-muted-foreground">km²</span>
                  {polygon && polygon.length > 0 && (
                    <span className="ml-2 text-muted-foreground">
                      {t('download.vertices', { count: polygon[0]?.length ?? 0 })}
                    </span>
                  )}
                </span>
              </div>
            )}

            {showGcj02 && (
              <div className="flex gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>{t('download.gcjWarning')}</span>
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
          </div>
        }
      />

      <form className="space-y-3">
        <PanelSection
          icon={Layers}
          title={t('download.sections.source.title')}
          description={t('download.sections.source.description')}
          dataTour="imagery-source-section"
        >
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              {t('download.source.label')}
            </Label>
          <Select
            value={source}
            onValueChange={(v) => {
              setValue('source', v, { shouldValidate: true })
              if (v) useAppStore.getState().setSelectedSourceForMode(mode, v)
            }}
            disabled={sourcesLoading}
          >
            <SelectTrigger data-agent-target="imagery-source-select">
              <SelectValue
                placeholder={sourcesLoading ? t('download.source.loading') : t('download.source.choose')}
              />
            </SelectTrigger>
            <SelectContent>
              {sourceList.map((s) => {
                const id = s.id ?? s.key ?? ''
                return (
                  <SelectItem key={id} value={id}>
                    {t(`download.source.names.${id}`, { defaultValue: s.name })}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          {errors.source && <p className="text-xs text-destructive">{errors.source.message}</p>}
        </div>

        {isMvtMode && (
          <p className="text-xs text-muted-foreground">
            {t('download.source.mvtHint')}
          </p>
        )}

        {source.startsWith('tianditu_') && !settingsQuery.data?.tianditu_token?.trim() && (
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs leading-5 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {t('download.source.tiandituPublicKeyNotice')}{' '}
              <a
                href="https://cloudcenter.tianditu.gov.cn/center/development/myApp"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
              >
                {t('download.source.tiandituApply')}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            </span>
          </div>
        )}

        {isDemMode && DEM_META_SOURCES.has(source) && (
          <div className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground space-y-0.5">
            <div>
              <span className="text-foreground font-medium">{t('download.dem.nativeResolution')}</span>
              : {t('download.dem.nativeResolutionValue')}
            </div>
            <div>
              <span className="text-foreground font-medium">{t('download.dem.coverage')}</span>
              : {t('download.dem.coverageValue')}
            </div>
            <div>
              <span className="text-foreground font-medium">{t('download.dem.encoding')}</span>
              : {t('download.dem.encodingValue')}
            </div>
            {sortedLevels.length > 0 && (
              <div>
                <span className="text-foreground font-medium">{t('download.dem.sampling')}</span>
                : {sortedLevels.length === 1
                  ? `z${sortedLevels[0]} ≈ ${formatMeters(metersPerPixelAtEquator(sortedLevels[0]))}/px (${t('download.dem.equator')})`
                  : `z${sortedLevels[0]}~z${sortedLevels[sortedLevels.length - 1]} ≈ ${formatMeters(metersPerPixelAtEquator(sortedLevels[sortedLevels.length - 1]))} ~ ${formatMeters(metersPerPixelAtEquator(sortedLevels[0]))}/px (${t('download.dem.equator')})`}
              </div>
            )}
            <div className="text-muted-foreground/70">
              {t('download.dem.hint')}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">{t('download.zoom.title')}</Label>
            <Badge variant="secondary" className="text-xs">
              {t('download.zoom.selected', { count: sortedLevels.length })}
              {sortedLevels.length > 0
                ? ` · ${sortedLevels.length === 1
                    ? `z${sortedLevels[0]} (${t(zoomLevelKey(sortedLevels[0]))})`
                    : `z${sortedLevels[0]}~z${sortedLevels[sortedLevels.length - 1]}`}`
                : ''}
            </Badge>
          </div>
          <Controller
            control={control}
            name="zoom_levels"
            render={({ field }) => {
              const set = new Set(field.value ?? [])
              const toggle = (z: number) => {
                const next = new Set(set)
                if (next.has(z)) next.delete(z)
                else next.add(z)
                field.onChange(Array.from(next).sort((a, b) => a - b))
              }
              const selectRange = (a: number, b: number) => {
                const arr: number[] = []
                for (let z = a; z <= b; z++) arr.push(z)
                field.onChange(arr)
              }
              const clear = () => field.onChange([])
              return (
                <div className="space-y-2">
                  <div className="grid grid-cols-11 gap-1">
                    {Array.from({ length: 22 }, (_, i) => i + 1).map((z) => {
                      const checked = set.has(z)
                      return (
                        <button
                          key={z}
                          type="button"
                          onClick={() => toggle(z)}
                          className={`h-7 rounded border text-xs transition ${
                            checked
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-background text-foreground hover:bg-muted'
                          }`}
                          title={t('download.zoom.levelTitle', {
                            zoom: z,
                            level: t(zoomLevelKey(z)),
                          })}
                        >
                          {z}
                        </button>
                      )
                    })}
                  </div>
                  <div className="flex flex-wrap gap-1 text-xs">
                    <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted" onClick={() => selectRange(10, 14)}>z10~14</button>
                    <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted" onClick={() => selectRange(14, 18)}>z14~18</button>
                    <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted" onClick={() => selectRange(15, 19)}>z15~19</button>
                    <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted text-muted-foreground" onClick={clear}>{t('download.zoom.clear')}</button>
                  </div>
                </div>
              )
            }}
          />
          {errors.zoom_levels && (
            <p className="text-xs text-destructive">{errors.zoom_levels.message as string}</p>
          )}
          <p className="text-xs text-muted-foreground">{t('download.zoom.hint')}</p>
        </div>

        {/* 自动估算结果 — 紧跟缩放级别 */}
        {bounds && (
          <StatCard>
            {estimate ? (
              <>
                <div className="grid grid-cols-2 gap-y-1">
                  <div>
                    {t('download.estimate.tiles')}
                    <Badge variant="secondary" className="ml-1">
                      {estimate.tile_count.toLocaleString(i18n.resolvedLanguage)}
                    </Badge>
                  </div>
                  <div>
                    {t('download.estimate.grid', {
                      cols: estimate.cols ?? '-',
                      rows: estimate.rows ?? '-',
                    })}
                  </div>
                  <div className="col-span-2">
                    {t('download.estimate.outputSize')}
                    <span className="font-semibold">
                      {formatBytes(
                        estimate.estimated_output_mb ?? estimate.raw_size_mb ?? estimate.estimated_size_mb,
                      )}
                    </span>
                  </div>
                  <div className="col-span-2 text-muted-foreground">
                    {t('download.estimate.traffic')}
                    {formatBytes(estimate.tile_download_mb ?? estimate.estimated_size_mb)}
                  </div>
                  {format === 'geotiff' && (
                    <div className="col-span-2 text-[11px] text-muted-foreground/80">
                      {t('download.estimate.basis', {
                        crop: t(effectiveCropToShape ? 'download.estimate.on' : 'download.estimate.off'),
                        pyramid: t(buildPyramid ? 'download.estimate.on' : 'download.estimate.off'),
                        compression: compression ?? 'lzw',
                      })}
                    </div>
                  )}
                </div>
                {estimate.size_note && (
                  <p className="mt-1 text-muted-foreground">{estimate.size_note}</p>
                )}
                {estimate.warning && (
                  <div className="mt-1 flex gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <span>{estimate.warning}</span>
                  </div>
                )}
                {estimate.budget_check && estimate.budget_check.allowed === false && (
                  <div className="mt-1 flex gap-1.5 rounded border border-destructive/40 bg-destructive/10 p-1.5 text-destructive">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <span>{estimate.budget_check.message ?? t('download.estimate.insufficientMemory')}</span>
                  </div>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">{t('download.estimate.loading')}</span>
            )}
          </StatCard>
        )}
        </PanelSection>

        <PanelSection
          icon={SlidersHorizontal}
          title={t('download.sections.output.title')}
          description={t('download.sections.output.description')}
          dataTour="imagery-output-section"
        >
        <div className="space-y-1.5">
          <Label className="text-xs">{t('download.output.format')}</Label>
          <Select
            value={format}
            onValueChange={(v) =>
              setValue('format', v as DownloadFormValues['format'], { shouldValidate: true })
            }
            disabled={isDemMode}
          >
            <SelectTrigger title={isDemMode ? t('download.dem.formatOnly') : undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(isMvtMode ? MVT_FORMAT_OPTIONS : FORMAT_OPTIONS).map((opt) => (
                <SelectItem key={opt.value} value={opt.value} disabled={isDemMode && opt.value !== 'geotiff'}>
                  {t(opt.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isDemMode && (
            <p className="text-xs text-muted-foreground">{t('download.dem.formatHint')}</p>
          )}
          {isMvtMode && (
            <p className="text-xs text-muted-foreground">{t('download.output.mvtHint')}</p>
          )}
        </div>

        {format === 'geotiff' && (
          <>
            <Controller
              control={control}
              name="compression"
              render={({ field }) => (
                <TiffCompressionSelect
                  value={field.value as DownloadFormValues['compression']}
                  onChange={(v) => field.onChange(v)}
                />
              )}
            />
            <Controller
              control={control}
              name="generate_sidecars"
              render={({ field }) => (
                <GeoTiffSidecarToggle
                  checked={!!field.value}
                  onChange={(checked) => field.onChange(checked)}
                />
              )}
            />
            <Controller
              control={control}
              name="build_pyramid"
              render={({ field }) => (
                <BuildPyramidToggle
                  checked={!!field.value}
                  onChange={(checked) => field.onChange(checked)}
                />
              )}
            />
          </>
        )}

        {!isMvtMode && !isDemMode && format !== 'pbf' && (() => {
          const overlayCandidates = Object.entries(sourcesQuery.data ?? {})
            .map(([k, v]) => ({ key: k, ...v }))
            .filter((s) => {
              const id = ((s.id as string) ?? s.key).toString()
              const name = (s.name as string) ?? ''
              return id !== source && (id.includes('label') || name.includes('注记') || name.includes('Label'))
            })
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
          if (overlayCandidates.length === 0) return null
          const toggle = (id: string) => {
            const next = overlaySources.includes(id)
              ? overlaySources.filter((x) => x !== id)
              : [...overlaySources, id]
            setValue('overlay_sources', next, { shouldDirty: true })
          }
          return (
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('download.output.overlays')}{' '}
                <span className="text-muted-foreground">{t('download.output.overlaysHint')}</span>
              </Label>
              <div className="rounded border bg-background/50 p-2 space-y-1">
                {overlayCandidates.map((s) => {
                  const id = ((s.id as string) ?? s.key).toString()
                  const checked = overlaySources.includes(id)
                  return (
                    <label key={id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/50 px-1 py-0.5 rounded">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(id)}
                        className="size-3.5"
                      />
                      <span>{(s.name as string) ?? id}</span>
                    </label>
                  )
                })}
              </div>
              {overlaySources.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('download.output.overlaysSelected', { count: overlaySources.length })}
                </p>
              )}
            </div>
          )
        })()}

        <div className="space-y-1.5">
          <Label htmlFor="task_name" className="text-xs">
            {t('download.output.taskName')}{' '}
            <span className="text-muted-foreground">{t('download.output.optional')}</span>
          </Label>
          <Input
            id="task_name"
            placeholder={t('download.output.taskPlaceholder')}
            {...register('task_name')}
          />
          {errors.task_name && (
            <p className="text-xs text-destructive">{errors.task_name.message}</p>
          )}
        </div>

        {dispatchCtx.showModeSelector && (
          <DispatchModeRadio
            count={dispatchCtx.features?.length ?? 0}
            mode={dispatchCtx.mode}
            onChange={dispatchCtx.setMode}
          />
        )}

        <div className="space-y-1.5">
          <Label htmlFor="save_path" className="text-xs">
            {t('download.output.saveDirectory')}
          </Label>
          <div className="flex gap-1.5">
            <Input
              id="save_path"
              className="font-mono text-xs"
              {...register('save_path')}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              title={t('download.output.chooseDirectory')}
              onClick={pickSavePath}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
          {errors.save_path && (
            <p className="text-xs text-destructive">{errors.save_path.message}</p>
          )}
          <p className="text-[11px] text-muted-foreground">
            {t('download.output.saveHint')}
          </p>
        </div>
        </PanelSection>

        <div className="sticky bottom-0 -mx-3 -mb-3 mt-2 flex items-center gap-2 border-t border-border/60 bg-background/95 px-3 py-2.5 backdrop-blur" data-tour="imagery-submit-bar">
          <Button
            type="button"
            className="flex-1 shadow-sm"
            onClick={onSubmit}
            disabled={submitMutation.isPending || sourcesLoading}
          >
            {submitMutation.isPending ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Download className="mr-1.5 size-4" />
            )}
            {t('download.output.create')}
          </Button>
        </div>
      </form>
    </div>
  )
}
