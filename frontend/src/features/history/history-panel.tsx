import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ask as askDialog } from '@tauri-apps/plugin-dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { getTaskErrorMessage } from '@/features/tasks/task-copy'
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Inbox,
  Layers,
  Map as MapIcon,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { isTauriRuntime } from '@/lib/tauri'
import {
  buildPyramidForFile,
  clearDownloadHistory,
  deleteDownloadRecord,
  getDownloadHistory,
} from '@/features/history/history-api'
import { readLogFile } from '@/features/tasks/tasks-api'
import { getActiveTasks } from '@/features/tasks/tasks-api'
import { historyWithoutVisibleTasks } from '@/features/tasks/task-results'
import { OutputActions } from '@/features/tasks/output-location'
import { TaskCardHeading } from '@/features/tasks/task-card-heading'
import { TaskCardAction, TaskCardActions } from '@/features/tasks/task-card-actions'
import { Tooltip } from '@/components/ui/tooltip'
import { serveLocalTiles } from '@/features/tiles3d/tiles3d-api'
import { MvtPreview } from '@/features/mvt/mvt-preview'
import type { DownloadHistoryRecord, TaskLog } from '@/types/api'

function formatBytes(n?: number): string {
  if (!n || n <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(2)} ${units[i]}`
}

function formatDuration(secs?: number): string | null {
  if (!secs || secs <= 0) return null
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${h}h ${m}m`
}

function formatDate(iso: string | undefined, locale: string, compact = false): string {
  if (!iso) return '-'
  try {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    return date.toLocaleString(locale, compact
      ? { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
      : { hour12: false })
  } catch {
    return iso
  }
}

interface PyramidProgressPayload {
  record_id: string
  current: number
  total: number
}

const PAGE_SIZE = 50

function HistoryLogPanel({ logFile }: { logFile: string }) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const logQuery = useQuery({
    queryKey: ['history-log', logFile],
    queryFn: () => readLogFile(logFile),
  })
  const logs: TaskLog[] | null = logQuery.data ?? null
  const error = logQuery.isError ? String(logQuery.error) : null

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  const onCopy = useCallback(async () => {
    if (!logs) return
    const text = logs
      .map((l) => `[${l.timestamp}] [${l.level}] ${l.message}`)
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('tasks.logs.copied'))
    } catch {
      toast.error(t('tasks.logs.copyError'))
    }
  }, [logs, t])

  return (
    <div className="mt-2 min-w-0 rounded-md border bg-muted/30">
      <div className="flex items-center justify-between border-b px-2 py-1">
        <span className="text-xs text-muted-foreground">
          {t('tasks.logs.title')} {logs ? `(${logs.length})` : ''}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCopy}
          className="h-6 gap-1 px-2 text-xs"
          disabled={!logs || logs.length === 0}
        >
          <ClipboardCopy className="size-3" />
          {t('tasks.logs.copy')}
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="max-h-48 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]"
      >
        {error && (
          <p className="text-destructive">{t('tasks.logs.readError', { message: error })}</p>
        )}
        {!error && !logs && <p className="text-muted-foreground">{t('history.loading')}</p>}
        {!error && logs && logs.length === 0 && (
          <p className="text-muted-foreground">{t('tasks.logs.missing')}</p>
        )}
        {!error &&
          logs?.map((l, i) => {
            const cls =
              l.level === 'ERROR'
                ? 'text-destructive'
                : l.level === 'WARN'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-foreground/80'
            return (
              <div key={i} className={cls}>
                <span className="text-muted-foreground">{l.timestamp}</span> {l.message}
              </div>
            )
          })}
      </div>
    </div>
  )
}

function HistoryCard({
  record,
  pyramidProgress,
  onDeleted,
}: {
  record: DownloadHistoryRecord
  pyramidProgress?: PyramidProgressPayload
  onDeleted: () => void
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [showLogs, setShowLogs] = useState(false)
  const id = String(record.id)
  const isFailed =
    record.success === false ||
    (typeof record.status === 'string' && record.status === 'failed')
  const filePath = (record.file_path as string | undefined) ?? ''
  const logFile = (record.log_file as string | undefined) ?? ''
  const isTiff =
    record.format === 'geotiff' || (filePath && filePath.toLowerCase().endsWith('.tif'))
  const hasPyramid = Boolean(record.has_pyramid)
  const canBuildPyramid = !isFailed && Boolean(filePath) && Boolean(isTiff) && !hasPyramid
  const isMvt = record.format === 'pbf' || record.format === 'mvt'
  const canPreviewMvt = !isFailed && Boolean(filePath) && isMvt
  const duration = formatDuration(record.duration_secs as number | undefined)
  const [mvtPreviewOpen, setMvtPreviewOpen] = useState(false)
  const [mvtPreviewUrl, setMvtPreviewUrl] = useState<string | null>(null)
  const mvtPreviewMutation = useMutation({
    mutationFn: async () => {
      const base = await serveLocalTiles(filePath)
      return `${base}/{z}/{x}/{y}.pbf`
    },
    onSuccess: (url) => {
      setMvtPreviewUrl(url)
      setMvtPreviewOpen(true)
    },
    onError: (e) => toast.error(t('history.toast.previewError', { message: String(e) })),
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const ok = await askDialog(
        t('history.confirm.delete'),
        {
          title: t('history.confirm.deleteTitle'),
          kind: 'warning',
        },
      )
      if (!ok) return false
      await deleteDownloadRecord(id)
      return true
    },
    onSuccess: (changed) => {
      if (changed) {
        toast.success(t('history.toast.deleted'))
        onDeleted()
      }
    },
    onError: (e) => toast.error(t('history.toast.deleteError', { message: String(e) })),
  })
  const pyramidMutation = useMutation({
    mutationFn: () => buildPyramidForFile(id, filePath),
    onSuccess: () => {
      toast.success(t('history.toast.pyramidDone'))
      qc.invalidateQueries({ queryKey: ['download-history'] })
    },
    onError: (e) => toast.error(t('history.toast.pyramidError', { message: String(e) })),
  })

  const pyramidLabel = (() => {
    if (pyramidMutation.isPending) {
      if (pyramidProgress) {
        return t('history.actions.pyramidProgress', {
          current: pyramidProgress.current + 1,
          total: pyramidProgress.total,
        })
      }
      return t('history.actions.building')
    }
    return t('history.actions.buildPyramid')
  })()

  return (
    <div role="group" aria-label={record.name} data-history-id={id} className="min-w-0 space-y-2 rounded-md border p-3 text-sm">
      <TaskCardHeading title={record.name} source={record.source_name ? String(record.source_name) : undefined}
        zoom={typeof record.zoom === 'number' ? record.zoom : undefined}
        statusTitle={t(isFailed ? 'history.status.failed' : 'history.status.completed')}
        status={<Badge variant={isFailed ? 'destructive' : 'default'}>{t(isFailed ? 'history.status.failed' : 'history.status.completed')}</Badge>}/>

      <div data-task-card-metadata className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted-foreground">
        {typeof record.tile_count === 'number' && record.tile_count > 0 && (
          <span className="whitespace-nowrap">
            {record.tile_count.toLocaleString(i18n.resolvedLanguage ?? i18n.language)}{' '}
            {typeof record.zoom === 'number' && record.zoom > 0
              ? t('history.labels.tiles')
              : t('history.labels.nodes')}
          </span>
        )}
        {typeof record.file_size === 'number' && record.file_size > 0 && (
          <span className="whitespace-nowrap">{formatBytes(record.file_size)}</span>
        )}
        {duration && <span className="whitespace-nowrap">{t('history.labels.duration', { duration })}</span>}
        {record.created_at && <Tooltip content={formatDate(record.created_at, i18n.resolvedLanguage ?? i18n.language)}><span data-task-card-date tabIndex={0} className="max-w-full truncate">
          {formatDate(record.created_at, i18n.resolvedLanguage ?? i18n.language, true)}
        </span></Tooltip>}
        {hasPyramid && <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[11px] font-normal">{t('history.labels.pyramid')}</Badge>}
        {record.log_truncated && <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal">{t('history.labels.truncated')}</Badge>}
      </div>

      {isFailed && record.error && <Tooltip content={String(record.error)}><p tabIndex={0} className="line-clamp-2 whitespace-pre-wrap text-xs leading-relaxed text-destructive [overflow-wrap:anywhere]">{getTaskErrorMessage(String(record.error), t)}</p></Tooltip>}

      <TaskCardActions>
        {filePath && <OutputActions path={filePath} saved={!isFailed}
          strictFile={record.source === 'osm_vector' || String(record.format) === 'geojson'}/>}
        {canBuildPyramid && (
          <TaskCardAction
            icon={Layers}
            onClick={() => pyramidMutation.mutate()}
            disabled={pyramidMutation.isPending}
            title={pyramidLabel} aria-label={pyramidLabel}
          >
            {pyramidMutation.isPending ? pyramidLabel : t('tasks.cardActions.pyramid')}
          </TaskCardAction>
        )}
        {canPreviewMvt && (
          <TaskCardAction
            icon={MapIcon}
            onClick={() => mvtPreviewMutation.mutate()}
            disabled={mvtPreviewMutation.isPending}
            title={t('history.actions.previewMvt')} aria-label={t('history.actions.previewMvt')}
          >
            {mvtPreviewMutation.isPending
              ? t('history.actions.startingPreview')
              : t('tasks.cardActions.preview')}
          </TaskCardAction>
        )}
        {logFile && (
          <TaskCardAction
            icon={showLogs ? ChevronDown : ChevronRight}
            onClick={() => setShowLogs((v) => !v)}
          >
            {t('history.actions.logs')}
          </TaskCardAction>
        )}
        <TaskCardAction
          icon={Trash2} danger
          onClick={() => deleteMutation.mutate()}
          disabled={deleteMutation.isPending}
          title={t('history.actions.delete')} aria-label={t('history.actions.delete')}
        >
          {t('history.actions.delete')}
        </TaskCardAction>
      </TaskCardActions>

      {showLogs && logFile && <HistoryLogPanel logFile={logFile} />}
      {canPreviewMvt && (
        <Dialog open={mvtPreviewOpen} onOpenChange={setMvtPreviewOpen}>
          <DialogContent className="max-w-5xl">
            <DialogHeader>
              <DialogTitle>{t('history.previewTitle', { name: record.name })}</DialogTitle>
            </DialogHeader>
            <Tooltip content={mvtPreviewUrl}><p tabIndex={0} className="truncate font-mono text-[11px] text-muted-foreground">
              {mvtPreviewUrl}
            </p></Tooltip>
            {mvtPreviewUrl && (
              <div style={{ height: 520 }}>
                <MvtPreview urlTemplate={mvtPreviewUrl} maxZoom={record.zoom as number | undefined ?? 14} />
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

export function HistoryPanel() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const inTauri = isTauriRuntime()
  const [pyramidProgress, setPyramidProgress] = useState<Map<string, PyramidProgressPayload>>(
    () => new Map(),
  )
  const [page, setPage] = useState(1)
  // Subscribe to task cache changes without starting another task poller.
  const currentTasks = useQuery({ queryKey: ['active-tasks'], queryFn: getActiveTasks, enabled: false })

  const historyQuery = useQuery({
    queryKey: ['download-history', page],
    queryFn: () => getDownloadHistory(page, PAGE_SIZE),
    enabled: inTauri,
  })

  // 监听金字塔构建进度
  useEffect(() => {
    if (!inTauri) return
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    listen<PyramidProgressPayload>('pyramid-progress', (e) => {
      const p = e.payload
      setPyramidProgress((prev) => {
        const next = new Map(prev)
        if (p.current + 1 >= p.total) {
          next.delete(p.record_id)
        } else {
          next.set(p.record_id, p)
        }
        return next
      })
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [inTauri])

  // 历史写入完成后刷新；任务进度事件不再触发历史查询。
  useEffect(() => {
    if (!inTauri) return
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    listen('download-history-updated', () => {
        qc.invalidateQueries({ queryKey: ['download-history'] })
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [inTauri, qc])

  const clearMutation = useMutation({
    mutationFn: async () => {
      const ok = await askDialog(
        t('history.confirm.clear'),
        { title: t('history.confirm.clearTitle'), kind: 'warning' },
      )
      if (!ok) return false
      await clearDownloadHistory()
      return true
    },
    onSuccess: (changed) => {
      if (changed) {
        toast.success(t('history.toast.cleared'))
        setPage(1)
        qc.invalidateQueries({ queryKey: ['download-history'] })
      }
    },
    onError: (e) => toast.error(t('history.toast.clearError', { message: String(e) })),
  })

  const pageRecords = useMemo(() => historyQuery.data?.records ?? [], [historyQuery.data])
  const records = useMemo(() => historyWithoutVisibleTasks(pageRecords, currentTasks.data ?? []), [pageRecords, currentTasks.data])
  const total = historyQuery.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const handleRecordDeleted = useCallback(() => {
    if (records.length === 1 && page > 1) {
      setPage((current) => Math.max(1, current - 1))
    }
    qc.invalidateQueries({ queryKey: ['download-history'] })
  }, [page, qc, records.length])

  if (!inTauri) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-xs text-muted-foreground">
        {t('history.unavailable')}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {t('history.labels.total', { count: total })}
        </span>
        <div className="flex items-center gap-1">
          <Tooltip content={t('history.actions.refresh')}><Button
            variant="ghost"
            size="icon"
            onClick={() => historyQuery.refetch()}
            disabled={historyQuery.isFetching}
            className="size-7"
            aria-label={t('history.actions.refresh')}
          >
            <RefreshCw
              className={`size-3.5 ${historyQuery.isFetching ? 'animate-spin' : ''}`}
            />
          </Button></Tooltip>
          <Tooltip content={t('history.actions.clear')}><Button
            variant="ghost"
            size="icon"
            onClick={() => clearMutation.mutate()}
            disabled={clearMutation.isPending || total === 0}
            className="size-7"
            aria-label={t('history.actions.clear')}
          >
            <X className="size-3.5" />
          </Button></Tooltip>
        </div>
      </div>

      {historyQuery.isLoading && <p className="text-xs text-muted-foreground">{t('history.loading')}</p>}
      {historyQuery.isError && <p role="alert" className="text-xs text-destructive">{t('tasks.output.historyUnavailable')}</p>}
      {!historyQuery.isLoading && !historyQuery.isError && records.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-8 text-xs text-muted-foreground">
          <Inbox className="size-7 opacity-50" />
          <p>{t(pageRecords.length ? 'tasks.output.inCurrentTasks' : 'history.empty')}</p>
        </div>
      )}
      {records.map((r) => (
        <HistoryCard
          key={String(r.id)}
          record={r}
          pyramidProgress={pyramidProgress.get(String(r.id))}
          onDeleted={handleRecordDeleted}
        />
      ))}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between border-t pt-2 text-xs">
          <span className="text-muted-foreground">
            {t('history.labels.page', { page, total: totalPages })}
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || historyQuery.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              className="h-7 text-xs"
            >
              {t('history.actions.previous')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages || historyQuery.isFetching}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              className="h-7 text-xs"
            >
              {t('history.actions.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
