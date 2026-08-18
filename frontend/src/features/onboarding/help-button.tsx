import { HelpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          data-tour="help-button"
          aria-label={t('app.help.title')}
          title={t('app.help.title')}
          size="icon"
          variant="ghost"
        >
          <HelpCircle className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs">{t('app.help.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onStartMain}>{t('app.help.overview')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartRegion}>{t('app.help.region')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartDownloadCenter}>{t('app.help.downloadCenter')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          {t('app.help.byMode')}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={onStartImagery}>{t('app.help.imagery')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartMvt}>{t('app.help.mvt')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartOsm}>{t('app.help.osm')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartTiles3d}>{t('app.help.tiles3d')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onStartWayback}>{t('app.help.wayback')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
