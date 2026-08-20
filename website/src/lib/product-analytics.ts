const productionEndpoint = 'https://laogao.xyz/platform-api/v1/product-events'
const visitorStorageKey = 'geod-web:analytics-visitor'
const sessionStorageKey = 'geod-web:analytics-session'

type EventName = 'page_view' | 'download_clicked'
type Properties = Record<string, string>

function endpoint() {
  if (process.env.NEXT_PUBLIC_PRODUCT_ANALYTICS_ENDPOINT) {
    return process.env.NEXT_PUBLIC_PRODUCT_ANALYTICS_ENDPOINT
  }
  return window.location.hostname === 'geodownloader.pages.dev' ? productionEndpoint : ''
}

function identifier(storage: Storage, key: string) {
  const existing = storage.getItem(key)
  if (existing) return existing
  const value = crypto.randomUUID()
  storage.setItem(key, value)
  return value
}

function context(): Properties {
  const parameters = new URLSearchParams(window.location.search)
  let referrerHost = ''
  try {
    referrerHost = document.referrer ? new URL(document.referrer).hostname : ''
  } catch {
    referrerHost = ''
  }
  return {
    path: window.location.pathname.slice(0, 256),
    ...(referrerHost ? { referrer_host: referrerHost.slice(0, 128) } : {}),
    ...(parameters.get('utm_source') ? { source: parameters.get('utm_source')!.slice(0, 64) } : {}),
    ...(parameters.get('utm_medium') ? { medium: parameters.get('utm_medium')!.slice(0, 64) } : {}),
    ...(parameters.get('utm_campaign') ? { campaign: parameters.get('utm_campaign')!.slice(0, 96) } : {}),
  }
}

export async function trackProductEvent(event: EventName, properties: Properties = {}) {
  const url = endpoint()
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: 1,
        product: 'geod-web',
        events: [{
          event_id: crypto.randomUUID(),
          event,
          occurred_at: new Date().toISOString(),
          visitor_id: identifier(localStorage, visitorStorageKey),
          session_id: identifier(sessionStorage, sessionStorageKey),
          properties: { ...context(), ...properties },
        }],
      }),
      keepalive: true,
    })
  } catch {
    // Product analytics must never block navigation or downloads.
  }
}
