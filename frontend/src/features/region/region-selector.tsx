import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, MapPin, Search, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Feature, GeoJsonObject } from 'geojson'
import { useTranslation } from 'react-i18next'
import { ask as askDialog, open as openDialog } from '@tauri-apps/plugin-dialog'

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
import { isTauriRuntime } from '@/lib/tauri'
import { PanelSection } from '@/components/layout/panel-section'
import {
  parseRegionFile,
  parseRegionPath,
  REGION_FILE_ACCEPT_ATTR,
  type ParsedRegionFile,
  UnsupportedRegionFileError,
  validateWgs84Coordinates,
} from '@/lib/geo-import'
import {
  extractAreaFeatures,
  outerRingsFromAreaGeometry,
  regionAreaErrorReason,
} from '@/lib/geo-area'
import { RegionImportDialog } from './region-import-dialog'
import { RegionBookmarksDialog } from './region-bookmarks-dialog'
import type { RegionBookmark } from './region-bookmarks-api'
import {
  geocodeSearch,
  getAdminBoundary,
  getCities,
  getDistricts,
  getProvinces,
  type GeocodeResult,
} from './region-api'
import { useSelectionStore, type LatLngRing, type MapBounds } from '@/store/selection-store'
import { useAppStore } from '@/store/app-store'
import { getSettings } from '@/features/settings/settings-api'
import {
  telemetryCountBucket,
  telemetryImportFormat,
  trackTelemetry,
} from '@/features/telemetry/telemetry-client'

function ringsFromGeoJSON(geojson: GeoJsonObject): LatLngRing[] {
  return extractAreaFeatures(geojson).flatMap((feature) =>
    outerRingsFromAreaGeometry(feature.geometry).map((ring) =>
      ring.map((coordinate) => ({ lat: coordinate[1], lng: coordinate[0] })),
    ),
  )
}

function boundsFromRings(rings: LatLngRing[]): MapBounds | null {
  if (rings.length === 0) return null
  let n = -Infinity
  let s = Infinity
  let e = -Infinity
  let w = Infinity
  for (const ring of rings) {
    for (const p of ring) {
      if (p.lat > n) n = p.lat
      if (p.lat < s) s = p.lat
      if (p.lng > e) e = p.lng
      if (p.lng < w) w = p.lng
    }
  }
  return { north: n, south: s, east: e, west: w }
}

function splitAdminCode(code: string | null): {
  provinceCode: string
  cityCode: string
  districtCode: string
} {
  // 旧版本仅持久化了单个 code，迁移期降级方案：按 6 位编码模板拆分。
  // 注意：直辖市（北京/天津/上海/重庆）DataV 把区县直接挂在省下，
  // 此处拆出的虚拟 city（如 "110100"）在城市下拉里并不存在，
  // 因此首次迁移后建议优先使用 store 里的 adminSelection 三元组。
  if (!code || code.length < 6 || code === '100000') {
    return { provinceCode: '', cityCode: '', districtCode: '' }
  }
  const provinceCode = `${code.slice(0, 2)}0000`
  const cityCode = code.slice(2, 4) === '00' ? '' : `${code.slice(0, 4)}00`
  const districtCode = code.slice(4, 6) === '00' ? '' : code
  return { provinceCode, cityCode, districtCode }
}

export function RegionSelector({ extras }: { extras?: import('react').ReactNode } = {}) {
  const { t } = useTranslation()
  const inTauri = isTauriRuntime()
  const setExternalSelection = useSelectionStore((s) => s.setExternalSelection)
  const setCurrentAdminCode = useAppStore((s) => s.setCurrentAdminCode)
  const setAdminSelection = useAppStore((s) => s.setAdminSelection)
  // 优先使用 store 里持久化的 adminSelection（三元组），兼容旧版本只存了 currentAdminCode 的情况
  const initialSelection = (() => {
    const stored = useAppStore.getState().adminSelection
    if (stored && (stored.provinceCode || stored.cityCode || stored.districtCode)) {
      return stored
    }
    return splitAdminCode(useAppStore.getState().currentAdminCode)
  })()

  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([])
  const [searching, setSearching] = useState(false)

  const [provinceCode, setProvinceCode] = useState<string>(initialSelection.provinceCode)
  const [cityCode, setCityCode] = useState<string>(initialSelection.cityCode)
  const [districtCode, setDistrictCode] = useState<string>(initialSelection.districtCode)
  const [loadingBoundary, setLoadingBoundary] = useState(false)

  // 三段值 → 同步到 store（持久化）+ 派生 currentAdminCode 给其它消费者
  useEffect(() => {
    setAdminSelection({ provinceCode, cityCode, districtCode })
    const code = districtCode || cityCode || provinceCode || null
    setCurrentAdminCode(code)
  }, [provinceCode, cityCode, districtCode, setAdminSelection, setCurrentAdminCode])

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings, enabled: inTauri })

  const provincesQuery = useQuery({
    queryKey: ['admin-provinces'],
    queryFn: getProvinces,
    enabled: inTauri,
  })
  const citiesQuery = useQuery({
    queryKey: ['admin-cities', provinceCode],
    queryFn: () => getCities(provinceCode),
    enabled: inTauri && !!provinceCode,
  })
  const districtsQuery = useQuery({
    queryKey: ['admin-districts', cityCode],
    queryFn: () => getDistricts(cityCode),
    enabled: inTauri && !!cityCode,
  })

  const fileRef = useRef<HTMLInputElement>(null)

  const loadByCode = async (code: string, label: string, method: 'admin' | 'search' = 'admin') => {
    if (!code) return
    setLoadingBoundary(true)
    try {
      const geojson = (await getAdminBoundary(code, true)) as GeoJsonObject
      const rings = ringsFromGeoJSON(geojson)
      if (rings.length === 0) {
        toast.error(t('region.toast.noPolygon'))
        return
      }
      setExternalSelection({ bounds: boundsFromRings(rings), polygon: rings })
      void trackTelemetry('selection_changed', {
        method,
        geometry: 'polygon',
        complexity: telemetryCountBucket(rings.reduce((total, ring) => total + ring.length, 0)),
      })
      setCurrentAdminCode(code)
      toast.success(t('region.toast.loaded', { label }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('region.toast.loadError', { message: msg }))
    } finally {
      setLoadingBoundary(false)
    }
  }

  const onLoadSelectedBoundary = () => {
    const code = districtCode || cityCode || provinceCode
    if (!code) {
      // 三级都为空 → 加载全国边界
      void loadByCode('100000', t('region.nationwide'))
      return
    }
    const label =
      districtsQuery.data?.find((d) => d.code === districtCode)?.name ||
      citiesQuery.data?.find((c) => c.code === cityCode)?.name ||
      provincesQuery.data?.find((p) => p.code === provinceCode)?.name ||
      code
    void loadByCode(code, label)
  }

  // 清除选区：同时清空地图选区与行政区划三段下拉。
  // 三段 state 置空后，上方 [provinceCode, cityCode, districtCode] 的 useEffect 会自动
  // 把空值同步回 store（adminSelection / currentAdminCode），无需在此重复 set。
  const onClearSelection = () => {
    useSelectionStore.getState().clear()
    setProvinceCode('')
    setCityCode('')
    setDistrictCode('')
  }

  const onRestoreBookmark = (bookmark: RegionBookmark) => {
    setExternalSelection({
      bounds: bookmark.bounds,
      polygon: bookmark.polygon,
    })
    setProvinceCode('')
    setCityCode('')
    setDistrictCode('')
    void trackTelemetry('bookmark_action', { action: 'restored' })
    void trackTelemetry('selection_changed', {
      method: 'bookmark',
      geometry: bookmark.polygon?.length ? 'polygon' : 'bounds',
      complexity: telemetryCountBucket(
        bookmark.polygon?.reduce((total, ring) => total + ring.length, 0) ?? 0,
      ),
    })
    toast.success(t('region.toast.restored', { name: bookmark.name }))
  }

  const onSearch = async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    try {
      const token = settingsQuery.data?.tianditu_token ?? null
      const results = await geocodeSearch(q, token)
      setSearchResults(results)
      if (results.length === 0) toast.info(t('region.toast.noSearchResults'))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('region.toast.searchError', { message: msg }))
    } finally {
      setSearching(false)
    }
  }

  const onPickResult = (r: GeocodeResult) => {
    if (r.kind === 'admin' && r.admin_code) {
      void loadByCode(r.admin_code, r.name, 'search')
      setSearchResults([])
      return
    }
    if (r.bounds) {
      setExternalSelection({
        bounds: r.bounds,
        polygon: null,
      })
      void trackTelemetry('selection_changed', {
        method: 'search',
        geometry: 'bounds',
        complexity: '0',
      })
      toast.success(t('region.toast.located', { name: r.name }))
      setSearchResults([])
      return
    }
    // 仅有点：以点附近 0.05° 半径
    const half = 0.05
    setExternalSelection({
      bounds: {
        north: r.lat + half,
        south: r.lat - half,
        east: r.lng + half,
        west: r.lng - half,
      },
      polygon: null,
    })
    void trackTelemetry('selection_changed', {
      method: 'search',
      geometry: 'bounds',
      complexity: '0',
    })
    setSearchResults([])
  }

  const [importDialog, setImportDialog] = useState<{
    features: Feature[]
    filename: string
    crs: ParsedRegionFile['crs']
  } | null>(null)

  const processParsedRegion = async (parsed: ParsedRegionFile) => {
    const { geojson, filename, crs } = parsed
    const format = telemetryImportFormat(filename)
    const areaFeatures = extractAreaFeatures(geojson)
    if (areaFeatures.length === 0) {
      void trackTelemetry('region_imported', { format, outcome: 'no_area', feature_count: '0' })
      const errorKey = {
        'lines-and-points': 'region.toast.areaLinesAndPoints',
        lines: 'region.toast.areaLines',
        points: 'region.toast.areaPoints',
        missing: 'region.toast.areaMissing',
      }[regionAreaErrorReason(geojson)]
      toast.error(t(errorKey))
      return
    }

    const validation = validateWgs84Coordinates(
      { type: 'FeatureCollection', features: areaFeatures } as GeoJsonObject,
    )
    if (!validation.valid) {
      void trackTelemetry('region_imported', { format, outcome: 'error', feature_count: '0' })
      const sample = validation.firstInvalid
        ? `${validation.firstInvalid[0]}, ${validation.firstInvalid[1]}`
        : t('region.toast.unknownCoordinate')
      toast.error(t('region.toast.invalidCoordinates', { sample }))
      return
    }

    if (crs.needsConfirmation) {
      const confirmed = await askDialog(t('region.crsAssumptionMessage'), {
        title: t('region.crsAssumptionTitle'),
        kind: 'warning',
        okLabel: t('region.crsAssumptionConfirm'),
        cancelLabel: t('common.cancel'),
      })
      if (!confirmed) return
    }

    const rings = ringsFromGeoJSON(geojson)
    if (areaFeatures.length > 1) {
      setImportDialog({ features: areaFeatures, filename, crs })
      return
    }

    setExternalSelection({ bounds: boundsFromRings(rings), polygon: rings })
    void trackTelemetry('region_imported', {
      format,
      outcome: 'success',
      feature_count: telemetryCountBucket(areaFeatures.length),
    })
    void trackTelemetry('selection_changed', {
      method: 'import',
      geometry: 'polygon',
      complexity: telemetryCountBucket(rings.reduce((total, ring) => total + ring.length, 0)),
    })
    toast.success(t('region.toast.imported'), { description: crs.label })
  }

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const file = files[0]
    const format = telemetryImportFormat(file.name)
    try {
      try {
        await processParsedRegion(await parseRegionFile(file))
      } catch (e) {
        if (e instanceof UnsupportedRegionFileError) {
          void trackTelemetry('region_imported', { format, outcome: 'error', feature_count: '0' })
          toast.error(e.message)
          return
        }
        throw e
      }
    } catch (e) {
      void trackTelemetry('region_imported', { format, outcome: 'error', feature_count: '0' })
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('region.toast.importError', { message: msg }))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const onOpenRegionFile = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: t('region.uploadTitle'),
        filters: [{
          name: t('region.fileFilter'),
          extensions: ['geojson', 'json', 'shp', 'zip', 'kml', 'kmz'],
        }],
      })
      if (typeof selected !== 'string') return
      await processParsedRegion(await parseRegionPath(selected))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('region.toast.importError', { message }))
    }
  }

  // 注意：省/市切换清子项已在下方 Select onValueChange 里直接处理。
  // 不要在这里写 useEffect [provinceCode] 清空 cityCode/districtCode，
  // 因为 React StrictMode 下双挂载会让 hasMountedRef 守卫失效，
  // 第二次挂载时把刚刚从 localStorage 恢复的子级清掉。

  if (!inTauri) {
    return (
      <PanelSection
        icon={MapPin}
        title={t('region.title')}
        description={t('region.manualDescription')}
        dataTour="region-selector"
      >
        <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
          {t('region.unavailable')}
        </div>
        {extras}
      </PanelSection>
    )
  }

  return (
    <PanelSection
      icon={MapPin}
      title={t('region.title')}
      description={t('region.description')}
      dataTour="region-selector"
    >
      {/* 地名搜索 */}
      <div className="space-y-1.5">
        <div className="flex gap-1.5">
          <Input
            placeholder={t('region.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void onSearch()
              }
            }}
          />
          <Button type="button" size="icon" onClick={() => void onSearch()} disabled={searching}>
            {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          </Button>
        </div>
        {searchResults.length > 0 && (
          <div className="max-h-40 overflow-y-auto rounded-md border bg-popover">
            {searchResults.map((r, idx) => (
              <button
                key={`${r.name}-${idx}`}
                type="button"
                onClick={() => onPickResult(r)}
                className="block w-full border-b border-border/40 px-2 py-1.5 text-left text-xs last:border-b-0 hover:bg-accent"
              >
                <div className="font-medium">{r.name}</div>
                {r.display_name && r.display_name !== r.name && (
                  <div className="truncate text-xs text-muted-foreground">{r.display_name}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 三级联动 */}
      <div className="grid grid-cols-3 gap-1.5">
        <Select
          value={provinceCode || '__all__'}
          onValueChange={(v) => {
            setProvinceCode(v === '__all__' ? '' : v)
            setCityCode('')
            setDistrictCode('')
          }}
        >
          <SelectTrigger className="text-sm">
            <SelectValue placeholder={t('region.province')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('region.nationwide')}</SelectItem>
            {provincesQuery.data?.map((p) => (
              <SelectItem key={p.code} value={p.code}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={cityCode || '__all__'}
          onValueChange={(v) => {
            setCityCode(v === '__all__' ? '' : v)
            setDistrictCode('')
          }}
          disabled={!provinceCode || citiesQuery.isLoading}
        >
          <SelectTrigger className="text-sm">
            <SelectValue placeholder={t('region.city')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('region.all')}</SelectItem>
            {citiesQuery.data?.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={districtCode || '__all__'}
          onValueChange={(v) => setDistrictCode(v === '__all__' ? '' : v)}
          disabled={
            !cityCode ||
            districtsQuery.isLoading ||
            (districtsQuery.data?.length ?? 0) === 0
          }
        >
          <SelectTrigger className="text-sm">
            <SelectValue
              placeholder={
                cityCode && !districtsQuery.isLoading && (districtsQuery.data?.length ?? 0) === 0
                  ? t('region.noDistrict')
                  : t('region.district')
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('region.all')}</SelectItem>
            {districtsQuery.data?.map((d) => (
              <SelectItem key={d.code} value={d.code}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="flex-1"
          onClick={onLoadSelectedBoundary}
          disabled={loadingBoundary}
        >
          {loadingBoundary ? (
            <Loader2 className="mr-1 size-3.5 animate-spin" />
          ) : (
            <MapPin className="mr-1 size-3.5" />
          )}
          {t('region.loadBoundary')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onOpenRegionFile()}
          title={t('region.uploadTitle')}
        >
          <Upload className="mr-1 size-3.5" />
          {t('region.upload')}
        </Button>
        <RegionBookmarksDialog onRestore={onRestoreBookmark} />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onClearSelection}
          title={t('region.clear')}
          className="size-8"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <Label htmlFor="boundary-upload" className="sr-only">{t('region.uploadBoundary')}</Label>
      <input
        ref={fileRef}
        id="boundary-upload"
        type="file"
        accept={REGION_FILE_ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => void onPickFiles(e.target.files)}
      />
      {extras}
      <RegionImportDialog
        features={importDialog?.features ?? null}
        filename={importDialog?.filename ?? ''}
        crs={importDialog?.crs ?? null}
        onClose={() => setImportDialog(null)}
      />
    </PanelSection>
  )
}
