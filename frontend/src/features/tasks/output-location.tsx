import { useMutation } from '@tanstack/react-query'
import { ClipboardCopy, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { TaskCardAction } from './task-card-actions'
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
    {saved && <TaskCardAction data-output-open icon={FolderOpen} onClick={() => open.mutate()} disabled={open.isPending}
        title={`${t('history.actions.openFolder')}\n${path}`} aria-label={t('history.actions.openFolder')}>
        {t('tasks.cardActions.open')}
    </TaskCardAction>}
    <TaskCardAction data-output-copy icon={ClipboardCopy} onClick={copy}
      title={`${t('tasks.output.copyPath')}\n${path}`} aria-label={t('tasks.output.copyPath')}>{t('tasks.cardActions.copy')}</TaskCardAction>
  </>
}
