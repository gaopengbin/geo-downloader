import { useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/app-store'
import { useWaybackStore } from '@/store/wayback-store'
import { getSettings } from '@/features/settings/settings-api'
import { getWaybackVersions } from '@/features/wayback/wayback-api'

export function WaybackTimeline() {
  const mode = useAppStore((s) => s.mode)
  const previewVersionId = useWaybackStore((s) => s.previewVersionId)
  const setPreviewVersionId = useWaybackStore((s) => s.setPreviewVersionId)
  const visible = mode === 'wayback'

  // 复用 wayback-page 的缓存（同一 queryKey）
  const settingsQuery = useQuery({
    queryKey: ['app-settings'],
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
    enabled: visible,
    staleTime: 5 * 60 * 1000,
  })

  // 升序版本：oldest → newest（与旧版一致）
  const ascending = useMemo(() => {
    const list = versionsQuery.data ?? []
    return [...list].reverse()
  }, [versionsQuery.data])

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
    const step = Math.max(1, Math.ceil(yearMarkers.length / 12))
    const result: { year: string; idx: number }[] = []
    for (let i = 0; i < yearMarkers.length; i += step) result.push(yearMarkers[i])
    const last = yearMarkers[yearMarkers.length - 1]
    if (last && result[result.length - 1]?.year !== last.year) result.push(last)
    return result
  }, [yearMarkers])

  // 当 previewVersionId 为空时，自动选最新（数组末尾）
  useEffect(() => {
    if (!visible) return
    if (!ascending.length) return
    if (previewVersionId == null || !ascending.find((v) => v.id === previewVersionId)) {
      setPreviewVersionId(ascending[ascending.length - 1].id)
    }
  }, [visible, ascending, previewVersionId, setPreviewVersionId])

  if (!visible) return null
  if (!ascending.length) return null

  const currentIdx = Math.max(
    0,
    ascending.findIndex((v) => v.id === previewVersionId),
  )
  const current = ascending[currentIdx]
  const total = ascending.length

  function setIndex(idx: number) {
    const clamped = Math.max(0, Math.min(total - 1, idx))
    const v = ascending[clamped]
    if (v) setPreviewVersionId(v.id)
  }

  return (
    <div className="pointer-events-auto absolute inset-x-3 bottom-12 z-[450] rounded-lg border bg-background/95 px-4 py-3 shadow-lg backdrop-blur">
      {/* 顶部：当前日期 + 序号 */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tabular-nums tracking-tight">
            {current?.date ?? '--'}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {currentIdx + 1} / {total}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setIndex(0)}
            disabled={currentIdx <= 0}
            title="跳到最早"
          >
            <ChevronsLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setIndex(currentIdx - 1)}
            disabled={currentIdx <= 0}
            title="上一版本"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setIndex(currentIdx + 1)}
            disabled={currentIdx >= total - 1}
            title="下一版本"
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setIndex(total - 1)}
            disabled={currentIdx >= total - 1}
            title="跳到最新"
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

      {/* Slider 区域：基线 + 年分隔线 + 日期刻度 */}
      <div className="relative h-7 select-none">
        {/* 基线 */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {/* 年分隔线（满高、偏粗、淡色） */}
        {yearMarkers.map(({ year, idx }) => {
          const left = total === 1 ? 0 : (idx / (total - 1)) * 100
          return (
            <span
              key={`yr-${year}`}
              className="pointer-events-none absolute top-0 h-7 w-px -translate-x-1/2 bg-border"
              style={{ left: `${left}%` }}
            />
          )
        })}
        {/* 日期刻度 */}
        <div className="absolute inset-x-0 top-1/2 h-6 -translate-y-1/2">
          {ascending.map((v, i) => {
            const left = total === 1 ? 0 : (i / (total - 1)) * 100
            const active = i === currentIdx
            return (
              <span
                key={v.id}
                className="group absolute top-0 h-6 -translate-x-1/2"
                style={{ left: `${left}%` }}
              >
                <span
                  className={
                    'absolute left-1/2 -translate-x-1/2 cursor-pointer transition-all ' +
                    (active
                      ? 'top-0 h-6 w-0.5 bg-primary'
                      : 'top-1.5 h-3 w-px bg-muted-foreground/50 group-hover:top-0 group-hover:h-6 group-hover:w-0.5 group-hover:bg-primary')
                  }
                  onClick={() => setIndex(i)}
                />
                {/* 悬停 tooltip */}
                <span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded border bg-popover px-1.5 py-0.5 text-[10px] tabular-nums text-popover-foreground shadow-md group-hover:block">
                  {v.date}
                </span>
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}
