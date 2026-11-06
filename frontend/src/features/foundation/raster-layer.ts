import L from 'leaflet'
import {
  cancelFoundation,
  fetchFoundationRaster,
  foundationErrorKey,
  type RasterConfig,
} from './foundation-api'

export interface RasterStatus {
  loaded: number
  pending: number
  failed: number
  cached: number
  fontMissing: boolean
  error: string | null
}
interface TileJob {
  tile: HTMLImageElement
  coords: L.Coords
  done: L.DoneCallback
  requestId: string
  phase: 'queued' | 'loading' | 'loaded' | 'failed'
  native: boolean
  cached: boolean
  fontMissing: boolean
  error: string | null
}

/** Ordinary image tiles only: no feature collections, Canvas, markers or text layout in the WebView. */
export class FoundationRasterLayer extends L.GridLayer {
  private jobs = new Map<HTMLImageElement, TileJob>()
  private queue: TileJob[] = []
  private active = 0
  private closed = false
  private config: RasterConfig
  private proxy: () => Promise<string | null>
  private changed: (status: RasterStatus) => void
  constructor(
    config: RasterConfig,
    proxy: () => Promise<string | null>,
    changed: (status: RasterStatus) => void,
  ) {
    super({
      tileSize: 512,
      pane: 'geod-foundation',
      minZoom: 8,
      maxZoom: 22,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1,
      noWrap: true,
      bounds: L.latLngBounds([-85.05112878, -180], [85.05112878, 180]),
    })
    this.config = config
    this.proxy = proxy
    this.changed = changed
    this.on('tileunload', (event: L.TileEvent) => {
      const tile = event.tile as HTMLImageElement,
        job = this.jobs.get(tile)
      if (!job) return
      this.jobs.delete(tile)
      tile.onload = null
      tile.onerror = null
      tile.removeAttribute('src')
      if (job.native) void cancelFoundation(job.requestId)
      this.publish()
    })
  }
  createTile(coords: L.Coords, done: L.DoneCallback) {
    const tile = document.createElement('img')
    tile.alt = ''
    tile.setAttribute('role', 'presentation')
    tile.dataset.foundationRaster = 'true'
    const job: TileJob = {
      tile,
      coords,
      done,
      requestId: crypto.randomUUID(),
      phase: 'queued',
      native: false,
      cached: false,
      fontMissing: false,
      error: null,
    }
    this.jobs.set(tile, job)
    this.queue.push(job)
    this.publish()
    this.pump()
    return tile
  }
  private publish() {
    if (this.closed) return
    const jobs = [...this.jobs.values()]
    this.changed({
      loaded: jobs.filter((j) => j.phase === 'loaded').length,
      pending: jobs.filter((j) => j.phase === 'queued' || j.phase === 'loading')
        .length,
      failed: jobs.filter((j) => j.phase === 'failed').length,
      cached: jobs.filter((j) => j.cached).length,
      fontMissing: jobs.some((j) => j.fontMissing),
      error: jobs.find((j) => j.error)?.error ?? null,
    })
  }
  private fail(job: TileJob, error: unknown) {
    if (this.closed || !this.jobs.has(job.tile)) return
    job.tile.onload = null
    job.tile.onerror = null
    job.tile.removeAttribute('src')
    job.tile.style.visibility = 'hidden'
    job.phase = 'failed'
    job.native = false
    job.error = foundationErrorKey(error)
    job.done(new Error('Reference raster tile failed'), job.tile)
    this.publish()
  }
  private pump() {
    while (!this.closed && this.active < 3 && this.queue.length) {
      const job = this.queue.shift()!
      if (!this.jobs.has(job.tile)) continue
      this.active++
      job.phase = 'loading'
      void this.proxy()
        .then(async (proxy) => {
          if (this.closed || !this.jobs.has(job.tile)) return
          job.native = true
          const value = await fetchFoundationRaster(
            job.requestId,
            this.config,
            job.coords,
            proxy,
          )
          job.native = false
          if (this.closed || !this.jobs.has(job.tile)) return
          if (
            !value.data_url.startsWith('data:image/png;base64,') ||
            value.data_url.length > 6 * 1024 * 1024
          )
            throw Error('FOUNDATION_RESPONSE: invalid raster image')
          job.cached = value.cache_hit
          job.fontMissing = !value.font_available
          job.tile.onload = () => {
            if (this.closed || !this.jobs.has(job.tile)) return
            job.phase = 'loaded'
            job.done(undefined, job.tile)
            this.publish()
          }
          job.tile.onerror = () =>
            this.fail(job, 'FOUNDATION_RESPONSE: invalid PNG')
          job.tile.src = value.data_url
        })
        .catch((error) => this.fail(job, error))
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
  onRemove(map: L.Map) {
    this.closed = true
    for (const job of this.jobs.values()) {
      if (job.native) void cancelFoundation(job.requestId)
      job.tile.onload = null
      job.tile.onerror = null
    }
    this.queue = []
    this.jobs.clear()
    return super.onRemove(map)
  }
}
