import { useEffect, useRef, useState } from 'react'

import {
  clearTelemetryQueue,
  flushTelemetry,
  trackTelemetry,
} from './telemetry-client'
import { TelemetryConsentDialog } from './telemetry-consent-dialog'
import { useTelemetryStore } from './telemetry-store'
import { startDownloadTelemetry } from './download-monitor'
import { runtimePolicy } from '@/lib/runtime-policy'

export function TelemetryBootstrap() {
  return runtimePolicy.telemetry ? <EnabledTelemetryBootstrap /> : null
}

function EnabledTelemetryBootstrap() {
  const consent = useTelemetryStore((state) => state.consent)
  const setConsent = useTelemetryStore((state) => state.setConsent)
  const [dismissed, setDismissed] = useState(false)
  const trackedStartupRef = useRef(false)

  useEffect(() => {
    if (consent !== 'enabled') return
    return startDownloadTelemetry()
  }, [consent])

  useEffect(() => {
    if (consent !== 'enabled') {
      clearTelemetryQueue()
      return
    }
    if (!trackedStartupRef.current) {
      trackedStartupRef.current = true
      void trackTelemetry('app_started', {})
    }
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
