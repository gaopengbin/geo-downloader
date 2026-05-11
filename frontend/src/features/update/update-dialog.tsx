import { useEffect, useRef } from 'react'
import { Download, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'

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
  const open = useUpdateStore((s) => s.open)
  const info = useUpdateStore((s) => s.info)
  const downloading = useUpdateStore((s) => s.downloading)
  const progress = useUpdateStore((s) => s.progress)
  const closeDialog = useUpdateStore((s) => s.closeDialog)
  const setDownloading = useUpdateStore((s) => s.setDownloading)
  const setProgress = useUpdateStore((s) => s.setProgress)

  const unlistenRef = useRef<null | (() => void)>(null)

  useEffect(() => {
    if (!open) {
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
    }
  }, [open])

  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
    }
  }, [])

  if (!info) return null

  const handleClose = (next: boolean) => {
    if (!next && downloading) return
    if (!next) closeDialog()
  }

  const handleUpdateNow = async () => {
    if (!info.downloadUrl) {
      await openExternal(info.releaseUrl)
      closeDialog()
      return
    }
    if (!info.downloadUrl.endsWith('.exe')) {
      await openExternal(info.downloadUrl)
      closeDialog()
      return
    }

    setDownloading(true)
    setProgress(0)

    try {
      const { listen } = await import('@tauri-apps/api/event')
      unlistenRef.current = await listen<number>('update-download-progress', (e) => {
        setProgress(typeof e.payload === 'number' ? e.payload : 0)
      })

      await invokeCommand<void>('download_and_install_update', {
        url: info.downloadUrl,
        version: info.latestVersion,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('下载更新失败：' + message)
      setDownloading(false)
      setProgress(0)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>发现新版本</DialogTitle>
          <DialogDescription>
            当前版本 v{info.currentVersion}，最新版本 v{info.latestVersion}。
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
              <span className="text-muted-foreground">正在下载安装包…</span>
              <span className="tabular-nums font-medium">{progress}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => openExternal(info.releaseUrl)}>
            <ExternalLink className="size-4" />
            发布页
          </Button>
          {!downloading && (
            <>
              <Button variant="ghost" onClick={() => closeDialog()}>
                稍后再说
              </Button>
              <Button onClick={handleUpdateNow}>
                <Download className="size-4" />
                {info.downloadUrl?.endsWith('.exe') ? '立即更新' : '前往下载'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
