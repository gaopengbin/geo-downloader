import { Activity, ExternalLink, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface TelemetryConsentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAccept: () => void
  onDecline: () => void
}

export function TelemetryConsentDialog({
  open,
  onOpenChange,
  onAccept,
  onDecline,
}: TelemetryConsentDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Activity className="size-5" />
          </div>
          <DialogTitle>{t('telemetry.consentTitle')}</DialogTitle>
          <DialogDescription>
            {t('telemetry.consentDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <section className="rounded-md border p-3">
            <div className="mb-2 flex items-center gap-2 font-medium">
              <ShieldCheck className="size-4 text-emerald-600" />
              {t('telemetry.scope')}
            </div>
            <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
              <li>{t('telemetry.install')}</li>
              <li>{t('telemetry.usage')}</li>
              <li>{t('telemetry.features')}</li>
              <li>{t('telemetry.buckets')}</li>
            </ul>
          </section>

          <section className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <p className="text-xs leading-5 text-muted-foreground">
              {t('telemetry.excluded')}
            </p>
          </section>

          <a
            href="https://geodownloader.pages.dev/disclaimer.html#anonymous-telemetry"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {t('telemetry.details')}
            <ExternalLink className="size-3" />
          </a>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDecline}>
            {t('telemetry.decline')}
          </Button>
          <Button type="button" onClick={onAccept}>
            {t('telemetry.accept')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
