import L from 'leaflet'
import type { Geometry, GeoJsonProperties } from 'geojson'
import { featureLabel } from './model'
import { wgsToGcj } from './coordinates'
import { forEachFrame } from './frame-batch'

export interface LabelCandidate {
  geometry: Geometry
  properties: GeoJsonProperties
}

/** One canvas replaces hundreds of Tooltip DOM nodes and their synchronous layout reads. */
export function createFoundationLabels(map: L.Map, pane: HTMLElement) {
  const canvas = L.DomUtil.create(
    'canvas',
    'leaflet-layer leaflet-zoom-hide',
    pane,
  )
  canvas.style.pointerEvents = 'none'
  canvas.setAttribute('aria-hidden', 'true')
  canvas.dataset.foundationLabels = '0'
  const context = canvas.getContext('2d')
  let pixelWidth = 0,
    pixelHeight = 0
  let generation = 0
  const widths = new Map<string, number>()
  return {
    cancel: () => {
      generation++
    },
    remove: () => {
      generation++
      canvas.remove()
    },
    async draw(
      candidates: Iterable<LabelCandidate>,
      fontSize: number,
      shifted: boolean,
      report: (durationMs: number, labels: number) => void,
    ) {
      if (!context) return 0
      const current = ++generation,
        started = performance.now()
      const size = map.getSize(),
        ratio = Math.min(devicePixelRatio || 1, 2)
      const width = Math.ceil(size.x * ratio),
        height = Math.ceil(size.y * ratio)
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
      if (pixelWidth !== width || pixelHeight !== height) {
        canvas.width = pixelWidth = width
        canvas.height = pixelHeight = height
        canvas.style.width = `${size.x}px`
        canvas.style.height = `${size.y}px`
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, size.x, size.y)
      const font = `600 ${fontSize}px ${getComputedStyle(map.getContainer()).fontFamily}`
      context.font = font
      context.textAlign = 'center'
      context.textBaseline = 'alphabetic'
      context.lineJoin = 'round'
      context.lineWidth = 3
      context.strokeStyle = '#ffffff'
      context.fillStyle = '#17212c'
      const occupied = new Set<string>(),
        view = map.getBounds()
      let count = 0
      report(performance.now() - started, 0)
      await forEachFrame(
        [...candidates],
        (candidate) => {
          const text = featureLabel(candidate.properties)
          if (!text || !('coordinates' in candidate.geometry)) return
          let point: L.LatLng | undefined
          function find(value: unknown) {
            if (point || !Array.isArray(value)) return
            if (typeof value[0] === 'number' && typeof value[1] === 'number') {
              const [x, y] = shifted
                ? wgsToGcj(value[0], value[1])
                : [value[0], value[1]]
              const p = L.latLng(y, x)
              if (view.contains(p)) point = p
            } else
              for (const child of value) {
                find(child)
                if (point) break
              }
          }
          find(candidate.geometry.coordinates)
          if (!point) return
          const pixel = map.latLngToContainerPoint(point)
          const key = font + ':' + text
          let width = widths.get(key)
          if (width === undefined) {
            width = context.measureText(text).width
            if (widths.size >= 8192) widths.clear()
            widths.set(key, width)
          }
          const halfWidth = width / 2 + 4
          const baseline = pixel.y - 6
          const cells: string[] = []
          for (
            let x = Math.floor((pixel.x - halfWidth) / 32);
            x <= Math.floor((pixel.x + halfWidth) / 32);
            x++
          ) {
            for (
              let y = Math.floor((baseline - fontSize - 4) / 24);
              y <= Math.floor((baseline + 4) / 24);
              y++
            )
              cells.push(`${x}:${y}`)
          }
          if (cells.some((key) => occupied.has(key))) return
          cells.forEach((key) => occupied.add(key))
          context.strokeText(text, pixel.x, baseline)
          context.fillText(text, pixel.x, baseline)
          count++
        },
        () => current !== generation || count >= 250,
        {
          nextFrame: () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
          now: () => performance.now(),
          report: (durationMs) => {
            if (current === generation) {
              canvas.dataset.foundationLabels = String(count)
              report(durationMs, count)
            }
          },
        },
      )
      if (current === generation)
        canvas.dataset.foundationLabels = String(count)
      return count
    },
  }
}
