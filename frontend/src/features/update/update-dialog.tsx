import { useEffect, useRef } from 'react'
import { Download, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
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
import { invokeCommand, isTauriRuntime } from '@/lib/tauri'
import { useUpdateStore } from './update-store'
import { updateSpeed, type UpdateTransfer } from './update-transfer'

async function openExternal(url: string) {
  if (isTauriRuntime()) {
    try {
      // 优先复用后端 reqwest 不行，这里直接走 anchor，由 tauri-plugin-opener 后端 capability 处理
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      a.remove()
      return
    } catch {
      // fall through
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function UpdateDialog() {
  const { t } = useTranslation()
  const open = useUpdateStore((s) => s.open)
  const info = useUpdateStore((s) => s.info)
  const downloading = useUpdateStore((s) => s.downloading)
  const progress = useUpdateStore((s) => s.progress)
  const transfer = useUpdateStore((s) => s.transfer)
  const closeDialog = useUpdateStore((s) => s.closeDialog)
  const setDownloading = useUpdateStore((s) => s.setDownloading)
  const setProgress = useUpdateStore((s) => s.setProgress)
  const setTransfer = useUpdateStore((s) => s.setTransfer)

  const unlistenRef = useRef<(() => void)[]>([])

  useEffect(() => {
    if (!open) {
      for (const stop of unlistenRef.current.splice(0)) stop()
    }
  }, [open])

  useEffect(() => {
    const listeners = unlistenRef.current
    return () => {
      for (const stop of listeners.splice(0)) stop()
    }
  }, [])

  if (!info) return null

  const handleClose = (next: boolean) => {
    if (!next && downloading) return
    if (!next) closeDialog()
  }

  const handleUpdateNow = async () => {
    if (useUpdateStore.getState().downloading) return
    if (!info.downloadUrl?.endsWith('.exe')) {
      toast.error(t('update.integrityMissing'))
      return
    }

    setDownloading(true)
    setProgress(0)
    setTransfer(null)

    try {
      const { listen } = await import('@tauri-apps/api/event')
      unlistenRef.current.push(await listen<number>('update-download-progress', (e) => {
        setProgress(typeof e.payload === 'number' ? e.payload : 0)
      }))
      unlistenRef.current.push(await listen<UpdateTransfer>('update-download-status', (e) => {
        setTransfer(e.payload)
        setProgress(e.payload.progress)
      }))

      await invokeCommand<void>('download_and_install_update', {
        url: info.downloadUrl,
        version: info.latestVersion,
        expectedSha256: info.expectedSha256,
        expectedSize: info.expectedSize,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('update.failed', { message: message.startsWith('UPDATE_SOURCES_FAILED:') ? t('update.sourcesFailed') : message }))
      setDownloading(false)
      setProgress(0)
      setTransfer(null)
    } finally {
      for (const stop of unlistenRef.current.splice(0)) stop()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('update.title')}</DialogTitle>
          <DialogDescription>
            {t('update.versions', {
              current: info.currentVersion,
              latest: info.latestVersion,
            })}
          </DialogDescription>
        </DialogHeader>

        {info.noteGroups.length > 0 && (
          <div className="max-h-[40vh] overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm">
            {info.noteGroups.map((group, gIdx) => (
              <div key={gIdx} className={gIdx > 0 ? 'mt-3' : ''}>
                <p className="mb-1.5 font-medium text-foreground">{group.section}</p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {group.items.map((item, iIdx) => (
                    <li key={iIdx}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {downloading && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span aria-live="polite" className="text-muted-foreground">
                {t(transfer?.phase === 'switching' ? 'update.switching'
                  : transfer?.phase === 'verifying' ? 'update.verifying'
                  : transfer?.phase === 'installing' ? 'update.installing'
                  : (transfer?.attempt ?? 0) > 1 ? 'update.downloadingBackup' : 'update.downloading')}
              </span>
              <span className="tabular-nums font-medium">{progress}%</span>
            </div>
            <div role="progressbar" aria-label={t('update.downloading')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
              />
            </div>
            {transfer && transfer.phase === 'downloading' && (
              <p className="text-xs text-muted-foreground">{t(transfer.source === 'github' ? 'update.sourceBackup' : 'update.sourceMirror')} · {updateSpeed(transfer.bytesPerSecond)}</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => openExternal(info.releaseUrl)}>
            <ExternalLink className="size-4" />
            {t('update.releasePage')}
          </Button>
          {!downloading && (
            <>
              <Button variant="ghost" onClick={() => closeDialog()}>
                {t('update.later')}
              </Button>
              <Button onClick={handleUpdateNow}>
                <Download className="size-4" />
                {t(info.downloadUrl?.endsWith('.exe') ? 'update.now' : 'update.download')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
