import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Layers, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { FoundationControls } from './foundation-controls'
import { useFoundationStore } from './foundation-store'
import { FOUNDATION_IDS } from './model'
import { OsmPreviewControls } from '@/features/vector/osm-preview-controls'
import { useOsmPreviewStore } from '@/features/vector/osm-preview-store'

/** A pinned, non-modal map control. It never enters the download parameter form. */
export function FoundationMapPanel() {
  const { t } = useTranslation(),
    id = useId()
  const visible = useFoundationStore(
    (s) =>
      FOUNDATION_IDS.filter((key) => s.settings.layers[key].visible).length,
  )
  const osmVisible = useOsmPreviewStore(s => s.layers.filter(l => l.visible).length)
  const [open, setOpen] = useState(() => visible > 0)
  const toggle = useRef<HTMLButtonElement>(null)
  return (
    <section
      data-map-reference-panel
      className={`pointer-events-auto absolute right-3 top-16 z-20 flex max-h-[calc(100%_-_6rem)] flex-col rounded-md border bg-background/95 text-foreground shadow-md backdrop-blur ${open ? 'w-72' : 'w-auto'}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
          toggle.current?.focus()
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-1 p-1">
        <Button
          ref={toggle}
          type="button"
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 justify-start gap-2"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
        >
          <Layers className="size-4 shrink-0" />
          <span className="truncate">{t('vectorData.mapLayers')}</span>
          {visible + osmVisible > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {visible + osmVisible}
            </span>
          )}
          <ChevronDown
            className={`ml-auto size-3 shrink-0 ${open ? 'rotate-180' : ''}`}
          />
        </Button>
        {open && (
          <Tooltip content={t('foundation.closePanel')}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={t('foundation.closePanel')}
              onClick={() => {
                setOpen(false)
                toggle.current?.focus()
              }}
            >
              <X className="size-3.5" />
            </Button>
          </Tooltip>
        )}
      </div>
      {open && (
        <div
          id={id}
          role="region"
          aria-label={t('vectorData.mapLayers')}
          className="min-h-0 overflow-y-auto border-t px-3 pb-3 pt-2"
        >
          <FoundationControls embedded />
          <OsmPreviewControls />
        </div>
      )}
    </section>
  )
}
