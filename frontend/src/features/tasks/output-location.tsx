import { useMutation } from '@tanstack/react-query'
import { ClipboardCopy, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { openFileLocation } from '@/features/history/history-api'
import { trackTelemetry } from '@/features/telemetry/telemetry-client'

export function OutputLocation({ path, saved, strictFile = false }: { path: string; saved: boolean; strictFile?: boolean }) {
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
  return <div data-output-location className="min-w-0 space-y-2 rounded-md border bg-muted/20 p-2.5">
    <div className="flex min-w-0 items-start gap-2">
      <p className="min-w-0 flex-1 pt-1 text-xs font-medium">{t(saved ? 'tasks.output.savedPath' : 'tasks.output.plannedPath')}</p>
      <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={copy}
        title={t('tasks.output.copyPath')} aria-label={t('tasks.output.copyPath')}><ClipboardCopy className="size-3.5"/></Button>
    </div>
    <p data-output-path className="max-h-24 min-w-0 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-4 text-muted-foreground select-text" title={path}>{path}</p>
    {saved && <Button size="sm" variant="outline" className="h-7 w-full min-w-0 justify-start gap-1.5 px-2 text-xs" onClick={() => open.mutate()} disabled={open.isPending}>
        <FolderOpen className="size-3"/>{t('history.actions.openFolder')}
    </Button>}
  </div>
}
