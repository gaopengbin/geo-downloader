function outputZoomLabel(zooms: readonly number[] = []) {
  const levels = [...new Set(zooms)].sort((a, b) => a - b)
  const ranges: string[] = []
  for (let i = 0; i < levels.length; i++) {
    const start = levels[i]
    while (levels[i + 1] === levels[i] + 1) i++
    ranges.push(start === levels[i] ? `z${start}` : `z${start}–z${levels[i]}`)
  }
  return ranges.length ? ranges.join(', ') : undefined
}

// Collapse only known auto-name patterns. Different imagery dates and custom
// names must keep their separate source line.
export function getTaskHeading(title: string, source?: string, zoom?: number, outputZooms?: readonly number[]) {
  const level = typeof zoom === 'number' && zoom > 0 ? `z${zoom}` : undefined
  const suffix = /^(.*?)[ _](z\d+(?:[~,-]z?\d+)*)$/i.exec(title.trim())
  const stem = suffix?.[1] ?? title.trim()
  const sourceName = source?.trim()
  const earth = /^Google Earth (\d{4}-\d{2}-\d{2})$/.exec(stem)
  const sameEarth = Boolean(earth && sourceName &&
    [`Google Earth 历史影像 ${earth[1]}`, `Google Earth Historical Imagery ${earth[1]}`].some(name => name.toLowerCase() === sourceName.toLowerCase()))
  const sameWayback = /^Wayback \d{4}-\d{2}-\d{2}$/.test(stem) && sourceName === `Esri ${stem}`
  const matchesLevel = !suffix || !level || Number(suffix[2].match(/\d+/)?.[0]) === zoom
  const identical = title.trim() === sourceName
  const repeated = Boolean(identical || (matchesLevel && sourceName && (stem === sourceName || sameEarth || sameWayback)))
  return {
    title: repeated && !identical ? stem : title,
    source: repeated ? undefined : source,
    level: outputZoomLabel(outputZooms) ?? (repeated && !identical ? suffix?.[2] ?? level : level),
  }
}
