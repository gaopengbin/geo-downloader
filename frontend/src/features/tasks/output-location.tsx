import { useMutation } from '@tanstack/react-query'
import { ClipboardCopy, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { openFileLocation } from '@/features/history/history-api'
import { trackTelemetry } from '@/features/telemetry/telemetry-client'

export function OutputActions({ path, saved, strictFile = false }: { path: string; saved: boolean; strictFile?: boolean }) {
  const { t } = useTranslation()
  const report = (action: 'open_folder' | 'copy_path', outcome: 'success' | 'failed') => {
    void trackTelemetry('output_location_action', { action, outcome, strict_file: strictFile })
  }
  const open = useMutation({
    mutationFn: () => openFileLocation(path, strictFile),
    onSuccess: () => report('open_folder', 'success'),
    onError: (e) => { report('open_folder', 'failed'); toast.error(t('history.toast.openError', { message: String(e) })) },
  })
  const copy = async () => {
    try { await navigator.clipboard.writeText(path); report('copy_path', 'success'); toast.success(t('tasks.output.copied')) }
    catch { report('copy_path', 'failed'); toast.error(t('tasks.output.copyError')) }
  }
  if (!path) return null
  return <>
    {saved && <Button data-output-open size="sm" variant="outline" className="h-7 min-w-0 gap-1 px-2 text-xs" onClick={() => open.mutate()} disabled={open.isPending}
        title={path}>
        <FolderOpen className="size-3"/>{t('history.actions.openFolder')}
    </Button>}
    <Button data-output-copy size="icon" variant="ghost" className="size-7 shrink-0" onClick={copy}
      title={`${t('tasks.output.copyPath')}\n${path}`} aria-label={t('tasks.output.copyPath')}><ClipboardCopy className="size-3.5"/></Button>
  </>
}
