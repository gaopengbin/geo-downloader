export const SIDEBAR_MIN_WIDTH = 380
export const SIDEBAR_MAX_WIDTH = 600
export const SIDEBAR_DEFAULT_WIDTH = 380
export const SIDEBAR_RESIZE_STEP = 20

export function clampSidebarWidth(width: number) {
  return Number.isFinite(width)
    ? Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)))
    : SIDEBAR_DEFAULT_WIDTH
}

export function sidebarWidthFromDrag(startWidth: number, startX: number, currentX: number) {
  return clampSidebarWidth(startWidth + currentX - startX)
}
