import { useEffect, useMemo, useState } from 'react'
import type { Feature } from 'geojson'

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
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
  bboxAreaKm2,
  collectPropertyKeys,
  extractFeaturePolygon,
  featureBbox,
  recommendNameField,
} from '@/features/batch/batch-utils'
import {
  telemetryCountBucket,
  telemetryImportFormat,
  trackTelemetry,
} from '@/features/telemetry/telemetry-client'

const INDEX_FIELD = '__index__'

interface Props {
  features: Feature[] | null
  filename: string
  onClose: () => void
}

export function RegionImportDialog({ features, filename, onClose }: Props) {
  const setExternalSelection = useSelectionStore((s) => s.setExternalSelection)
  const open = features != null

  const propertyKeys = useMemo(
    () => (features ? collectPropertyKeys(features) : []),
    [features],
  )
  const [nameField, setNameField] = useState<string>(INDEX_FIELD)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!features) {
      setSelected(new Set())
      return
    }
    setNameField(recommendNameField(propertyKeys) ?? INDEX_FIELD)
    setSelected(new Set(features.map((_, i) => i)))
  }, [features, propertyKeys])

  const totalArea = useMemo(
    () =>
      features
        ? features.reduce((acc, f) => {
            const bb = featureBbox(f)
            return acc + (bb ? bboxAreaKm2(bb) : 0)
          }, 0)
        : 0,
    [features],
  )

  if (!open || !features) return null

  const total = features.length
  const featureName = (i: number): string => {
    if (nameField === INDEX_FIELD) return `要素 ${String(i + 1).padStart(3, '0')}`
    const f = features[i]
    const v = f.properties?.[nameField]
    if (v == null || v === '') return `要素 ${String(i + 1).padStart(3, '0')}`
    return String(v)
  }

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }
  const selectAll = () => setSelected(new Set(features.map((_, i) => i)))
  const selectNone = () => setSelected(new Set())
  const invert = () =>
    setSelected(
      new Set(features.map((_, i) => i).filter((i) => !selected.has(i))),
    )

  const selectedArea = Array.from(selected).reduce((acc, i) => {
    const bb = featureBbox(features[i])
    return acc + (bb ? bboxAreaKm2(bb) : 0)
  }, 0)

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
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>
            导入区域 — {filename || '上传文件'}（{total} 个要素）
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">显示名称字段</Label>
            <Select value={nameField} onValueChange={setNameField}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {propertyKeys.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k === '__source_file' ? '来源文件名' : k}
                  </SelectItem>
                ))}
                <SelectItem value={INDEX_FIELD}>序号 (001, 002, ...)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-1">
            <Button size="sm" variant="outline" onClick={selectAll} type="button">
              全选
            </Button>
            <Button size="sm" variant="outline" onClick={selectNone} type="button">
              清空
            </Button>
            <Button size="sm" variant="outline" onClick={invert} type="button">
              反选
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            已选 {selected.size} / {total} · {selectedArea.toFixed(2)} /{' '}
            {totalArea.toFixed(2)} km²
          </span>
        </div>

        <div className="flex-1 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/50">
              <tr>
                <th className="w-10 px-2 py-1.5 text-left">选</th>
                <th className="w-12 px-2 py-1.5 text-left">#</th>
                <th className="px-2 py-1.5 text-left">名称</th>
                <th className="w-24 px-2 py-1.5 text-right">面积 km²</th>
              </tr>
            </thead>
            <tbody>
              {features.map((f, i) => {
                const bb = featureBbox(f)
                const area = bb ? bboxAreaKm2(bb) : 0
                const checked = selected.has(i)
                return (
                  <tr
                    key={i}
                    className="cursor-pointer border-t border-border/40 hover:bg-accent/40"
                    onClick={() => toggle(i)}
                  >
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(i)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1 truncate" title={featureName(i)}>
                      {featureName(i)}
                    </td>
                    <td className="px-2 py-1 text-right text-muted-foreground">
                      {area.toFixed(2)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} type="button">
            取消
          </Button>
          <Button onClick={onConfirm} disabled={selected.size === 0} type="button">
            导入选中的 {selected.size} 个要素
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
