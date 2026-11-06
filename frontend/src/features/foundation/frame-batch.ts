export interface FrameBatchHost {
  nextFrame: () => Promise<void>
  now: () => number
  report?: (durationMs: number, count: number) => void
}

/** Yield before adding geometry and between bounded batches; cancellation also applies while queued. */
export async function forEachFrame<T>(
  items: readonly T[],
  visit: (item: T) => void,
  cancelled: () => boolean,
  host: FrameBatchHost,
): Promise<boolean> {
  let index = 0
  while (index < items.length) {
    if (cancelled()) return false
    await host.nextFrame()
    if (cancelled()) return false
    const started = host.now()
    let count = 0
    do {
      visit(items[index++])
      count++
    } while (
      index < items.length &&
      count < 128 &&
      host.now() - started < 4 &&
      !cancelled()
    )
    host.report?.(host.now() - started, count)
  }
  return !cancelled()
}
