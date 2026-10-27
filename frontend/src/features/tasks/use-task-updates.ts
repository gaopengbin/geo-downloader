import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauriRuntime } from '@/lib/tauri'
import type { TaskInfo } from '@/types/api'
import { taskProgressState } from './task-progress-state'

export function useTaskUpdates() {
  const client = useQueryClient()
  useEffect(() => {
    if (!isTauriRuntime()) return
    let closed = false
    let unlisten: UnlistenFn | undefined
    void listen<TaskInfo>('task-updated', ({ payload }) => {
      client.setQueryData<TaskInfo[]>(['active-tasks'], (current) => taskProgressState.upsert(current, payload))
    }).then((stop) => { if (closed) stop(); else unlisten = stop }).catch(() => {})
    return () => { closed = true; unlisten?.() }
  }, [client])
}
