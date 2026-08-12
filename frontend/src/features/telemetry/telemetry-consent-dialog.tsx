import { Activity, ExternalLink, ShieldCheck } from 'lucide-react'

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Activity className="size-5" />
          </div>
          <DialogTitle>帮助改进 GeoD</DialogTitle>
          <DialogDescription>
            是否允许发送最少量的匿名使用数据？同意前不会生成匿名标识，也不会发送任何统计信息。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <section className="rounded-md border p-3">
            <div className="mb-2 flex items-center gap-2 font-medium">
              <ShieldCheck className="size-4 text-emerald-600" />
              收集范围
            </div>
            <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
              <li>随机生成的匿名安装标识、应用版本和操作系统类型。</li>
              <li>应用启动、功能模式、下载任务创建和任务操作的使用情况。</li>
              <li>范围选择方式、导入结果、书签、量测和新手引导等功能事件。</li>
              <li>数量仅按区间统计，不上传具体地图内容或业务数据。</li>
            </ul>
          </section>

          <section className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <p className="text-xs leading-5 text-muted-foreground">
              不收集下载地址、文件路径、文件名、搜索内容、地图坐标、选区范围、Token、API Key
              或下载的数据。统计不会影响任何下载功能，可随时在设置中关闭或重置匿名标识。
            </p>
          </section>

          <a
            href="https://geodownloader.pages.dev/disclaimer.html#anonymous-telemetry"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            查看完整说明
            <ExternalLink className="size-3" />
          </a>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDecline}>
            暂不参与
          </Button>
          <Button type="button" onClick={onAccept}>
            同意并开启
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
