export const OSM_STANDARD_SOURCE_ID = 'osm'
export const OSM_TILE_USAGE_POLICY_URL =
  'https://operations.osmfoundation.org/policies/tiles/'
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright'
export const OSM_DOWNLOAD_POLICY_EVENT = 'geod:osm-download-policy'

export type OsmDownloadPolicyDecision = 'continue' | 'switch' | 'cancel'

export class OsmDownloadPolicySession {
  private acknowledged = false

  requiresConfirmation(sourceId: string, sourceUrl?: string | null): boolean {
    if (this.acknowledged || sourceId !== OSM_STANDARD_SOURCE_ID) return false
    if (!sourceUrl) return true

    try {
      return new URL(sourceUrl.replace('{s}.', '')).hostname === 'tile.openstreetmap.org'
    } catch {
      return false
    }
  }

  acknowledge(): void {
    this.acknowledged = true
  }
}

export const osmDownloadPolicySession = new OsmDownloadPolicySession()

type OsmDownloadPolicyRequest = {
  resolve: (decision: OsmDownloadPolicyDecision) => void
}

let pendingDecision: Promise<OsmDownloadPolicyDecision> | null = null

export function requestOsmDownloadApproval(
  sourceId: string,
  sourceUrl?: string | null,
): Promise<OsmDownloadPolicyDecision> {
  if (!osmDownloadPolicySession.requiresConfirmation(sourceId, sourceUrl)) {
    return Promise.resolve('continue')
  }
  if (pendingDecision) return pendingDecision

  let finishRequest: (decision: OsmDownloadPolicyDecision) => void = () => undefined
  const decisionPromise = new Promise<OsmDownloadPolicyDecision>((resolve) => {
    const finish = (decision: OsmDownloadPolicyDecision) => {
      if (decision === 'continue') osmDownloadPolicySession.acknowledge()
      pendingDecision = null
      resolve(decision)
    }
    finishRequest = finish
  })
  pendingDecision = decisionPromise
  window.dispatchEvent(
    new CustomEvent<OsmDownloadPolicyRequest>(OSM_DOWNLOAD_POLICY_EVENT, {
      detail: { resolve: finishRequest },
    }),
  )
  return decisionPromise
}

export function focusImagerySourcePicker(): void {
  window.setTimeout(() => {
    const trigger = document.querySelector<HTMLElement>(
      '[data-agent-target="imagery-source-select"]',
    )
    trigger?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    trigger?.focus()
    trigger?.click()
  }, 120)
}

export type { OsmDownloadPolicyRequest }
