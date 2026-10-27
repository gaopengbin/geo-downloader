import { useMemo, useEffect, useCallback, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/app-store'
import { useWaybackStore } from '@/store/wayback-store'
import { getSettings } from '@/features/settings/settings-api'
import { getWaybackVersions } from '@/features/wayback/wayback-api'
import { getTileSourcesMerged } from '@/features/sources/sources-api'
import { historicalSourceInfo, matchesHistoricalProvider } from '@/features/sources/historical-source-info'

export function WaybackTimeline() {
  const { t } = useTranslation()
  const axisRef = useRef<HTMLDivElement>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const mode = useAppStore((s) => s.mode)
  const provider = useWaybackStore((s) => s.provider)
  const earthCatalog = useWaybackStore((s) => s.earthPointCatalog)
  const earthDate = useWaybackStore((s) => s.earthDate)
  const setEarthDate = useWaybackStore((s) => s.setEarthDate)
  const esriVersionId = useWaybackStore((s) => s.previewVersionId)
  const setEsriVersionId = useWaybackStore((s) => s.setPreviewVersionId)
  const historicalSourceId = useAppStore((s) => s.selectedSourceByMode.wayback)
  const setHistoricalSourceId = useAppStore((s) => s.setSelectedSourceForMode)
  const previewVersionId = provider === 'esri' ? esriVersionId : provider === 'earth' ? earthDate : historicalSourceId
  const setPreviewVersionId = useCallback((id: string) => {
    if (provider === 'esri') setEsriVersionId(id)
    else if (provider === 'earth') setEarthDate(id)
    else setHistoricalSourceId('wayback', id)
  }, [provider, setEsriVersionId, setHistoricalSourceId, setEarthDate])
  const visible = mode === 'wayback'

  // 复用 wayback-page / map-canvas 的缓存（同一 queryKey ['settings']）：
  // 必须与其他组件一致，否则版本列表来源分裂会导致 previewVersionId
  // 被不同列表反复“纠正”→ setState 无限循环（React #185）。
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    enabled: visible,
  })
  const proxy = useMemo(() => {
    if (!settingsQuery.data?.proxy_enabled) return null
    return settingsQuery.data.proxy_url || null
  }, [settingsQuery.data])

  const versionsQuery = useQuery({
    queryKey: ['wayback-versions', proxy ?? ''],
    queryFn: () => getWaybackVersions(proxy),
    enabled: visible && provider === 'esri',
    staleTime: 5 * 60 * 1000,
  })
  const sourcesQuery = useQuery({
    queryKey: ['tile-sources-merged', settingsQuery.data?.tianditu_token ?? null],
    queryFn: () => getTileSourcesMerged(settingsQuery.data?.tianditu_token ?? null),
    enabled: visible && provider !== 'esri',
  })

  // 升序版本：oldest → newest（与旧版一致）
  const ascending = useMemo(() => {
    if (provider === 'earth') return (earthCatalog?.dates ?? [])
      .map((entry) => ({ id: entry.date, date: entry.date, title: entry.date, layer_id: entry.date }))
      .sort((a, b) => a.date.localeCompare(b.date))
    if (provider !== 'esri') return Object.entries(sourcesQuery.data ?? {})
      .filter(([id]) => matchesHistoricalProvider(id, provider))
      .map(([id, source]) => ({ id, date: String(historicalSourceInfo(id)?.year ?? ''), title: source.name, layer_id: id }))
      .sort((a, b) => a.date.localeCompare(b.date))
    const list = versionsQuery.data?.versions ?? []
    return [...list].reverse()
  }, [versionsQuery.data, sourcesQuery.data, provider, earthCatalog])

  // 年份刻度（每个年份在时间轴上首次出现的索引）
  const yearMarkers = useMemo(() => {
    const seen = new Set<string>()
    const list: { year: string; idx: number }[] = []
    ascending.forEach((v, i) => {
      const y = v.date.slice(0, 4)
      if (y && !seen.has(y)) {
        seen.add(y)
        list.push({ year: y, idx: i })
      }
    })
    return list
  }, [ascending])

  // 年份 label：年份过多时按 step 抽稀
  const yearLabelMarkers = useMemo(() => {
    const minGap = Math.max(1, Math.ceil(ascending.length / 12))
    const result: { year: string; idx: number }[] = []
    for (const marker of yearMarkers) {
      if (!result.length || marker.idx - result[result.length - 1].idx >= minGap) result.push(marker)
    }
    const last = yearMarkers[yearMarkers.length - 1]
    if (last && result[result.length - 1]?.year !== last.year) {
      if (result.length > 1 && last.idx - result[result.length - 1].idx < minGap) result.pop()
      result.push(last)
    }
    return result
  }, [yearMarkers, ascending.length])

  // 仅当 previewVersionId 完全为空时自动选最新（数组末尾）。
  // 注意：绝不能在 previewVersionId “不在本列表”时主动覆写——那会与
  // wayback-page 的双向同步互相推翻，形成 setState 无限循环（React #185）。
  useEffect(() => {
    if (!visible) return
    if (!ascending.length) return
    if (previewVersionId == null) {
      setPreviewVersionId(ascending[ascending.length - 1].id)
    }
  }, [visible, ascending, previewVersionId, setPreviewVersionId])

  if (!visible) return null
  if (!ascending.length) return null

  const listedIdx = ascending.findIndex((v) => v.id === previewVersionId)
  const requestedNotListed = provider === 'earth' && !!previewVersionId && listedIdx < 0
  const beforeIdx = requestedNotListed ? ascending.reduce((index, entry, i) => entry.date <= previewVersionId! ? i : index, -1) : listedIdx
  const currentIdx = Math.max(0, listedIdx < 0 ? beforeIdx : listedIdx)
  const previousIdx = requestedNotListed ? beforeIdx : currentIdx - 1
  const nextIdx = requestedNotListed ? beforeIdx + 1 : currentIdx + 1
  const current = ascending[currentIdx]
  const total = ascending.length

  function setIndex(idx: number) {
    const clamped = Math.max(0, Math.min(total - 1, idx))
    const v = ascending[clamped]
    if (v) setPreviewVersionId(v.id)
  }
  function pointerIndex(clientX: number) {
    const axis = axisRef.current?.getBoundingClientRect()
    if (!axis || axis.width <= 0) return currentIdx
    return Math.round(Math.max(0, Math.min(1, (clientX - axis.left) / axis.width)) * (total - 1))
  }

  return (
    <div
      data-wayback-timeline
      data-history-provider={provider}
      data-history-version={previewVersionId ?? ''}
      className="pointer-events-auto absolute inset-x-3 bottom-12 z-[450] rounded-lg border bg-background/95 px-4 py-3 shadow-lg backdrop-blur"
    >
      {/* 顶部：当前日期 + 序号 */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tabular-nums tracking-tight">
            {provider === 'earth' ? previewVersionId ?? current?.date ?? '--' : current?.date ?? '--'}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {requestedNotListed ? t('wayback.earth.requestedNotListed') : `${currentIdx + 1} / ${total}`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setIndex(0)}
            disabled={!requestedNotListed && currentIdx <= 0}
            title={t('wayback.timeline.earliest')}
          >
            <ChevronsLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setIndex(previousIdx)}
            disabled={previousIdx < 0}
            title={t('wayback.timeline.previous')}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setIndex(nextIdx)}
            disabled={nextIdx >= total}
            title={t('wayback.timeline.next')}
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setIndex(total - 1)}
            disabled={!requestedNotListed && currentIdx >= total - 1}
            title={t('wayback.timeline.latest')}
          >
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      </div>

      {/* 年份 label（与年份分隔线对齐） */}
      <div className="relative mb-1 h-4">
        {yearLabelMarkers.map(({ year, idx }) => {
          const left = total === 1 ? 0 : (idx / (total - 1)) * 100
          return (
            <span
              key={year}
              className="absolute -translate-x-1/2 text-[10px] tabular-nums text-muted-foreground"
              style={{ left: `${left}%` }}
            >
              {year}
            </span>
          )
        })}
      </div>

      {/* The full track selects the nearest tick, including the space around thin marks. */}
      <div
        role="slider"
        tabIndex={0}
        aria-label={t('wayback.selectDate')}
        aria-valuemin={0}
        aria-valuemax={total - 1}
        aria-valuenow={currentIdx}
        aria-valuetext={provider === 'earth' ? previewVersionId ?? current?.date : current?.date}
        className="relative -mx-3 h-10 cursor-pointer select-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => { event.stopPropagation(); setIndex(pointerIndex(event.clientX)) }}
        onPointerMove={(event) => setHoveredIdx(pointerIndex(event.clientX))}
        onPointerLeave={() => setHoveredIdx(null)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Home') setIndex(0)
          else if (event.key === 'End') setIndex(total - 1)
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { if (previousIdx >= 0) setIndex(previousIdx) }
          else if (nextIdx < total) setIndex(nextIdx)
        }}
      >
      <div ref={axisRef} data-timeline-axis className="pointer-events-none absolute inset-y-0 inset-x-3">
        {/* 基线 */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {/* 年分隔线（满高、偏粗、淡色） */}
        {yearMarkers.map(({ year, idx }) => {
          const left = total === 1 ? 0 : (idx / (total - 1)) * 100
          return (
            <span
              key={`yr-${year}`}
              className="pointer-events-none absolute top-1/2 h-7 w-px -translate-x-1/2 -translate-y-1/2 bg-border"
              style={{ left: `${left}%` }}
            />
          )
        })}
        {/* 日期刻度 */}
        <div className="absolute inset-x-0 top-1/2 h-6 -translate-y-1/2">
          {ascending.map((v, i) => {
            const left = total === 1 ? 0 : (i / (total - 1)) * 100
            const active = !requestedNotListed && i === currentIdx
            const hovered = i === hoveredIdx
            return (
              <span
                key={v.id}
                className="absolute top-0 h-6 -translate-x-1/2"
                style={{ left: `${left}%` }}
              >
                {hovered && <span className="absolute -top-2 left-1/2 h-10 w-6 -translate-x-1/2 rounded bg-primary/10" />}
                <span
                  className={
                    'absolute left-1/2 -translate-x-1/2 cursor-pointer transition-all ' +
                    (active || hovered
                      ? 'top-0 h-6 w-0.5 bg-primary'
                      : 'top-1.5 h-3 w-px bg-muted-foreground/50')
                  }
                />
                {/* 悬停 tooltip */}
                <span className={`pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border bg-popover px-1.5 py-0.5 text-[10px] tabular-nums text-popover-foreground shadow-md ${hovered ? '' : 'hidden'}`}>
                  {v.date}
                </span>
              </span>
            )
          })}
        </div>
      </div>
      </div>
    </div>
  )
}
