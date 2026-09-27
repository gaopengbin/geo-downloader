const productionEndpoint = 'https://laogao.xyz/platform-api/v1/product-events'
const visitorStorageKey = 'geod-web:analytics-visitor'
const sessionStorageKey = 'geod-web:analytics-session'

export type EventName =
  | 'page_view' | 'download_clicked' | 'install_instructions_copied' | 'install_link_clicked'
  | 'account_login_submitted' | 'account_login_succeeded'
  | 'account_registration_submitted' | 'account_registration_succeeded'
  | 'account_password_reset_succeeded' | 'account_logout_succeeded'
  | 'browser_plan_created' | 'browser_source_registered'
  | 'browser_download_started' | 'browser_download_completed'
  | 'browser_download_failed' | 'browser_save_clicked'
type Properties = Record<string, string>

function endpoint() {
  if (process.env.NEXT_PUBLIC_PRODUCT_ANALYTICS_ENDPOINT) {
    return process.env.NEXT_PUBLIC_PRODUCT_ANALYTICS_ENDPOINT
  }
  return ['geod.laogao.xyz', 'geodownloader.pages.dev'].includes(window.location.hostname)
    ? productionEndpoint : ''
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
  const privacy = navigator as Navigator & { globalPrivacyControl?: boolean }
  if (!url || privacy.doNotTrack === '1' || privacy.globalPrivacyControl === true) return
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
