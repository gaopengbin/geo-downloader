import { useEffect, useRef, useState } from 'react'

import {
  clearTelemetryQueue,
  flushTelemetry,
  trackTelemetry,
} from './telemetry-client'
import { TelemetryConsentDialog } from './telemetry-consent-dialog'
import { useTelemetryStore,TELEMETRY_NOTICE_VERSION } from './telemetry-store'
import { startDownloadTelemetry } from './download-monitor'
import { runtimePolicy } from '@/lib/runtime-policy'

export function TelemetryBootstrap() {
  return runtimePolicy.telemetry ? <EnabledTelemetryBootstrap /> : null
}

function EnabledTelemetryBootstrap() {
  const [hydrated,setHydrated]=useState(()=>useTelemetryStore.persist.hasHydrated())
  const consent = useTelemetryStore((state) => state.consent)
  const setConsent = useTelemetryStore((state) => state.setConsent)
  const noticeAcknowledgedVersion=useTelemetryStore(state=>state.noticeAcknowledgedVersion)
  const acknowledgeNotice=useTelemetryStore(state=>state.acknowledgeNotice)
  const [dismissed, setDismissed] = useState(false)
  const trackedStartupRef = useRef(false)
  useEffect(()=>{setHydrated(useTelemetryStore.persist.hasHydrated());return useTelemetryStore.persist.onFinishHydration(()=>setHydrated(true))},[])

  useEffect(() => {
    if (!hydrated || consent !== 'enabled') return
    return startDownloadTelemetry()
  }, [consent,hydrated])

  useEffect(() => {
    if (!hydrated) return
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
  }, [consent,hydrated])

  return (
    <TelemetryConsentDialog
      mode="default-notice"
      open={hydrated && consent === 'enabled' && noticeAcknowledgedVersion!==TELEMETRY_NOTICE_VERSION && !dismissed}
      onOpenChange={(open) => {
        if (!open){acknowledgeNotice();setDismissed(true)}
      }}
      onAccept={() => {
        acknowledgeNotice()
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
