import { useEffect, useMemo, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Inbox,
  ListChecks,
  Pause,
  Play,
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { isTauriRuntime } from '@/lib/tauri'
import {
  cancelTask,
  getActiveTasks,
  removeTask,
  togglePauseTask,
} from '@/features/tasks/tasks-api'
import type { TaskInfo, TaskStatus } from '@/types/api'

const ACTIVE_STATES: TaskStatus[] = [
  'pending',
  'downloading',
  'merging',
  'processing',
  'exporting',
]
const FINISHED_STATES: TaskStatus[] = ['completed', 'failed', 'cancelled']

function isActive(s: string): boolean {
  return ACTIVE_STATES.includes(s as TaskStatus) || s === 'paused'
}

function isFinished(s: string): boolean {
  return FINISHED_STATES.includes(s as TaskStatus)
}

function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (s === 'completed') return 'default'
  if (s === 'failed' || s === 'cancelled') return 'destructive'
  if (s === 'paused') return 'outline'
  return 'secondary'
}

function statusLabel(s: string): string {
  switch (s) {
    case 'pending':
      return '排队中'
    case 'downloading':
      return '下载中'
    case 'paused':
      return '已暂停'
    case 'merging':
      return '合并中'
    case 'processing':
      return '处理中'
    case 'exporting':
      return '导出中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return s
  }
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

function TaskRow({ task }: { task: TaskInfo }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['active-tasks'] })

  const pauseMutation = useMutation({
    mutationFn: () => togglePauseTask(task.id),
    onSuccess: refresh,
    onError: (e) => toast.error(`操作失败：${String(e)}`),
  })
  const cancelMutation = useMutation({
    mutationFn: () => cancelTask(task.id),
    onSuccess: () => {
      toast.success('任务已取消')
      refresh()
    },
    onError: (e) => toast.error(`取消失败：${String(e)}`),
  })
  const removeMutation = useMutation({
    mutationFn: () => removeTask(task.id),
    onSuccess: refresh,
    onError: (e) => toast.error(`删除失败：${String(e)}`),
  })

  const status = String(task.status)
  const progress = typeof task.progress === 'number' ? task.progress : 0
  const total = task.total ?? 0
  const completed = task.completed ?? 0

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate font-medium" title={task.name}>
          {task.name}
        </span>
        <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>
        {task.source_name && (
          <Badge variant="outline" className="font-normal">
            {task.source_name}
          </Badge>
        )}
        {typeof task.zoom === 'number' && (
          <Badge variant="outline" className="font-normal">
            z{task.zoom}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {isActive(status) && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => pauseMutation.mutate()}
                disabled={pauseMutation.isPending}
                title={status === 'paused' ? '恢复' : '暂停'}
              >
                {status === 'paused' ? (
                  <Play className="size-4" />
                ) : (
                  <Pause className="size-4" />
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                title="取消"
              >
                <X className="size-4" />
              </Button>
            </>
          )}
          {isFinished(status) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
              title="移除"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="mt-2 space-y-1">
        <ProgressBar value={progress} />
        <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
          <span>{progress.toFixed(1)}%</span>
          <span>
            {completed.toLocaleString()} / {total.toLocaleString()} 瓦片
          </span>
          {typeof task.failed_count === 'number' && task.failed_count > 0 && (
            <span className="text-destructive">失败 {task.failed_count}</span>
          )}
          {task.file_size != null && task.file_size > 0 && (
            <span>大小 {formatBytes(task.file_size)}</span>
          )}
        </div>
        {task.message && (
          <p className="truncate text-xs text-muted-foreground" title={task.message}>
            {task.message}
          </p>
        )}
        {task.error && (
          <p className="truncate text-xs text-destructive" title={task.error}>
            {task.error}
          </p>
        )}
      </div>
    </div>
  )
}

export function TasksDialog() {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const inTauri = isTauriRuntime()

  const tasksQuery = useQuery({
    queryKey: ['active-tasks'],
    queryFn: getActiveTasks,
    enabled: inTauri,
    refetchInterval: open ? 1500 : 3000,
    refetchIntervalInBackground: true,
  })

  // 监听全局任务进度事件，触发列表刷新（事件名是按 task_id 区分的，这里直接靠 polling）
  // 同时订阅一个聚合事件占位，留给后端将来扩展
  useEffect(() => {
    if (!inTauri) return
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    listen('task-list-updated', () => {
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
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
  const activeCount = useMemo(
    () => tasks.filter((t) => isActive(String(t.status))).length,
    [tasks],
  )
  const finishedCount = useMemo(
    () => tasks.filter((t) => isFinished(String(t.status))).length,
    [tasks],
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="relative" disabled={!inTauri}>
          <ListChecks className="mr-1.5 size-4" />
          任务
          {activeCount > 0 && (
            <Badge
              variant="default"
              className="ml-1.5 h-5 min-w-[1.25rem] px-1.5 text-[10px]"
            >
              {activeCount}
            </Badge>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            任务面板
            <Button
              variant="ghost"
              size="sm"
              onClick={() => tasksQuery.refetch()}
              disabled={tasksQuery.isFetching}
            >
              <RefreshCw className={`size-4 ${tasksQuery.isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </DialogTitle>
          <DialogDescription>
            活动 {activeCount} · 已结束 {finishedCount} · 总计 {tasks.length}
          </DialogDescription>
        </DialogHeader>
        <Separator />
        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {tasksQuery.isLoading && (
            <p className="text-sm text-muted-foreground">加载中...</p>
          )}
          {!tasksQuery.isLoading && tasks.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
              <Inbox className="size-8 opacity-50" />
              <p>暂无任务</p>
            </div>
          )}
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
