import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Feature } from 'geojson'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSelectionStore, type ImportedFeature, type LatLngRing, type MapBounds } from '@/store/selection-store'
import {
  collectPropertyKeys,
  extractFeaturePolygon,
  recommendNameField,
} from '@/features/batch/batch-utils'
import { featureAreaKm2 } from '@/lib/geo-area'
import {
  telemetryCountBucket,
  telemetryImportFormat,
  trackTelemetry,
} from '@/features/telemetry/telemetry-client'
import { updateOrderedRangeSelection } from '@/features/region/range-selection'
import type { RegionCrsInfo } from '@/lib/geo-import'

const INDEX_FIELD = '__index__'

interface Props {
  features: Feature[] | null
  filename: string
  crs?: RegionCrsInfo | null
  onClose: () => void
}

export function RegionImportDialog({ features, filename, crs, onClose }: Props) {
  if (!features) return null

  return (
    <RegionImportDialogContent
      features={features}
      filename={filename}
      crs={crs}
      onClose={onClose}
    />
  )
}

function RegionImportDialogContent({
  features,
  filename,
  crs,
  onClose,
}: {
  features: Feature[]
  filename: string
  crs?: RegionCrsInfo | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const setExternalSelection = useSelectionStore((s) => s.setExternalSelection)

  const propertyKeys = useMemo(
    () => collectPropertyKeys(features),
    [features],
  )
  const [nameField, setNameField] = useState<string>(
    () => recommendNameField(propertyKeys) ?? INDEX_FIELD,
  )
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(features.map((_, i) => i)),
  )
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<'original' | 'name-asc' | 'area-asc' | 'area-desc'>('original')
  const [shiftSelecting, setShiftSelecting] = useState(false)
  const selectionAnchorRef = useRef<number | null>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftSelecting(true)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftSelecting(false)
    }
    const resetShiftState = () => setShiftSelecting(false)

    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', resetShiftState)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', resetShiftState)
    }
  }, [])

  const total = features.length
  const featureName = (i: number): string => {
    const fallback = t('regionImport.featureName', { index: String(i + 1).padStart(3, '0') })
    if (nameField === INDEX_FIELD) return fallback
    const f = features[i]
    const v = f.properties?.[nameField]
    if (v == null || v === '') return fallback
    return String(v)
  }

  const areas = useMemo(() => features.map(featureAreaKm2), [features])
  const totalArea = areas.every((area) => area != null)
    ? areas.reduce<number>((sum, area) => sum + (area ?? 0), 0)
    : null
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visibleIndices = features
    .map((_, index) => index)
    .filter((index) => !normalizedSearch || featureName(index).toLocaleLowerCase().includes(normalizedSearch))
    .sort((left, right) => {
      if (sortMode === 'name-asc') return featureName(left).localeCompare(featureName(right))
      if (sortMode === 'area-asc' || sortMode === 'area-desc') {
        const leftArea = areas[left]
        const rightArea = areas[right]
        if (leftArea == null) return rightArea == null ? left - right : 1
        if (rightArea == null) return -1
        return sortMode === 'area-asc' ? leftArea - rightArea : rightArea - leftArea
      }
      return left - right
    })

  const toggle = (i: number, shiftKey = false) => {
    setSelected((prev) =>
      updateOrderedRangeSelection(
        prev,
        i,
        shiftKey ? selectionAnchorRef.current : null,
        visibleIndices,
      ),
    )
    if (!shiftKey || selectionAnchorRef.current == null) {
      selectionAnchorRef.current = i
    }
  }
  const selectAll = () => {
    selectionAnchorRef.current = null
    setSelected(new Set(features.map((_, i) => i)))
  }
  const selectNone = () => {
    selectionAnchorRef.current = null
    setSelected(new Set())
  }
  const invert = () => {
    selectionAnchorRef.current = null
    setSelected(
      new Set(features.map((_, i) => i).filter((i) => !selected.has(i))),
    )
  }

  const handleSelectionClick = (i: number, event: MouseEvent) => {
    toggle(i, event.shiftKey)
  }

  const selectedAreas = Array.from(selected).map((index) => areas[index])
  const selectedArea = selectedAreas.every((area) => area != null)
    ? selectedAreas.reduce<number>((sum, area) => sum + (area ?? 0), 0)
    : null

  const onConfirm = () => {
    if (selected.size === 0) return
    const indices = Array.from(selected).sort((a, b) => a - b)

    const importedFeatures: ImportedFeature[] = []
    const allRings: LatLngRing[] = []
    let n = -Infinity, s = Infinity, e = -Infinity, w = Infinity

    for (const i of indices) {
      const polygon = extractFeaturePolygon(features[i])
      if (!polygon || polygon.length === 0) continue
      let fn = -Infinity, fs = Infinity, fe = -Infinity, fw = Infinity
      for (const ring of polygon) {
        for (const p of ring) {
          if (p.lat > fn) fn = p.lat
          if (p.lat < fs) fs = p.lat
          if (p.lng > fe) fe = p.lng
          if (p.lng < fw) fw = p.lng
        }
      }
      const featBounds: MapBounds = { north: fn, south: fs, east: fe, west: fw }
      importedFeatures.push({ name: featureName(i), bounds: featBounds, rings: polygon })
      allRings.push(...polygon)
      if (fn > n) n = fn
      if (fs < s) s = fs
      if (fe > e) e = fe
      if (fw < w) w = fw
    }

    if (importedFeatures.length === 0) {
      onClose()
      return
    }

    setExternalSelection({
      bounds: { north: n, south: s, east: e, west: w },
      polygon: allRings,
      features: importedFeatures.length > 1 ? importedFeatures : null,
    })
    void trackTelemetry('region_imported', {
      format: telemetryImportFormat(filename),
      outcome: 'success',
      feature_count: telemetryCountBucket(importedFeatures.length),
    })
    void trackTelemetry('selection_changed', {
      method: 'import',
      geometry: 'polygon',
      complexity: telemetryCountBucket(allRings.reduce((total, ring) => total + ring.length, 0)),
    })
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={`flex max-h-[85vh] max-w-2xl flex-col${shiftSelecting ? ' shift-range-selecting' : ''}`}
      >
        <DialogHeader>
          <DialogTitle>
            {t('regionImport.title', {
              filename: filename || t('regionImport.uploadedFile'),
              count: total,
            })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('regionImport.description', { count: total })}
          </DialogDescription>
        </DialogHeader>

        {crs && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <span className="font-medium">{t('regionImport.crs')}：</span>
            <span>{crs.label}</span>
            {crs.sidecars.length > 0 && (
              <span className="ml-2 text-muted-foreground">
                {t('regionImport.sidecars', { count: crs.sidecars.length })}
              </span>
            )}
          </div>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)_10rem] gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('regionImport.nameField')}</Label>
            <Select value={nameField} onValueChange={setNameField}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {propertyKeys.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k === '__source_file' ? t('regionImport.sourceFilename') : k}
                  </SelectItem>
                ))}
                <SelectItem value={INDEX_FIELD}>{t('regionImport.sequence')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('regionImport.sort')}</Label>
            <Select value={sortMode} onValueChange={(value) => setSortMode(value as typeof sortMode)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="original">{t('regionImport.sortOriginal')}</SelectItem>
                <SelectItem value="name-asc">{t('regionImport.sortName')}</SelectItem>
                <SelectItem value="area-desc">{t('regionImport.sortAreaDesc')}</SelectItem>
                <SelectItem value="area-asc">{t('regionImport.sortAreaAsc')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex gap-2">
          <Input
            className="h-8 flex-1 text-xs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('regionImport.searchPlaceholder')}
          />
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={selectAll} type="button">
              {t('regionImport.selectAll')}
            </Button>
            <Button size="sm" variant="outline" onClick={selectNone} type="button">
              {t('regionImport.clear')}
            </Button>
            <Button size="sm" variant="outline" onClick={invert} type="button">
              {t('regionImport.invert')}
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {t('regionImport.selected', {
              selected: selected.size,
              total,
              selectedArea: selectedArea == null ? '—' : selectedArea.toFixed(2),
              totalArea: totalArea == null ? '—' : totalArea.toFixed(2),
            })}
          </span>
          <span>{t('regionImport.visible', { count: visibleIndices.length })}</span>
        </div>

        <div className="flex-1 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/50">
              <tr>
                <th className="w-10 px-2 py-1.5 text-left">{t('regionImport.columns.selected')}</th>
                <th className="w-12 px-2 py-1.5 text-left">#</th>
                <th className="px-2 py-1.5 text-left">{t('regionImport.columns.name')}</th>
                <th className="w-24 px-2 py-1.5 text-right">{t('regionImport.columns.area')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleIndices.map((i) => {
                const area = areas[i]
                const checked = selected.has(i)
                return (
                  <tr
                    key={i}
                    className="cursor-pointer select-none border-t border-border/40 hover:bg-accent/40"
                    onMouseDown={(event) => {
                      if (event.shiftKey) event.preventDefault()
                    }}
                    onClick={(event) => handleSelectionClick(i, event)}
                  >
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        checked={checked}
                        readOnly
                        aria-label={`${t('regionImport.columns.selected')}: ${featureName(i)}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.stopPropagation()
                          handleSelectionClick(i, event)
                          event.currentTarget.blur()
                        }}
                      />
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1 truncate" title={featureName(i)}>
                      {featureName(i)}
                    </td>
                    <td className="px-2 py-1 text-right text-muted-foreground">
                      {area == null ? '—' : area.toFixed(2)}
                    </td>
                  </tr>
                )
              })}
              {visibleIndices.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                    {t('regionImport.noMatches')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} type="button">
            {t('regionImport.cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={selected.size === 0} type="button">
            {t('regionImport.confirm', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
