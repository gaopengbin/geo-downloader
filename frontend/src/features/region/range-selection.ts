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
