import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createSafeJSONStorage } from '@/store/persist-storage'
import {resolveTelemetryPreference,TELEMETRY_NOTICE_VERSION}from './telemetry-preferences'
export {TELEMETRY_NOTICE_VERSION}from './telemetry-preferences'

export type TelemetryConsent = 'pending' | 'enabled' | 'disabled'


interface TelemetryState {
  consent: TelemetryConsent
  consentedAt: string | null
  noticeVersion: number | null
  noticeAcknowledgedVersion:number|null
  installId: string | null
  setConsent: (consent: TelemetryConsent) => void
  resetInstallId: () => void
  acknowledgeNotice:()=>void
}

function createAnonymousId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const useTelemetryStore = create<TelemetryState>()(
  persist(
    (set) => ({
      ...resolveTelemetryPreference(undefined,new Date().toISOString(),createAnonymousId),
      acknowledgeNotice:()=>set({noticeAcknowledgedVersion:TELEMETRY_NOTICE_VERSION}),
      setConsent: (consent) =>
        set((state) => ({
          consent,
          consentedAt: new Date().toISOString(),
          noticeVersion: TELEMETRY_NOTICE_VERSION,
          noticeAcknowledgedVersion:TELEMETRY_NOTICE_VERSION,
          installId:
            consent === 'enabled'
              ? (state.installId ?? createAnonymousId())
              : consent === 'disabled'
                ? null
                : state.installId,
        })),
      resetInstallId: () =>
        set((state) => ({
          installId: state.consent === 'enabled' ? createAnonymousId() : null,
        })),
    }),
    {
      name: 'geo-downloader:telemetry',
      version: 1,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        consent: state.consent,
        consentedAt: state.consentedAt,
        noticeVersion: state.noticeVersion,
        noticeAcknowledgedVersion:state.noticeAcknowledgedVersion,
        installId: state.installId,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<TelemetryState> | undefined
        return {...current,...resolveTelemetryPreference(saved,new Date().toISOString(),createAnonymousId)}
      },
    },
  ),
)
