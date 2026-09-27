import { trackProductEvent, type EventName } from './product-analytics'

type BrowserPlanMetrics = {
  zoom: number
  tiles: number
  clipGeometry?: unknown
}

export function browserMetrics(plan: BrowserPlanMetrics, initiator: 'page' | 'webmcp') {
  return {
    zoom_band: plan.zoom <= 5 ? '0-5' : plan.zoom <= 10 ? '6-10' : plan.zoom <= 15 ? '11-15' : '16-22',
    tile_band: plan.tiles <= 16 ? '1-16' : plan.tiles <= 64 ? '17-64' : plan.tiles <= 256 ? '65-256' : '257+',
    clipped: plan.clipGeometry ? 'yes' : 'no',
    initiator,
  }
}

export function trackBrowserEvent(event: EventName, plan: BrowserPlanMetrics, initiator: 'page' | 'webmcp', reason?: string) {
  void trackProductEvent(event, {
    ...browserMetrics(plan, initiator),
    ...(reason ? { reason } : {}),
  })
}
