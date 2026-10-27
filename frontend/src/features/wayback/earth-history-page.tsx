import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { open } from '@tauri-apps/plugin-dialog'
import { CalendarClock, Download, FolderOpen, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PanelSection } from '@/components/layout/panel-section'
import { RegionSelector } from '@/features/region/region-selector'
import { getSettings } from '@/features/settings/settings-api'
import { createDownloadTask } from '@/features/download/download-api'
import { buildSelectionCropPolygon } from '@/features/download/crop-utils'
import { useSelectionStore } from '@/store/selection-store'
import { useAppStore } from '@/store/app-store'
import { useWaybackStore } from '@/store/wayback-store'
import type { TileSource } from '@/types/api'
import { getActiveTasks } from '@/features/tasks/tasks-api'
import { useTaskUpdates } from '@/features/tasks/use-task-updates'
import { getTaskMessage, getTaskStatusKey } from '@/features/tasks/task-copy'
import { cancelEarthOperation } from './earth-history-api'
import { createKeyholeSession, getKeyholeDates, getKeyholeStatus } from './keyhole-api'
import type { KeyholeCatalog } from './keyhole-api'
import { keyholeViewKey } from './keyhole-view'

export function EarthHistoryPage({ historySelector }: { historySelector?: ReactNode } = {}) {
  const { t } = useTranslation()
  useTaskUpdates()
  const client = useQueryClient()
  const bounds = useSelectionStore((s) => s.bounds)
  const polygon = useSelectionStore((s) => s.polygon)
  const view = useWaybackStore((s) => s.earthView)
  const selectedDate = useWaybackStore((s) => s.earthDate)
  const preview = useWaybackStore((s) => s.earthPreview)
  const zoom = useWaybackStore((s) => s.earthZoom)
  const setDate = useWaybackStore((s) => s.setEarthDate)
  const [settledView, setSettledView] = useState(view)
  const [format, setFormat] = useState<'geotiff' | 'png'>('geotiff')
  const [savePath, setSavePath] = useState('')
  const [downloadTaskId, setDownloadTaskId] = useState<string | null>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const proxyKey = settings.data?.proxy_enabled ? settings.data.proxy_url : null
  const token = settings.data?.tianditu_token ?? null
  const viewKey = view ? keyholeViewKey(view) : ''
  useEffect(() => { const timer = setTimeout(() => setSettledView(useWaybackStore.getState().earthView), 350); return () => clearTimeout(timer) }, [viewKey])
  const dates = useQuery<KeyholeCatalog>({
    queryKey: ['keyhole-dates', settledView ? keyholeViewKey(settledView) : '', proxyKey],
    enabled: !!settledView && !!settings.data,
    staleTime: 300_000,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }) => {
      const requestId = crypto.randomUUID()
      const cancel = () => { void cancelEarthOperation(requestId) }
      signal.addEventListener('abort', cancel, { once: true })
      try { return await getKeyholeDates({ ...settledView!, zoom: Math.round(settledView!.zoom) }, requestId) }
      finally { signal.removeEventListener('abort', cancel) }
    },
  })
  useEffect(() => { if (dates.data && !dates.isPlaceholderData) useWaybackStore.getState().setEarthPointCatalog(dates.data) }, [dates.data, dates.isPlaceholderData])
  const session = useQuery({
    queryKey: ['keyhole-session', dates.data?.rootId, selectedDate],
    enabled: !!dates.data?.rootId && !!selectedDate,
    staleTime: Infinity,
    retry: false,
    queryFn: () => createKeyholeSession(dates.data!.rootId, selectedDate!),
  })
  useEffect(() => {
    const result = session.data
    if (!result || result.requestedDate !== selectedDate || useWaybackStore.getState().provider !== 'earth') return
    client.setQueryData<Record<string, TileSource>>(['tile-sources-merged', token], (sources) => ({ ...sources, [result.source.id]: result.source }))
    useWaybackStore.getState().setEarthPreview(result)
    useAppStore.getState().setSelectedSourceForMode('wayback', result.source.id)
  }, [session.data, selectedDate, client, token])
  const status = useQuery({ queryKey: ['keyhole-status', preview?.id], queryFn: () => getKeyholeStatus(preview!.source.id), enabled: !!preview, refetchInterval: 2000 })
  const download = useMutation({
    onMutate: () => setDownloadTaskId(null),
    mutationFn: async () => {
      if (!preview || !bounds || preview.requestedDate !== selectedDate) throw new Error(t('wayback.errors.selectRegion'))
      const date = selectedDate
      let destination = savePath.trim()
      if (!destination) {
        const directory = await open({ directory: true, title: t('wayback.directory.generic') })
        if (!directory) throw new Error('__user_cancelled__')
        destination = directory as string
        setSavePath(destination)
      }
      const extension = format === 'geotiff' ? 'tif' : 'png'
      if (!destination.toLowerCase().endsWith(`.${extension}`)) destination = `${destination.replace(/[\\/]$/, '')}${destination.includes('\\') ? '\\' : '/'}Earth_${date}_z${zoom}_${Date.now()}.${extension}`
      return createDownloadTask({ source: preview.source.id, bounds, zoom, zoom_levels: [zoom], zoom_max: null,
        format, save_path: destination, concurrency: 2, proxy: proxyKey ?? null, tianditu_token: null,
        crop_to_shape: true, polygon: buildSelectionCropPolygon(bounds, polygon, true), compression: 'lzw',
        build_pyramid: false, generate_sidecars: format === 'geotiff' }, `Google Earth ${date} z${zoom}`, preview.source.name)
    },
    onSuccess: (result) => { setDownloadTaskId(result.task_id); toast.success(t('wayback.toast.taskCreated')); void client.invalidateQueries({ queryKey: ['active-tasks'] }) },
    onError: (error) => {
      const message = String(error)
      if (message.includes('__user_cancelled__') || message.includes('EARTH_CANCELLED')) return
      toast.error(message.includes('EARTH_BUDGET') ? t('wayback.earth.budgetError') : message.includes('EARTH_NO_DATA') ? t('wayback.earth.noDataError') : message.includes('EARTH_UNSUPPORTED') ? t('wayback.earth.encodingError') : message.includes('EARTH_PROTOCOL') ? t('wayback.earth.protocolError') : message)
    },
  })
  const tasks = useQuery({ queryKey: ['active-tasks'], queryFn: getActiveTasks, enabled: !!downloadTaskId,
    refetchInterval: (query) => query.state.data?.find((task) => task.id === downloadTaskId && ['completed','completed_with_gaps','failed','cancelled'].includes(String(task.status))) ? false : 1000 })
  const downloadTask = tasks.data?.find((task) => task.id === downloadTaskId)
  const hasDownloadTask = !!downloadTask
  useEffect(() => { if (downloadTaskId && hasDownloadTask) progressRef.current?.scrollIntoView({ block: 'nearest' }) }, [downloadTaskId, hasDownloadTask])
  const downloadRunning = downloadTask && !['completed','completed_with_gaps','failed','cancelled','paused','pending_decision'].includes(String(downloadTask.status))
  const error = dates.error ?? session.error
  const rows = dates.data?.dates ?? []
  const statusData = status.data
  return <div className="space-y-4" data-earth-history-page>
    <RegionSelector />
    {historySelector}
    <PanelSection icon={CalendarClock} title={t('wayback.earth.title')} description={t('wayback.earth.streamingDescription')}>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('wayback.earth.streamingHint')}</p>
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor="earth-history-date">{t('wayback.selectDate')}</Label>
        <Select value={selectedDate ?? ''} onValueChange={setDate} disabled={!rows.length}>
          <SelectTrigger id="earth-history-date" data-agent-target="earth-date-select"><SelectValue placeholder={t('wayback.selectDate')} /></SelectTrigger>
          <SelectContent>
            {selectedDate && !rows.some((row) => row.date === selectedDate) && <SelectItem value={selectedDate}>{selectedDate}</SelectItem>}
            {rows.map((row) => <SelectItem key={row.date} value={row.date}>{row.date}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {(dates.isFetching || session.isFetching) && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />{t('wayback.earth.viewLoading')}</p>}
      {dates.data && <p className="text-xs text-muted-foreground">{t('wayback.earth.centreDates', { count: rows.length })}</p>}
      {dates.data && rows.length === 0 && <p className="text-xs text-muted-foreground">{t('wayback.earth.noDates')}</p>}
      {!!error && <p role="alert" className="text-xs text-destructive" title={String(error)}>{t('wayback.earth.networkError')}</p>}
      {!!statusData?.errors && <p role="alert" className="text-xs text-destructive">{t('wayback.earth.tileErrors', { count: statusData.errors })}</p>}
      {!!statusData?.fallbackTiles && <p className="text-xs text-muted-foreground">{t('wayback.earth.fallback')}</p>}
      {!!statusData?.noData && statusData.loaded === statusData.noData && <p className="text-xs text-muted-foreground">{t('wayback.earth.noDataError')}</p>}
      {!!statusData?.providers.length && <p className="text-xs text-muted-foreground">{statusData.providers.join(' · ')}</p>}
    </PanelSection>
    <PanelSection icon={Download} title={t('download.sections.output.title')} description={t('wayback.earth.downloadSelection')}>
      <Label className="text-xs">{t('download.zoom.title')}</Label>
      <Select value={String(zoom)} onValueChange={(value) => useWaybackStore.getState().setEarthZoom(Number(value))}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{Array.from({ length: 22 }, (_, i) => i + 1).map((value) => <SelectItem key={value} value={String(value)}>z{value}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={format} onValueChange={(value) => setFormat(value as 'geotiff' | 'png')}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="geotiff">GeoTIFF (.tif)</SelectItem><SelectItem value="png">PNG (.png)</SelectItem></SelectContent>
      </Select>
      <Label htmlFor="earth-save-path" className="text-xs">{t('download.output.saveDirectory')}</Label>
      <div className="flex gap-2"><Input id="earth-save-path" value={savePath} onChange={(event) => setSavePath(event.target.value)} />
        <Button variant="outline" size="icon" title={t('download.output.chooseDirectory')} onClick={async () => { const result = await open({ directory: true }); if (result) setSavePath(result as string) }}><FolderOpen className="size-4" /></Button>
      </div>
      <Button className="w-full" disabled={!preview || !bounds || download.isPending} onClick={() => download.mutate()} data-agent-target="earth-create-download">
        {download.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}{t('download.output.create')}
      </Button>
      {downloadTask && <div ref={progressRef} className="space-y-1.5 rounded-md border px-3 py-2" data-agent-target="earth-download-progress" data-task-id={downloadTask.id} data-task-status={downloadTask.status}>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-1.5">{downloadRunning && <Loader2 className="size-3 animate-spin" />}{t(getTaskStatusKey(String(downloadTask.status)) ?? 'tasks.status.downloading')}</span>
          <span className="tabular-nums">{(downloadTask.progress ?? 0).toFixed(1)}%</span>
        </div>
        <div role="progressbar" aria-label={t('tasks.labels.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloadTask.progress ?? 0} className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width] duration-150" style={{ width: `${Math.max(0,Math.min(100,downloadTask.progress ?? 0))}%` }} />
        </div>
        <p className={`text-xs ${downloadTask.error ? 'text-destructive' : 'text-muted-foreground'}`}>{downloadTask.error || getTaskMessage(downloadTask,t)}</p>
      </div>}
    </PanelSection>
  </div>
}
