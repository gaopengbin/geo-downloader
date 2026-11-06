import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Download,
  Loader2,
  RefreshCw,
  X,
  CheckCircle2,
  Settings2,
} from 'lucide-react'
import { save } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip } from '@/components/ui/tooltip'
import { OutputActions } from '@/features/tasks/output-location'
import { useFoundationStore } from './foundation-store'
import {
  FOUNDATION_IDS,
  MIN_FOUNDATION_ZOOM,
  type FoundationId,
  type CoordinateMode,
} from './model'
import {
  cancelFoundation,
  exportFoundation,
  foundationErrorKey,
  foundationProxy,
} from './foundation-api'

const COLORS = [
  '#3185d6',
  '#e89c32',
  '#a17ada',
  '#df6262',
  '#22a879',
  '#d0d8e2',
]
export function FoundationControls({
  compact = false,
  embedded = false,
}: {
  compact?: boolean
  embedded?: boolean
}) {
  const { t } = useTranslation()
  const [styling, setStyling] = useState(false)
  const details = !compact && (!embedded || styling)
  const settings = useFoundationStore((s) => s.settings)
  const records = useFoundationStore((s) => s.records)
  const setStyle = useFoundationStore((s) => s.setStyle)
  const options = useFoundationStore((s) => s.setOptions)
  const retry = useFoundationStore((s) => s.retry)
  const viewport = useFoundationStore((s) => s.viewport)
  const exported = useFoundationStore((s) => s.exportState)
  const setExport = useFoundationStore((s) => s.setExport)
  const visible = FOUNDATION_IDS.filter((id) => settings.layers[id].visible)
  const exportId = exported?.id
  const exportPhase = exported?.phase
  useEffect(() => {
    if (!exportId || exportPhase !== 'saving') return
    let stop: (() => void) | undefined,
      closed = false
    void listen<{ features: number }>(`foundation-export-${exportId}`, (e) => {
      const s = useFoundationStore.getState()
      if (s.exportState?.id === exportId)
        s.setExport({ ...s.exportState, features: e.payload.features })
    })
      .then((fn) => {
        if (closed) fn()
        else stop = fn
      })
      .catch(() => {})
    return () => {
      closed = true
      stop?.()
    }
  }, [exportId, exportPhase])
  async function saveVectors() {
    const state = useFoundationStore.getState()
    if (state.exportState?.phase === 'saving') return
    const layers = FOUNDATION_IDS.filter(
      (id) => state.settings.layers[id].visible,
    )
    const bounds = state.viewport?.bounds
    if (!bounds || !layers.length) return
    const id = crypto.randomUUID()
    try {
      const path = await save({
        defaultPath: `foundation_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.geojson`,
        filters: [{ name: 'GeoJSON', extensions: ['geojson'] }],
      })
      if (!path) return
      setExport({ id, features: 0, phase: 'saving' })
      const result = await exportFoundation(
        id,
        layers,
        bounds,
        path,
        await foundationProxy(),
      )
      setExport({
        id,
        features: result.features,
        phase: 'completed',
        path: result.path,
      })
    } catch (error) {
      const current = useFoundationStore.getState().exportState
      setExport({
        id,
        features: current?.id === id ? current.features : 0,
        phase: 'error',
        error: foundationErrorKey(error),
      })
    }
  }
  return (
    <div
      className={
        embedded ? 'space-y-2' : 'space-y-2 border-t border-border/60 pt-3'
      }
      data-foundation-controls={compact ? 'compact' : 'full'}
    >
      {!embedded && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium">{t('foundation.title')}</p>
          <Tooltip content={t('foundation.retry')}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              disabled={!visible.length}
              aria-label={t('foundation.retry')}
              onClick={retry}
            >
              <RefreshCw className="size-3" />
            </Button>
          </Tooltip>
        </div>
      )}
      {FOUNDATION_IDS.map((id: FoundationId) => {
        const style = settings.layers[id],
          record = records[id]
        return (
          <div
            key={id}
            className={
              compact || embedded
                ? 'space-y-1 py-1'
                : 'space-y-1.5 rounded-md border p-2'
            }
            data-foundation-layer={id}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Checkbox
                checked={style.visible}
                aria-label={t(`foundation.layers.${id}`)}
                onChange={(e) => setStyle(id, { visible: e.target.checked })}
              />
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: style.color }}
              />
              <span className="min-w-0 flex-1 truncate text-xs">
                {t(`foundation.layers.${id}`)}
              </span>
              {style.visible && record.phase === 'loading' ? (
                <Loader2 className="size-3 shrink-0 animate-spin" />
              ) : style.visible && record.data ? (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {record.data.feature_count}
                  {record.data.truncated ? '+' : ''}
                </span>
              ) : null}
            </div>
            {details && (
              <div className="flex items-center gap-2">
                <Select
                  value={style.color}
                  onValueChange={(color) => setStyle(id, { color })}
                >
                  <SelectTrigger
                    className="h-7 min-w-0 flex-1 text-xs"
                    aria-label={t('foundation.color', {
                      name: t(`foundation.layers.${id}`),
                    })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COLORS.map((color, index) => (
                      <SelectItem key={color} value={color}>
                        <span className="flex items-center gap-2">
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                          {t(`foundation.colors.${index}`)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={String(style.width)}
                  onValueChange={(v) => setStyle(id, { width: Number(v) })}
                >
                  <SelectTrigger
                    className="h-7 w-16 text-xs"
                    aria-label={t('foundation.width', {
                      name: t(`foundation.layers.${id}`),
                    })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4].map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        {v}px
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <label className="flex shrink-0 items-center gap-1 text-xs">
                  <Checkbox
                    checked={style.labels}
                    aria-label={t('foundation.labelsFor', {
                      name: t(`foundation.layers.${id}`),
                    })}
                    onChange={(e) => setStyle(id, { labels: e.target.checked })}
                  />
                  {t('foundation.labels')}
                </label>
              </div>
            )}
            {style.visible && record.phase === 'zoom' && (
              <p className="text-xs text-muted-foreground">
                {t('foundation.zoomHint', { zoom: MIN_FOUNDATION_ZOOM })}
              </p>
            )}
            {style.visible && record.error && (
              <p role="alert" className="break-words text-xs text-destructive">
                {t(`foundation.${record.error}`)}
              </p>
            )}
            {!compact &&
              style.visible &&
              record.phase === 'ready' &&
              record.data &&
              (!embedded ||
                record.data.truncated ||
                record.data.feature_count === 0) && (
                <p className="text-xs text-muted-foreground">
                  {record.data.truncated
                    ? t('foundation.partial')
                    : record.data.feature_count === 0
                      ? t('foundation.empty')
                      : t(
                          record.data.network_pages === 0
                            ? 'foundation.cached'
                            : 'foundation.loaded',
                        )}
                </p>
              )}
          </div>
        )
      })}
      {embedded && (
        <div className="flex items-center justify-between gap-2 border-t pt-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-1"
            aria-expanded={styling}
            onClick={() => setStyling((v) => !v)}
          >
            <Settings2 className="size-3.5" />
            {t('foundation.displaySettings')}
          </Button>
          <Tooltip content={t('foundation.retry')}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!visible.length}
              aria-label={t('foundation.retry')}
              onClick={retry}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </Tooltip>
        </div>
      )}
      {details && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Select
              value={String(settings.fontSize)}
              onValueChange={(v) => options({ fontSize: Number(v) })}
            >
              <SelectTrigger
                className="h-8 text-xs"
                aria-label={t('foundation.font')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 12, 14, 16, 18, 22].map((v) => (
                  <SelectItem key={v} value={String(v)}>
                    {t('foundation.fontValue', { size: v })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={settings.coordinates}
              onValueChange={(v) =>
                options({ coordinates: v as CoordinateMode })
              }
            >
              <SelectTrigger
                className="h-8 text-xs"
                aria-label={t('foundation.coordinates')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['auto', 'wgs84', 'gcj02'] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`foundation.coordinateModes.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Tooltip content={t('foundation.exportHint')}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={
                !visible.length || !viewport || exported?.phase === 'saving'
              }
              onClick={() => void saveVectors()}
            >
              <Download className="mr-1 size-3.5" />
              {t('foundation.exportView')}
            </Button>
          </Tooltip>
          {exported?.phase === 'saving' && (
            <div
              className="flex items-center justify-between text-xs"
              role="status"
            >
              <span>
                {t('foundation.saving', { count: exported.features })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void cancelFoundation(exported.id)}
              >
                <X className="mr-1 size-3" />
                {t('foundation.cancel')}
              </Button>
            </div>
          )}
          {exported?.phase === 'completed' && (
            <div className="space-y-1.5">
              <p
                role="status"
                className="flex items-center gap-1 text-xs text-primary"
              >
                <CheckCircle2 className="size-3 shrink-0" />
                {t('foundation.saved', { count: exported.features })}
              </p>
              {exported.path && (
                <div className="flex gap-1">
                  <OutputActions path={exported.path} saved strictFile />
                </div>
              )}
            </div>
          )}
          {exported?.phase === 'error' && (
            <p role="alert" className="text-xs text-destructive">
              {t(`foundation.${exported.error ?? 'networkError'}`)}
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('foundation.scopeHint')}
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t('foundation.attribution')}
          </p>
        </>
      )}
    </div>
  )
}
