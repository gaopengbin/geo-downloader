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
import { fallbackToLocal } from '@/lib/qr-assets'
import { useCachedImage } from '@/lib/use-cached-image'

export function SponsorDialog() {
  const [tab, setTab] = useState<'wx' | 'zfb'>('wx')
  const wxSrc = useCachedImage('wx')
  const zfbSrc = useCachedImage('zfb')

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
          <Heart className="size-3.5" />
          赞助
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
              src={wxSrc}
              onError={(e) => fallbackToLocal(e, 'wx')}
              alt="微信收款码"
              className="h-64 w-64 rounded-md border object-contain"
            />
          </TabsContent>
          <TabsContent value="zfb" className="mt-3 flex justify-center">
            <img
              src={zfbSrc}
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
