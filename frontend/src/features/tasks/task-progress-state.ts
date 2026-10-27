import type { TaskInfo } from '@/types/api'

export class TaskProgressState {
  private snapshots = new Map<string, { task: TaskInfo; received: number }>()
  private removed = new Set<string>()
  private sequence = 0
  checkpoint() { return this.sequence }
  remember(task: TaskInfo) {
    if (this.removed.has(task.id)) return
    const previous = this.snapshots.get(task.id)
    if (previous && ((previous.task.revision ?? 0) > (task.revision ?? 0) || (!!task.revision && previous.task.revision === task.revision))) return
    this.snapshots.delete(task.id)
    this.snapshots.set(task.id, { task, received: ++this.sequence })
    if (this.snapshots.size > 2048) this.snapshots.delete(this.snapshots.keys().next().value!)
  }
  forget(id: string) {
    this.snapshots.delete(id)
    this.removed.add(id)
    if (this.removed.size > 2048) this.removed.delete(this.removed.values().next().value!)
  }
  upsert(current: TaskInfo[] | undefined, task: TaskInfo) {
    this.remember(task)
    const next = this.snapshots.get(task.id)?.task
    if (!next) return current ?? []
    const rows = current ?? []
    const exists = rows.some((row) => row.id === next.id)
    return exists ? rows.map((row) => row.id === next.id && (row.revision ?? 0) <= (next.revision ?? 0) ? next : row) : [...rows, next]
  }
  reconcile(incoming: TaskInfo[], startedAt: number) {
    const result = incoming.filter((task) => !this.removed.has(task.id)).map((task) => {
      const latest = this.snapshots.get(task.id)?.task
      const chosen = latest && (latest.revision ?? 0) > (task.revision ?? 0) ? latest : task
      this.remember(chosen)
      return chosen
    })
    const ids = new Set(result.map((task) => task.id))
    for (const { task, received } of this.snapshots.values()) {
      if (!ids.has(task.id) && received > startedAt && !this.removed.has(task.id)) result.push(task)
    }
    return result
  }
}
export const taskProgressState = new TaskProgressState()
