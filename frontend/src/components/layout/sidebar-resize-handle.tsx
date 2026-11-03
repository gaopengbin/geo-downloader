import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '@/components/ui/tooltip'
import { clampSidebarWidth, sidebarWidthFromDrag, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_RESIZE_STEP } from './sidebar-width'

export function SidebarResizeHandle({ width, onWidthChange }: { width: number; onWidthChange: (width: number) => void }) {
  const { t } = useTranslation()
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; cursor: string; userSelect: string } | null>(null)
  const finish = useCallback(() => {
    if (!drag.current) return
    document.body.style.cursor = drag.current.cursor
    document.body.style.userSelect = drag.current.userSelect
    drag.current = null
  }, [])
  useEffect(() => {
    window.addEventListener('blur', finish)
    return () => { window.removeEventListener('blur', finish); finish() }
  }, [finish])
  return <Tooltip content={t('layout.sidebarResizeHint', { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH })} side="right"><div role="separator" aria-orientation="vertical" tabIndex={0}
    aria-label={t('layout.resizeSidebar')} aria-controls="workspace-sidebar"
    aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuemax={SIDEBAR_MAX_WIDTH} aria-valuenow={clampSidebarWidth(width)}
    className="group relative h-full w-1 shrink-0 touch-none cursor-col-resize bg-border/40 transition-colors hover:bg-primary focus-visible:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onPointerDown={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: clampSidebarWidth(width), cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }}
    onPointerMove={(event) => { if (drag.current?.pointerId === event.pointerId) onWidthChange(sidebarWidthFromDrag(drag.current.startWidth, drag.current.startX, event.clientX)) }}
    onPointerUp={(event) => { finish(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
    onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={() => onWidthChange(SIDEBAR_DEFAULT_WIDTH)}
    onKeyDown={(event) => {
      const next = event.key === 'Home' ? SIDEBAR_MIN_WIDTH : event.key === 'End' ? SIDEBAR_MAX_WIDTH
        : event.key === 'ArrowLeft' ? width - SIDEBAR_RESIZE_STEP : event.key === 'ArrowRight' ? width + SIDEBAR_RESIZE_STEP : null
      if (next == null) return
      event.preventDefault(); onWidthChange(clampSidebarWidth(next))
    }}><div className="absolute inset-y-0 -left-1 -right-1"/></div></Tooltip>
}
