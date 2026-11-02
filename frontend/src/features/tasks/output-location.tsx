import { useMutation } from '@tanstack/react-query'
import { ClipboardCopy, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { openFileLocation } from '@/features/history/history-api'

export function OutputLocation({ path, saved, strictFile = false }: { path: string; saved: boolean; strictFile?: boolean }) {
  const { t } = useTranslation()
  const open = useMutation({
    mutationFn: () => openFileLocation(path, strictFile),
    onError: (e) => toast.error(t('history.toast.openError', { message: String(e) })),
  })
  const copy = async () => {
    try { await navigator.clipboard.writeText(path); toast.success(t('tasks.output.copied')) }
    catch { toast.error(t('tasks.output.copyError')) }
  }
  if (!path) return null
  return <div className="mt-2 min-w-0 space-y-2 rounded-md border bg-muted/20 p-2.5">
    <p className="text-xs font-medium">{t(saved ? 'tasks.output.savedPath' : 'tasks.output.plannedPath')}</p>
    <p data-output-path className="whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground select-text" title={path}>{path}</p>
    <div className="flex flex-wrap gap-1">
      {saved && <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => open.mutate()} disabled={open.isPending}>
        <FolderOpen className="size-3"/>{t('history.actions.openFolder')}
      </Button>}
      <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={copy}>
        <ClipboardCopy className="size-3"/>{t('tasks.output.copyPath')}
      </Button>
    </div>
  </div>
}
