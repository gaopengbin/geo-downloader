import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ask as askDialog } from '@tauri-apps/plugin-dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Download,
  Inbox,
  Pause,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { TaskCardHeading } from './task-card-heading'
import { isTauriRuntime } from '@/lib/tauri'
import {
  cancelTask,
  discardResumableTask,
  exportPartialTask,
  getActiveTasks,
  getResumableTasks,
  getTaskLogs,
  removeTask,
  resumeTask,
  togglePauseTask,
} from '@/features/tasks/tasks-api'
import { getTaskErrorMessage, getTaskMessage, getTaskStatusKey } from '@/features/tasks/task-copy'
import { useTaskUpdates } from '@/features/tasks/use-task-updates'
import { isTaskResultVisible } from './task-results'
import { OutputLocation } from './output-location'
import type { PersistedTask, TaskInfo, TaskLog, TaskStatus } from '@/types/api'

const ACTIVE_STATES: TaskStatus[] = [
  'pending',
  'preparing',
  'downloading',
  'merging',
  'processing',
  'exporting',
  'building_pyramid',
]
// Terminal states govern timing/actions, not visibility. Failure and OSM-result
// retention is deliberately handled by isTaskResultVisible below.
const FINISHED_STATES: TaskStatus[] = ['completed', 'failed', 'cancelled']

function isActive(s: string): boolean {
  return ACTIVE_STATES.includes(s as TaskStatus) || s === 'paused' || s === 'pending_decision'
}
function isFinished(s: string): boolean {
  return FINISHED_STATES.includes(s as TaskStatus)
}
function isCompletedWithGaps(s: string): boolean {
  return s === 'completed_with_gaps'
}

function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (s === 'completed') return 'default'
  if (s === 'failed' || s === 'cancelled') return 'destructive'
  if (s === 'paused' || s === 'pending_decision' || s === 'completed_with_gaps') return 'outline'
  return 'secondary'
}

/**
 * Issue #31：按缺块比例返回 Tailwind 文字 / 边框色（绿黄橙红四档）。
 * < 1% 绿，1-10% 黄，10-50% 橙，> 50% 红。
 */
function gapBadgeClasses(failedRatio: number): string {
  if (failedRatio <= 0.01) {
    return 'border-emerald-500/50 text-emerald-700 dark:text-emerald-400'
  }
  if (failedRatio <= 0.1) {
    return 'border-amber-500/50 text-amber-700 dark:text-amber-400'
  }
  if (failedRatio <= 0.5) {
    return 'border-orange-500/50 text-orange-700 dark:text-orange-400'
  }
  return 'border-red-500/50 text-red-700 dark:text-red-400'
}

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

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full bg-primary transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// 任务起始时间记录（任务首次出现时锚定）
const taskStartTimes = new Map<string, number>()

function getStartTime(taskId: string): number {
  const cached = taskStartTimes.get(taskId)
  if (cached) return cached
  const now = Date.now()
  taskStartTimes.set(taskId, now)
  return now
}

function TaskLogPanel({ taskId }: { taskId: string }) {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<TaskLog[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inTauri = isTauriRuntime()

  // 初次拉取已有日志
  useEffect(() => {
    if (!inTauri) return
    let cancelled = false
    getTaskLogs(taskId)
      .then((arr) => {
        if (!cancelled) setLogs(arr.slice(-500))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [inTauri, taskId])

  // 实时追加
  useEffect(() => {
    if (!inTauri) return
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    listen<TaskLog>(`task-log-${taskId}`, (e) => {
      setLogs((prev) => {
        const next = [...prev, e.payload]
        return next.length > 500 ? next.slice(-500) : next
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
  }, [inTauri, taskId])

  // 自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  const onCopy = useCallback(async () => {
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
          {t('tasks.logs.title')} ({logs.length})
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCopy}
          className="h-6 gap-1 px-2 text-xs"
          disabled={logs.length === 0}
        >
          <ClipboardCopy className="size-3" />
          {t('tasks.logs.copy')}
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="max-h-48 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]"
      >
        {logs.length === 0 ? (
          <p className="text-muted-foreground">{t('tasks.logs.empty')}</p>
        ) : (
          logs.map((l, i) => {
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
          })
        )}
      </div>
    </div>
  )
}

function TaskRow({
  task,
  selected,
  onSelectedChange,
  selectionDisabled,
}: {
  task: TaskInfo
  selected: boolean
  onSelectedChange: (checked: boolean) => void
  selectionDisabled?: boolean
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['active-tasks'] })
    qc.invalidateQueries({ queryKey: ['resumable-tasks'] })
  }
  const [showLogs, setShowLogs] = useState(false)
  const [elapsed, setElapsed] = useState<number>(0)
  const status = String(task.status)
  const statusKey = getTaskStatusKey(status)
  const locale = i18n.resolvedLanguage ?? i18n.language

  // 计时器：活动状态时滚动；暂停 / 结束后冻结当前时长
  useEffect(() => {
    const start = getStartTime(task.id)
    const status = String(task.status)
    const update = () => setElapsed(Date.now() - start)
    if (isFinished(status) || status === 'paused' || status === 'pending_decision') {
      const timeoutId = window.setTimeout(update, 0)
      return () => window.clearTimeout(timeoutId)
    }
    const timeoutId = window.setTimeout(update, 0)
    const id = setInterval(update, 1000)
    return () => {
      window.clearTimeout(timeoutId)
      clearInterval(id)
    }
  }, [task.id, task.status])

  const pauseMutation = useMutation({
    mutationFn: () => togglePauseTask(task.id),
    onSuccess: refresh,
    onError: (e) => toast.error(t('tasks.toast.operationError', { message: String(e) })),
  })
  const deleteMutation = useMutation({
    mutationFn: async () => {
      const ok = await askDialog(
        t('tasks.confirm.deleteTask'),
        { title: t('tasks.confirm.deleteTitle'), kind: 'warning' },
      )
      if (!ok) return false

      if (isCompletedWithGaps(status) || isFinished(status)) {
        await removeTask(task.id)
      } else {
        await cancelTask(task.id)
        if (status === 'pending_decision') {
          await discardResumableTask(task.id, true)
        }
      }
      return true
    },
    onSuccess: (changed) => {
      if (!changed) return
      taskStartTimes.delete(task.id)
      toast.success(t('tasks.toast.deleted'))
      refresh()
    },
    onError: (e) => toast.error(t('tasks.toast.deleteError', { message: String(e) })),
  })
  // Issue #31：强制按现状导出（paused 待决策时使用）
  const exportPartialMutation = useMutation({
    mutationFn: () => exportPartialTask(task.id),
    onSuccess: () => {
      toast.success(t('tasks.toast.partialStarted'))
      refresh()
    },
    onError: (e) => toast.error(t('tasks.toast.partialError', { message: String(e) })),
  })
  // Issue #31：补漏重导（completed_with_gaps 时使用，复用 resumeTask 触发增量补下载）
  const resumeMutation = useMutation({
    mutationFn: () => resumeTask(task.id),
    onSuccess: () => {
      toast.success(t('tasks.toast.retryStarted'))
      refresh()
    },
    onError: (e) => toast.error(t('tasks.toast.retryError', { message: String(e) })),
  })

  const progress = typeof task.progress === 'number' ? task.progress : 0
  const total = task.total ?? 0
  const completed = task.completed ?? 0
  const failedCount = task.failed_count ?? 0
  // Issue #31：缺块比例（仅在 completed_with_gaps 状态展示徽章用）
  const gapsRatio = total > 0 ? failedCount / total : 0
  const showGapBadge = isCompletedWithGaps(status) && failedCount > 0

  return (
    <div role="group" aria-label={task.name} data-task-id={task.id} className="min-w-0 rounded-md border p-3 text-sm">
      <TaskCardHeading title={task.name} source={task.source_name} zoom={task.zoom}
        statusTitle={statusKey ? t(statusKey) : status}
        status={<Badge variant={statusVariant(status)}>{statusKey ? t(statusKey) : status}</Badge>}
        selection={<Checkbox checked={selected} onChange={(event) => onSelectedChange(event.currentTarget.checked)}
          disabled={selectionDisabled} aria-label={t('tasks.labels.select', { name: task.name })}/>}/>
      <div className="mt-2 space-y-2">
        <ProgressBar value={progress} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
          <span className="whitespace-nowrap">{progress.toFixed(1)}%</span>
          {total > 0 && <span className="whitespace-nowrap">
            {completed.toLocaleString(locale)} / {total.toLocaleString(locale)}
          </span>}
          {typeof task.failed_count === 'number' && task.failed_count > 0 && (
            <span className="text-destructive">
              {t('tasks.labels.failed', { count: task.failed_count })}
            </span>
          )}
          {task.file_size != null && task.file_size > 0 && (
            <span className="whitespace-nowrap">{formatBytes(task.file_size)}</span>
          )}
          <span className="whitespace-nowrap" title={t('tasks.labels.elapsed')}>{t('tasks.labels.elapsed')} {formatElapsed(elapsed)}</span>
          {showGapBadge && <Badge variant="outline" className={`px-1.5 py-0 text-[11px] ${gapBadgeClasses(gapsRatio)}`}
            title={t('tasks.labels.gaps', { failed: failedCount, total })}>{t('tasks.labels.gapsPercent', { percent: (gapsRatio * 100).toFixed(gapsRatio < 0.01 ? 2 : 1) })}</Badge>}
        </div>
        {task.message && (status !== 'failed' || !task.error) && (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]" title={getTaskMessage(task, t)}>
            {getTaskMessage(task, t)}
          </p>
        )}
        {task.error && (
          <p className="line-clamp-2 whitespace-pre-wrap text-xs leading-relaxed text-destructive [overflow-wrap:anywhere]" title={task.error}>
            {getTaskErrorMessage(task.error, t)}
          </p>
        )}
        {task.save_path && <OutputLocation path={task.save_path}
          saved={status === 'completed' || status === 'completed_with_gaps'} strictFile={task.source === 'osm_vector'}/>}
      </div>
      <div data-task-card-actions className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-t pt-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowLogs((v) => !v)}
            className="h-auto min-h-7 min-w-0 max-w-full gap-1 whitespace-normal px-2 py-1 text-xs"
            title={showLogs ? t('tasks.actions.hideLogs') : t('tasks.actions.viewLogs')}
          >
            {showLogs ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            {t('history.actions.logs')}
          </Button>
          {isActive(status) && (
            <>
              {(status === 'pending' || status === 'preparing' || status === 'downloading' || status === 'paused') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => pauseMutation.mutate()}
                  disabled={pauseMutation.isPending}
                  className="h-auto min-h-7 min-w-0 max-w-full gap-1 whitespace-normal px-2 py-1 text-xs"
                  title={status === 'paused' ? t('tasks.actions.resume') : t('tasks.actions.pause')}
                >
                  {status === 'paused' ? (
                    <Play className="size-3.5" />
                  ) : (
                    <Pause className="size-3.5" />
                  )}
                  {status === 'paused' ? t('tasks.actions.resume') : t('tasks.actions.pause')}
                </Button>
              )}
              {/* Issue #31：待决策态加「补漏重试」入口（仅下载缺失瓦片） */}
              {status === 'pending_decision' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => resumeMutation.mutate()}
                  disabled={resumeMutation.isPending}
                  className="h-auto min-h-7 min-w-0 max-w-full gap-1 whitespace-normal px-2 py-1 text-xs"
                  title={t('tasks.actions.retryMissing')}
                >
                  <RefreshCw className="size-3.5" />{t('tasks.actions.retryMissing')}
                </Button>
              )}
              {/* Issue #31：暂停 / 待决策态加「强制按现状导出」入口 */}
              {(status === 'paused' || status === 'pending_decision') && !task.preparation && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => exportPartialMutation.mutate()}
                  disabled={exportPartialMutation.isPending}
                  className="h-auto min-h-7 min-w-0 max-w-full gap-1 whitespace-normal px-2 py-1 text-xs"
                  title={t('tasks.actions.exportPartial')}
                >
                  <Download className="size-3.5" />{t('tasks.actions.exportPartial')}
                </Button>
              )}
            </>
          )}
          {isCompletedWithGaps(status) && (
            <>
              {/* Issue #31：补漏重导（resume_task 增量下载缺失瓦片） */}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => resumeMutation.mutate()}
                disabled={resumeMutation.isPending}
                className="h-auto min-h-7 min-w-0 max-w-full gap-1 whitespace-normal px-2 py-1 text-xs"
                title={t('tasks.actions.retryAndReplace')}
              >
                <RefreshCw className="size-3.5" />{t('tasks.actions.retryAndReplace')}
              </Button>
            </>
          )}

        </div>
        <div className="shrink-0">
          {(isActive(status) || isCompletedWithGaps(status) || isFinished(status)) && (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              title={t('tasks.actions.deleteTask')} aria-label={t('tasks.actions.deleteTask')}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {showLogs && <TaskLogPanel taskId={task.id} />}
    </div>
  )
}

function ResumableRow({
  task,
  selected,
  onSelectedChange,
  selectionDisabled,
}: {
  task: PersistedTask
  selected: boolean
  onSelectedChange: (checked: boolean) => void
  selectionDisabled?: boolean
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()

  const resumeMutation = useMutation({
    mutationFn: () => resumeTask(task.task_id),
    onSuccess: (res) => {
      toast.success(t('tasks.toast.restored', { id: res.task_id.slice(0, 8) }))
      qc.invalidateQueries({ queryKey: ['resumable-tasks'] })
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
    },
    onError: (e) => toast.error(t('tasks.toast.restoreError', { message: String(e) })),
  })

  const discardMutation = useMutation({
    mutationFn: async () => {
      const ok = await askDialog(t('tasks.confirm.discardTask'), {
        title: t('tasks.confirm.discardTitle'),
        kind: 'warning',
      })
      if (!ok) return false
      // 第二步：是否同时删除已下载的瓦片缓存
      const deleteCache = await askDialog(
        t('tasks.confirm.cleanCache'),
        {
          title: t('tasks.confirm.cleanCacheTitle'),
          kind: 'warning',
        },
      )
      await discardResumableTask(task.task_id, deleteCache)
      return true
    },
    onSuccess: (changed) => {
      if (changed) qc.invalidateQueries({ queryKey: ['resumable-tasks'] })
    },
    onError: (e) => toast.error(t('tasks.toast.discardError', { message: String(e) })),
  })

  return (
    <div role="group" aria-label={task.task_name} data-resumable-id={task.task_id} className="min-w-0 rounded-md border p-3 text-sm">
      <TaskCardHeading title={task.task_name} source={task.source_name} zoom={task.request?.zoom}
        statusTitle={t('tasks.labels.interrupted')}
        status={<Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">{t('tasks.labels.interrupted')}</Badge>}
        selection={<Checkbox checked={selected} onChange={(event) => onSelectedChange(event.currentTarget.checked)}
          disabled={selectionDisabled} aria-label={t('tasks.labels.select', { name: task.task_name })}/>}/>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
        <span className="whitespace-nowrap">{t('tasks.labels.tiles', { count: task.tile_count.toLocaleString(i18n.resolvedLanguage ?? i18n.language) })}</span>
        {task.created_at && <span className="max-w-full truncate" title={task.created_at}>{task.created_at}</span>}
      </div>
      <div data-task-card-actions className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
        <Button size="sm" variant="outline" className="h-7 min-w-0 gap-1.5 px-2 text-xs" onClick={() => resumeMutation.mutate()}
          disabled={resumeMutation.isPending}><Play className="size-3.5"/>{t('tasks.actions.continue')}</Button>
        <Button size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => discardMutation.mutate()} disabled={discardMutation.isPending}
          title={t('tasks.actions.deleteTask')} aria-label={t('tasks.actions.deleteTask')}><Trash2 className="size-3.5"/></Button>
      </div>
    </div>
  )
}

export function TasksPanel() {
  useTaskUpdates()
  const { t } = useTranslation()
  const qc = useQueryClient()
  const inTauri = isTauriRuntime()

  const tasksQuery = useQuery({
    queryKey: ['active-tasks'],
    queryFn: getActiveTasks,
    enabled: inTauri,
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
  })

  const resumableQuery = useQuery({
    queryKey: ['resumable-tasks'],
    queryFn: getResumableTasks,
    enabled: inTauri,
    refetchInterval: 5000,
  })

  useEffect(() => {
    if (!inTauri) return
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    listen('task-list-updated', () => {
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
      qc.invalidateQueries({ queryKey: ['resumable-tasks'] })
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

  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data])
  const resumable = useMemo(() => {
    const inMemoryIds = new Set(tasks.map((task) => task.id))
    return (resumableQuery.data ?? []).filter((task) => !inMemoryIds.has(task.task_id))
  }, [resumableQuery.data, tasks])
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set())
  const runningCount = useMemo(
    () => tasks.filter((t) => ACTIVE_STATES.includes(String(t.status) as TaskStatus)).length,
    [tasks],
  )
  const pausedCount = useMemo(
    () => tasks.filter((t) => String(t.status) === 'paused').length,
    [tasks],
  )
  const finishedCount = useMemo(
    () => tasks.filter((t) => !isTaskResultVisible(t) && String(t.status) === 'completed').length,
    [tasks],
  )
  // Keep failures and actionable OSM outputs; linked history uses task IDs to
  // avoid duplicate cards. A missing history write must not hide the result.
  const visibleTasks = useMemo(
    () => tasks.filter(isTaskResultVisible),
    [tasks],
  )
  const visibleTaskIds = useMemo(() => visibleTasks.map((t) => t.id), [visibleTasks])
  const resumableIds = useMemo(() => resumable.map((t) => t.task_id), [resumable])
  const allTaskIds = useMemo(
    () => [...new Set([...visibleTaskIds, ...resumableIds])],
    [resumableIds, visibleTaskIds],
  )
  const selectedActiveTasks = useMemo(
    () => visibleTasks.filter((t) => selectedTaskIds.has(t.id)),
    [visibleTasks, selectedTaskIds],
  )
  const selectedResumable = useMemo(
    () => resumable.filter((t) => selectedTaskIds.has(t.task_id)),
    [resumable, selectedTaskIds],
  )
  const selectedTaskCount = selectedActiveTasks.length + selectedResumable.length
  const allTasksSelected = allTaskIds.length > 0 && selectedTaskCount === allTaskIds.length
  const selectedPausableCount = useMemo(
    () =>
      selectedActiveTasks.filter((t) => {
        const status = String(t.status)
        return status === 'pending' || status === 'preparing' || status === 'downloading'
      }).length,
    [selectedActiveTasks],
  )
  const selectedContinuableCount = useMemo(
    () =>
      selectedActiveTasks.filter((t) => {
        const status = String(t.status)
        return status === 'paused' || status === 'pending_decision' || isCompletedWithGaps(status)
      }).length + selectedResumable.length,
    [selectedActiveTasks, selectedResumable.length],
  )

  const toggleTaskSelection = useCallback((taskId: string, checked: boolean) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(taskId)
      else next.delete(taskId)
      return next
    })
  }, [])

  const selectAllTasks = useCallback(() => {
    setSelectedTaskIds(new Set(allTaskIds))
  }, [allTaskIds])

  const clearTaskSelection = useCallback(() => {
    setSelectedTaskIds(new Set())
  }, [])

  const invertTaskSelection = useCallback(() => {
    setSelectedTaskIds((prev) => {
      const next = new Set<string>()
      for (const id of allTaskIds) {
        if (!prev.has(id)) next.add(id)
      }
      return next
    })
  }, [allTaskIds])

  const refreshTaskLists = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['resumable-tasks'] })
    qc.invalidateQueries({ queryKey: ['active-tasks'] })
  }, [qc])

  const pauseSelectedMutation = useMutation({
    mutationFn: async () => {
      const targets = selectedActiveTasks.filter((t) => {
        const status = String(t.status)
        return status === 'pending' || status === 'preparing' || status === 'downloading'
      })
      let success = 0
      for (const task of targets) {
        if (await togglePauseTask(task.id)) success += 1
      }
      return success
    },
    onSuccess: (count) => {
      toast.success(t('tasks.toast.pausedSelected', { count }))
      clearTaskSelection()
      refreshTaskLists()
    },
    onError: (e) => {
      toast.error(t('tasks.toast.pauseSelectedError', { message: String(e) }))
      refreshTaskLists()
    },
  })

  const continueSelectedMutation = useMutation({
    mutationFn: async () => {
      const targets = selectedActiveTasks.filter((t) => {
        const status = String(t.status)
        return status === 'paused' || status === 'pending_decision' || isCompletedWithGaps(status)
      })
      let success = 0
      for (const task of targets) {
        const status = String(task.status)
        if (status === 'paused') await togglePauseTask(task.id)
        else await resumeTask(task.id)
        success += 1
      }
      for (const task of selectedResumable) {
        await resumeTask(task.task_id)
        success += 1
      }
      return success
    },
    onSuccess: (count) => {
      toast.success(t('tasks.toast.continuedSelected', { count }))
      clearTaskSelection()
      refreshTaskLists()
    },
    onError: (e) => {
      toast.error(t('tasks.toast.continueSelectedError', { message: String(e) }))
      refreshTaskLists()
    },
  })

  const deleteSelectedMutation = useMutation({
    mutationFn: async () => {
      const ok = await askDialog(t('tasks.confirm.deleteSelected', { count: selectedTaskCount }), {
        title: t('tasks.confirm.deleteSelectedTitle'),
        kind: 'warning',
      })
      if (!ok) return 0

      const deleteCache =
        selectedResumable.length === 0 ||
        (await askDialog(
          t('tasks.confirm.cleanInterruptedCache'),
          { title: t('tasks.confirm.cleanCacheTitle'), kind: 'warning' },
        ))

      let success = 0
      for (const task of selectedActiveTasks) {
        const status = String(task.status)
        if (isCompletedWithGaps(status) || isFinished(status)) {
          await removeTask(task.id)
        } else {
          await cancelTask(task.id)
          if (status === 'pending_decision') {
            await discardResumableTask(task.id, true)
          }
        }
        taskStartTimes.delete(task.id)
        success += 1
      }
      for (const task of selectedResumable) {
        await discardResumableTask(task.task_id, deleteCache)
        success += 1
      }
      return success
    },
    onSuccess: (count) => {
      if (count > 0) {
        toast.success(t('tasks.toast.deletedSelected', { count }))
        clearTaskSelection()
        refreshTaskLists()
      }
    },
    onError: (e) => {
      toast.error(t('tasks.toast.deleteSelectedError', { message: String(e) }))
      refreshTaskLists()
    },
  })

  const isBatching =
    pauseSelectedMutation.isPending ||
    continueSelectedMutation.isPending ||
    deleteSelectedMutation.isPending

  if (!inTauri) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-xs text-muted-foreground">
        {t('tasks.unavailable')}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1">
          <span>{t('tasks.summary.total', { total: allTaskIds.length })}</span>
          <span>·</span>
          <span>{t('tasks.summary.running', { count: runningCount })}</span>
          {pausedCount > 0 && (
            <>
              <span>·</span>
              <span>{t('tasks.summary.paused', { count: pausedCount })}</span>
            </>
          )}
          {resumable.length > 0 && (
            <>
              <span>·</span>
              <span className="font-semibold text-amber-600 dark:text-amber-400">
                {t('tasks.summary.interrupted', { count: resumable.length })}
              </span>
            </>
          )}
          {finishedCount > 0 && (
            <>
              <span>·</span>
              <span>{t('tasks.summary.history', { count: finishedCount })}</span>
            </>
          )}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            tasksQuery.refetch()
            resumableQuery.refetch()
          }}
          disabled={tasksQuery.isFetching}
          className="size-7"
          title={t('tasks.actions.refresh')}
        >
          <RefreshCw className={`size-3.5 ${tasksQuery.isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <div className="space-y-2">
        {allTaskIds.length > 0 && (
          <div data-task-toolbar className="space-y-2">
            <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0 text-xs font-medium text-muted-foreground">
              {t('tasks.summary.selection', {
                selected: selectedTaskCount,
                total: allTaskIds.length,
              })}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={allTasksSelected ? clearTaskSelection : selectAllTasks}
                disabled={isBatching}
                className="h-7 px-2 text-xs"
              >
                {allTasksSelected ? t('tasks.selection.clearAll') : t('tasks.selection.selectAll')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={invertTaskSelection}
                disabled={isBatching}
                className="h-7 px-2 text-xs"
              >
                {t('tasks.selection.invert')}
              </Button>
            </div>
            </div>
            {selectedTaskCount > 0 && <div data-task-bulk-actions className="grid min-w-0 grid-cols-3 gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => pauseSelectedMutation.mutate()}
                disabled={isBatching || selectedPausableCount === 0}
                className="h-8 min-w-0 gap-1 px-1.5 text-xs"
              >
                <Pause className="mr-1 size-3" />
                <span className="truncate">{t('tasks.actions.pause')}</span>
              </Button>
              <Button
                size="sm"
                variant="default"
                onClick={() => continueSelectedMutation.mutate()}
                disabled={isBatching || selectedContinuableCount === 0}
                className="h-8 min-w-0 gap-1 px-1.5 text-xs"
              >
                <Play className="mr-1 size-3" />
                <span className="truncate">{t('tasks.actions.continue')}</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => deleteSelectedMutation.mutate()}
                disabled={isBatching || selectedTaskCount === 0}
                className="h-8 min-w-0 gap-1 px-1.5 text-xs text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="mr-1 size-3" />
                <span className="truncate">{t('tasks.actions.delete')}</span>
              </Button>
            </div>}
          </div>
        )}
        {tasksQuery.isLoading && <p className="text-xs text-muted-foreground">{t('tasks.loading')}</p>}
        {!tasksQuery.isLoading && !resumableQuery.isLoading && allTaskIds.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-xs text-muted-foreground">
            <Inbox className="size-7 opacity-50" />
            <p>{t('tasks.empty')}</p>
            {finishedCount > 0 && (
              <p>{t('tasks.movedToHistory', { count: finishedCount })}</p>
            )}
          </div>
        )}
        {visibleTasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            selected={selectedTaskIds.has(t.id)}
            onSelectedChange={(checked) => toggleTaskSelection(t.id, checked)}
            selectionDisabled={isBatching}
          />
        ))}
        {resumable.map((t) => (
          <ResumableRow
            key={t.task_id}
            task={t}
            selected={selectedTaskIds.has(t.task_id)}
            onSelectedChange={(checked) => toggleTaskSelection(t.task_id, checked)}
            selectionDisabled={isBatching}
          />
        ))}
      </div>
    </div>
  )
}
