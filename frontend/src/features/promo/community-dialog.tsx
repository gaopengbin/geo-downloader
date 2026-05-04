import { Users } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { QR_ASSETS, fallbackToLocal } from '@/lib/qr-assets'

export function CommunityDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
          <Users className="size-3.5" />
          加群
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>加入 GeoD 社区</DialogTitle>
          <DialogDescription>
            关注公众号获取版本更新和教程，加入交流群与同行讨论。
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col items-center gap-2 rounded-md border p-3">
            <div className="text-sm font-medium">微信公众号</div>
            <img
              src={QR_ASSETS.gzh.remote}
              onError={(e) => fallbackToLocal(e, 'gzh')}
              alt="GeoD 公众号"
              className="h-44 w-44 rounded-md border object-contain"
            />
            <div className="text-xs text-muted-foreground">扫码关注</div>
          </div>
          <div className="flex flex-col items-center gap-2 rounded-md border p-3">
            <div className="text-sm font-medium">技术交流群</div>
            <img
              src={QR_ASSETS.wxq.remote}
              onError={(e) => fallbackToLocal(e, 'wxq')}
              alt="GeoD 技术交流群"
              className="h-44 w-44 rounded-md border object-contain"
            />
            <div className="text-center text-xs text-muted-foreground">
              扫码加群
              <br />
              失效请加微信 <span className="font-mono">gpb230314</span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
