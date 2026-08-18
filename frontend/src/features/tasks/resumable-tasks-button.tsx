import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { isTauriRuntime } from '@/lib/tauri'
import { getResumableTasks } from '@/features/tasks/tasks-api'
import { useAppStore } from '@/store/app-store'

/** 标题栏的"可恢复任务"入口：显示徽标，点击跳到任务面板。 */
export function ResumableTasksButton() {
  const { t } = useTranslation()
  const inTauri = isTauriRuntime()
  const setTab = useAppStore((s) => s.setTab)

  const query = useQuery({
    queryKey: ['resumable-tasks'],
    queryFn: getResumableTasks,
    enabled: inTauri,
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  })

  const count = query.data?.length ?? 0
  if (!inTauri || count === 0) return null

  return (
    <Button
      data-tour="resumable-tasks"
      variant="ghost"
      size="sm"
      className="relative h-8 gap-1 px-2 text-xs"
      title={t('tasks.resumableTitle', { count })}
      onClick={() => setTab('history')}
    >
      <History className="size-3.5" />
      <span className="font-semibold">{count}</span>
      <span className="absolute -right-0.5 -top-0.5 flex size-2 rounded-full bg-amber-500 ring-2 ring-background" />
    </Button>
  )
}
