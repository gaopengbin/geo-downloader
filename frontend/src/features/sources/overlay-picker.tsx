import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SourcesDialog } from './sources-dialog'
import { moveOverlay, overlayCandidates } from './overlay-sources'
import type { TileSource } from '@/types/api'

export function OverlayPicker({ sources, value, onChange, baseId }: {
  sources: Record<string, TileSource>
  value: string[]
  onChange: (ids: string[]) => void
  baseId?: string | null
}) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const candidates = useMemo(() => overlayCandidates(sources, baseId), [sources, baseId])
  const eligible = new Set(candidates.map((source) => source.id))
  const matches = candidates.filter((source) => !value.includes(source.id)
    && `${source.name} ${source.id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()))
  return <div className="space-y-3" data-overlay-picker>
    <p className="text-xs text-muted-foreground">{t('overlays.configureHint')}</p>
    {value.length > 0 && <ol className="space-y-1" aria-label={t('overlays.selected')}>
      {value.map((id, index) => <li key={id} data-overlay-id={id} className="flex items-center gap-1 rounded-md border p-2 text-xs">
        <span className="mr-1 text-muted-foreground">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium">{sources[id]?.name ?? id}</p>
          {!eligible.has(id) && <p className="text-destructive">{t('overlays.unavailable')}</p>}
        </div>
        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={index === 0}
          aria-label={t('overlays.moveLower', { name: sources[id]?.name ?? id })}
          onClick={() => onChange(moveOverlay(value, index, -1))}><ArrowUp className="size-3.5"/></Button>
        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={index === value.length - 1}
          aria-label={t('overlays.moveHigher', { name: sources[id]?.name ?? id })}
          onClick={() => onChange(moveOverlay(value, index, 1))}><ArrowDown className="size-3.5"/></Button>
        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0"
          aria-label={t('overlays.remove', { name: sources[id]?.name ?? id })}
          onClick={() => onChange(value.filter((item) => item !== id))}><X className="size-3.5"/></Button>
      </li>)}
    </ol>}
    <Input aria-label={t('overlays.search')} placeholder={t('overlays.search')} value={search} onChange={(event) => setSearch(event.target.value)}/>
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1" aria-label={t('overlays.available')}>
      {matches.map((source) => <Button type="button" key={source.id} variant="ghost" size="sm"
        className="h-auto min-h-8 w-full justify-start whitespace-normal text-left text-xs"
        aria-label={t('overlays.add', { name: source.name })} onClick={() => onChange([...value, source.id])}>
        <Plus className="mr-1 size-3.5 shrink-0"/><span className="break-words">{source.name}</span>
      </Button>)}
      {!matches.length && <p className="p-2 text-xs text-muted-foreground">{t('overlays.empty')}</p>}
    </div>
    <SourcesDialog triggerLabel={t('overlays.manageSources')} listenForActions={false}/>
  </div>
}
