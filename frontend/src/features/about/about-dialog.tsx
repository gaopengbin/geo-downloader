import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Info, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { isTauriRuntime } from '@/lib/tauri'
import { checkForUpdates } from '@/features/update/update-api'
import { useUpdateStore } from '@/features/update/update-store'

async function loadAppVersion(): Promise<string> {
  if (!isTauriRuntime()) return 'web 预览'
  const { getVersion } = await import('@tauri-apps/api/app')
  return getVersion()
}

async function loadTauriVersion(): Promise<string> {
  if (!isTauriRuntime()) return 'web 预览'
  const { getTauriVersion } = await import('@tauri-apps/api/app')
  return getTauriVersion()
}

export function AboutDialog() {
  const { t } = useTranslation()
  const appVersion = useQuery({ queryKey: ['app', 'version'], queryFn: loadAppVersion })
  const tauriVersion = useQuery({
    queryKey: ['app', 'tauri-version'],
    queryFn: loadTauriVersion,
  })
  const updateStatus = useUpdateStore((s) => s.status)
  const [checking, setChecking] = useState(false)

  const handleCheckUpdate = async () => {
    setChecking(true)
    try {
      await checkForUpdates(false)
    } finally {
      setChecking(false)
    }
  }

  const statusText = (() => {
    if (checking || updateStatus.kind === 'checking') return '正在检查更新…'
    if (updateStatus.kind === 'latest') return updateStatus.message
    if (updateStatus.kind === 'error') return updateStatus.message
    return ''
  })()

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Info className="size-4" />
          {t('common.about')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>GeoDownloader</DialogTitle>
          <DialogDescription>
            遥感影像、DEM、Wayback、3D Tiles 与矢量瓦片的桌面下载工具。
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">应用版本</dt>
          <dd className="font-medium">
            {appVersion.isLoading
              ? '加载中…'
              : appVersion.error
                ? '读取失败'
                : (appVersion.data ?? '-')}
          </dd>
          <dt className="text-muted-foreground">Tauri 版本</dt>
          <dd className="font-medium">
            {tauriVersion.isLoading
              ? '加载中…'
              : tauriVersion.error
                ? '读取失败'
                : (tauriVersion.data ?? '-')}
          </dd>
          <dt className="text-muted-foreground">运行环境</dt>
          <dd className="font-medium">{isTauriRuntime() ? 'Tauri WebView2' : '浏览器预览'}</dd>
        </dl>

        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <a
            className="inline-flex items-center gap-1 text-primary hover:underline"
            href="https://geodownloader.pages.dev/"
            target="_blank"
            rel="noreferrer"
          >
            官方网站
          </a>
          <a
            className="inline-flex items-center gap-1 text-primary hover:underline"
            href="https://geodownloader.pages.dev/disclaimer.html"
            target="_blank"
            rel="noreferrer"
          >
            使用条款 / 免责声明
          </a>
          <a
            className="inline-flex items-center gap-1 text-primary hover:underline"
            href="https://github.com/gaopengbin/geo-downloader/issues"
            target="_blank"
            rel="noreferrer"
          >
            反馈与建议
          </a>
        </div>

        <DialogFooter>
          <div className="mr-auto text-xs text-muted-foreground">{statusText}</div>
          <Button
            variant="outline"
            onClick={handleCheckUpdate}
            disabled={!isTauriRuntime() || checking || updateStatus.kind === 'checking'}
          >
            <RefreshCw
              className={
                'size-4 ' + (checking || updateStatus.kind === 'checking' ? 'animate-spin' : '')
              }
            />
            检查更新
          </Button>
          <Button asChild variant="outline">
            <a href="https://github.com/gaopengbin/geo-downloader" target="_blank" rel="noreferrer">
              GitHub 仓库
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
