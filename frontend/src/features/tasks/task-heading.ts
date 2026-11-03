// Collapse only known auto-name patterns. Different imagery dates and custom
// names must keep their separate source line.
export function getTaskHeading(title: string, source?: string, zoom?: number) {
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
    level: repeated && !identical ? suffix?.[2] ?? level : level,
  }
}
