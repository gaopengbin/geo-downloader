import { HelpCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface HelpButtonProps {
  /** 启动主界面引导 */
  onStartMain: () => void
  /** 启动影像/DEM 引导 */
  onStartImagery: () => void
  /** 启动区域与地图工具引导 */
  onStartRegion: () => void
  /** 启动下载中心引导 */
  onStartDownloadCenter: () => void
  /** 启动 MVT 引导 */
  onStartMvt: () => void
  /** 启动 OSM 引导 */
  onStartOsm: () => void
  /** 启动 3D Tiles 引导 */
  onStartTiles3d: () => void
  /** 启动 Wayback 引导 */
  onStartWayback: () => void
}

export function HelpButton({
  onStartMain,
  onStartImagery,
  onStartRegion,
  onStartDownloadCenter,
  onStartMvt,
  onStartOsm,
  onStartTiles3d,
  onStartWayback,
}: HelpButtonProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          data-tour="help-button"
          aria-label="新手引导"
          title="新手引导"
          size="icon"
          variant="ghost"
        >
          <HelpCircle className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs">新手引导</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onStartMain}>主界面总览</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartRegion}>区域选择与地图工具</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartDownloadCenter}>下载中心</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          按模式
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={onStartImagery}>影像 / DEM 下载</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartMvt}>MVT 矢量瓦片</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartOsm}>OSM 矢量数据</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartTiles3d}>3D Tiles 下载</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartWayback}>Wayback 历史影像</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
