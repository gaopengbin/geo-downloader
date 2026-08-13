import { useTranslation } from 'react-i18next'

import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { Bounds, Polygon } from '@/types/api'

export type TiffCompression = 'none' | 'lzw' | 'deflate'

const TIFF_COMPRESSION_OPTIONS: { value: TiffCompression; labelKey: string }[] = [
  { value: 'none', labelKey: 'download.compression.none' },
  { value: 'lzw', labelKey: 'download.compression.lzw' },
  { value: 'deflate', labelKey: 'download.compression.deflate' },
]

export function TiffCompressionSelect({
  value,
  onChange,
  triggerClassName,
}: {
  value: TiffCompression
  onChange: (value: TiffCompression) => void
  triggerClassName?: string
}) {
  const { t } = useTranslation()

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{t('download.compression.title')}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as TiffCompression)}>
        <SelectTrigger className={triggerClassName}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TIFF_COMPRESSION_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function BuildPyramidToggle({
  checked,
  onChange,
  className,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string
}) {
  const { t } = useTranslation()

  return (
    <label className={cn('flex items-center gap-2 text-xs', className)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5"
      />
      {t('download.pyramid')}
    </label>
  )
}

export function SelectionCropToggle({
  bounds,
  polygon,
  checked,
  onChange,
  className,
}: {
  bounds: Bounds | null | undefined
  polygon: Polygon | null | undefined
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string
}) {
  const { t } = useTranslation()

  if (!bounds) return null

  return (
    <label
      className={cn(
        'flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 accent-primary"
      />
      <span>
        {t(polygon && polygon.length > 0 ? 'download.crop.polygon' : 'download.crop.bounds')}
        <span className="ml-1 text-muted-foreground">{t('download.crop.hint')}</span>
      </span>
    </label>
  )
}

export function GeoTiffSidecarToggle({
  checked,
  onChange,
  className,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string
}) {
  const { t } = useTranslation()

  return (
    <label className={cn('flex items-start gap-2 text-xs', className)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5"
      />
      <span>
        {t('download.sidecars')}
        <span className="ml-1 text-muted-foreground">{t('download.sidecarsHint')}</span>
      </span>
    </label>
  )
}
