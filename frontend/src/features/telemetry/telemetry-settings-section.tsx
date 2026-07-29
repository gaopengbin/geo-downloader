import { BarChart3, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

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
        title="隐私与数据"
        description="匿名使用统计"
        dataAgentTarget="settings-telemetry"
      >
        <div className="flex items-center justify-between rounded-md border p-2.5">
          <div className="min-w-0 pr-2">
            <Label className="text-sm">匿名使用统计</Label>
            <p className="text-xs text-muted-foreground">
              {enabled ? '已同意，仅发送最少量功能事件' : '未启用，不会发送统计信息'}
            </p>
          </div>
          <Switch
            checked={enabled}
            aria-label="启用匿名使用统计"
            onCheckedChange={(checked) => {
              if (checked) setConsentOpen(true)
              else disableTelemetry()
            }}
          />
        </div>

        {enabled && !transportConfigured && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
            已记录你的同意选择；当前构建未配置统计服务，不会发送数据。
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setConsentOpen(true)}>
            查看收集范围
          </Button>
          {enabled && installId && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                clearTelemetryQueue()
                resetInstallId()
                toast.success('匿名标识已重置')
              }}
            >
              <RotateCcw className="size-3.5" />
              重置匿名标识
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
