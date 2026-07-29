import { useEffect, useRef, useState } from 'react'

import {
  clearTelemetryQueue,
  flushTelemetry,
  trackTelemetry,
} from './telemetry-client'
import { TelemetryConsentDialog } from './telemetry-consent-dialog'
import { useTelemetryStore } from './telemetry-store'

export function TelemetryBootstrap() {
  const consent = useTelemetryStore((state) => state.consent)
  const setConsent = useTelemetryStore((state) => state.setConsent)
  const [dismissed, setDismissed] = useState(false)
  const trackedStartupRef = useRef(false)

  useEffect(() => {
    if (consent !== 'enabled') {
      clearTelemetryQueue()
      return
    }
    if (trackedStartupRef.current) return
    trackedStartupRef.current = true
    void trackTelemetry('app_started', {})
    void flushTelemetry()

    const handleOnline = () => void flushTelemetry()
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [consent])

  return (
    <TelemetryConsentDialog
      open={consent === 'pending' && !dismissed}
      onOpenChange={(open) => {
        if (!open) setDismissed(true)
      }}
      onAccept={() => {
        setConsent('enabled')
        setDismissed(true)
      }}
      onDecline={() => {
        clearTelemetryQueue()
        setConsent('disabled')
        setDismissed(true)
      }}
    />
  )
}
