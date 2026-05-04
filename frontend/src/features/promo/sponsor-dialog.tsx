import { useState } from 'react'
import { Heart } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { QR_ASSETS, fallbackToLocal } from '@/lib/qr-assets'

export function SponsorDialog() {
  const [tab, setTab] = useState<'wx' | 'zfb'>('wx')

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-rose-500 hover:bg-rose-500/10 hover:text-rose-500"
        >
          <Heart className="size-3.5 fill-current" />
          <span className="text-xs">赞助</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>请作者喝杯咖啡</DialogTitle>
          <DialogDescription>
            如果 GeoDownloader 对你有帮助，欢迎赞助支持开发。
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'wx' | 'zfb')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="wx">微信支付</TabsTrigger>
            <TabsTrigger value="zfb">支付宝</TabsTrigger>
          </TabsList>
          <TabsContent value="wx" className="mt-3 flex justify-center">
            <img
              src={QR_ASSETS.wx.remote}
              onError={(e) => fallbackToLocal(e, 'wx')}
              alt="微信收款码"
              className="h-64 w-64 rounded-md border object-contain"
            />
          </TabsContent>
          <TabsContent value="zfb" className="mt-3 flex justify-center">
            <img
              src={QR_ASSETS.zfb.remote}
              onError={(e) => fallbackToLocal(e, 'zfb')}
              alt="支付宝收款码"
              className="h-64 w-64 rounded-md border object-contain"
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
