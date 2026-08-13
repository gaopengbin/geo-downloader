import { BarChart3, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'

import { PanelSection } from '@/components/layout/panel-section'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  clearTelemetryQueue,
  isTelemetryTransportConfigured,
} from './telemetry-client'
import { TelemetryConsentDialog } from './telemetry-consent-dialog'
import { useTelemetryStore } from './telemetry-store'

export function TelemetrySettingsSection() {
  const { t } = useTranslation()
  const consent = useTelemetryStore((state) => state.consent)
  const installId = useTelemetryStore((state) => state.installId)
  const setConsent = useTelemetryStore((state) => state.setConsent)
  const resetInstallId = useTelemetryStore((state) => state.resetInstallId)
  const [consentOpen, setConsentOpen] = useState(false)
  const enabled = consent === 'enabled'
  const transportConfigured = isTelemetryTransportConfigured()

  const disableTelemetry = () => {
    clearTelemetryQueue()
    setConsent('disabled')
  }

  return (
    <>
      <PanelSection
        icon={BarChart3}
        title={t('telemetry.title')}
        description={t('telemetry.description')}
        dataAgentTarget="settings-telemetry"
      >
        <div className="flex items-center justify-between rounded-md border p-2.5">
          <div className="min-w-0 pr-2">
            <Label className="text-sm">{t('telemetry.label')}</Label>
            <p className="text-xs text-muted-foreground">
              {t(enabled ? 'telemetry.enabled' : 'telemetry.disabled')}
            </p>
          </div>
          <Switch
            checked={enabled}
            aria-label={t('telemetry.toggle')}
            onCheckedChange={(checked) => {
              if (checked) setConsentOpen(true)
              else disableTelemetry()
            }}
          />
        </div>

        {enabled && !transportConfigured && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
            {t('telemetry.noTransport')}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setConsentOpen(true)}>
            {t('telemetry.viewScope')}
          </Button>
          {enabled && installId && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                clearTelemetryQueue()
                resetInstallId()
                toast.success(t('telemetry.resetDone'))
              }}
            >
              <RotateCcw className="size-3.5" />
              {t('telemetry.reset')}
            </Button>
          )}
        </div>
      </PanelSection>

      <TelemetryConsentDialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        onAccept={() => {
          setConsent('enabled')
          setConsentOpen(false)
        }}
        onDecline={() => {
          disableTelemetry()
          setConsentOpen(false)
        }}
      />
    </>
  )
}
