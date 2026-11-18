import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { useOsmPreviewStore } from './osm-preview-store'

export function OsmPreviewControls() {
  const { t } = useTranslation()
  const layers = useOsmPreviewStore(s => s.layers)
  if (!layers.length) return null
  return <div className="space-y-2 border-t pt-2" data-osm-preview-controls>
    <p className="text-xs font-medium">{t('vectorData.osmPreview')}</p>
    {layers.map(layer => <div key={layer.id} className="flex min-w-0 items-start gap-2 text-xs">
      <Checkbox className="mt-1" checked={layer.visible} onChange={e => useOsmPreviewStore.getState().toggle(layer.id, e.target.checked)} aria-label={layer.name} />
      <div className="min-w-0 flex-1">
        <Tooltip content={layer.name}><span className="block truncate">{layer.name}</span></Tooltip>
        <p className="text-muted-foreground">{t('vectorData.featureCount', { count: layer.featureCount })}</p>
        {layer.visible && layer.status && <p role="status" className={layer.status.failed ? 'text-destructive' : 'text-muted-foreground'}>
          {layer.status.failed ? t('vectorData.tileError') : layer.status.pending ? t('vectorData.rendering') : t('vectorData.ready')}
        </p>}
      </div>
      <Tooltip content={t('vectorData.remove')}><Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label={t('vectorData.remove')} onClick={() => useOsmPreviewStore.getState().remove(layer.id)}><Trash2 className="size-3.5" /></Button></Tooltip>
    </div>)}
  </div>
}
