export function updateRangeSelection(
  selected: ReadonlySet<number>,
  index: number,
  anchor: number | null,
): Set<number> {
  const next = new Set(selected)

  if (anchor == null || anchor === index) {
    if (next.has(index)) next.delete(index)
    else next.add(index)
    return next
  }

  const start = Math.min(anchor, index)
  const end = Math.max(anchor, index)
  const shouldSelect = !next.has(index)
  for (let current = start; current <= end; current += 1) {
    if (shouldSelect) next.add(current)
    else next.delete(current)
  }
  return next
}

/** Apply Shift range selection using the currently visible/sorted row order. */
export function updateOrderedRangeSelection(
  selected: ReadonlySet<number>,
  index: number,
  anchor: number | null,
  order: readonly number[],
): Set<number> {
  if (anchor == null || anchor === index) {
    return updateRangeSelection(selected, index, null)
  }
  const anchorPosition = order.indexOf(anchor)
  const targetPosition = order.indexOf(index)
  if (anchorPosition < 0 || targetPosition < 0) {
    return updateRangeSelection(selected, index, null)
  }
  const next = new Set(selected)
  const shouldSelect = !next.has(index)
  const start = Math.min(anchorPosition, targetPosition)
  const end = Math.max(anchorPosition, targetPosition)
  for (const visibleIndex of order.slice(start, end + 1)) {
    if (shouldSelect) next.add(visibleIndex)
    else next.delete(visibleIndex)
  }
  return next
}
