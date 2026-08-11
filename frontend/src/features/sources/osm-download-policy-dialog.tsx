import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  OSM_COPYRIGHT_URL,
  OSM_DOWNLOAD_POLICY_EVENT,
  OSM_TILE_USAGE_POLICY_URL,
  type OsmDownloadPolicyDecision,
  type OsmDownloadPolicyRequest,
} from './osm-download-policy'

export function OsmDownloadPolicyDialog() {
  const [request, setRequest] = useState<OsmDownloadPolicyRequest | null>(null)
  const switchButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<OsmDownloadPolicyRequest>).detail
      if (!detail?.resolve) return
      setRequest(detail)
    }
    window.addEventListener(OSM_DOWNLOAD_POLICY_EVENT, onRequest)
    return () => window.removeEventListener(OSM_DOWNLOAD_POLICY_EVENT, onRequest)
  }, [])

  const finish = (decision: OsmDownloadPolicyDecision) => {
    const current = request
    setRequest(null)
    current?.resolve(decision)
  }

  return (
    <Dialog open={request != null} onOpenChange={(open) => !open && finish('cancel')}>
      <DialogContent
        className="sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          switchButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <div className="flex items-start gap-3 pr-6">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-amber-500/12 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-5" />
            </div>
            <div className="space-y-1.5">
              <DialogTitle>OpenStreetMap Standard 下载提示</DialogTitle>
              <DialogDescription className="leading-6">
                OpenStreetMap 公共标准瓦片服务主要用于交互式浏览，其使用政策不允许批量下载、预取或制作离线瓦片包。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3 text-sm leading-6">
          <div className="rounded-md border bg-muted/35 p-3">
            建议切换到自建瓦片服务，或使用明确允许下载和离线使用的服务商。通过 Overpass
            下载 OSM 矢量要素不属于此标准瓦片服务。
          </div>
          <p className="text-muted-foreground">
            选择“仍然继续”表示你已了解服务政策和访问风险。本次应用运行期间不再重复提示，重新启动后会再次确认。
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <a
              href={OSM_TILE_USAGE_POLICY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              OSMF Tile Usage Policy <ExternalLink className="size-3" />
            </a>
            <a
              href={OSM_COPYRIGHT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              版权与署名要求 <ExternalLink className="size-3" />
            </a>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:space-x-0">
          <Button variant="ghost" onClick={() => finish('cancel')}>
            取消
          </Button>
          <Button variant="outline" onClick={() => finish('continue')}>
            仍然继续
          </Button>
          <Button ref={switchButtonRef} onClick={() => finish('switch')}>
            切换图源
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
