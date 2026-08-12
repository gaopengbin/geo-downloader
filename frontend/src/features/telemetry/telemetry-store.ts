import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createSafeJSONStorage } from '@/store/persist-storage'

export type TelemetryConsent = 'pending' | 'enabled' | 'disabled'

export const TELEMETRY_NOTICE_VERSION = 2

interface TelemetryState {
  consent: TelemetryConsent
  consentedAt: string | null
  noticeVersion: number | null
  installId: string | null
  setConsent: (consent: TelemetryConsent) => void
  resetInstallId: () => void
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
      consent: 'pending',
      consentedAt: null,
      noticeVersion: null,
      installId: null,
      setConsent: (consent) =>
        set((state) => ({
          consent,
          consentedAt: new Date().toISOString(),
          noticeVersion: TELEMETRY_NOTICE_VERSION,
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
        installId: state.installId,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<TelemetryState> | undefined
        if (saved?.noticeVersion !== TELEMETRY_NOTICE_VERSION) return current
        return {
          ...current,
          consent: saved.consent ?? 'pending',
          consentedAt: saved.consentedAt ?? null,
          noticeVersion: saved.noticeVersion,
          installId: saved.installId ?? null,
        }
      },
    },
  ),
)
