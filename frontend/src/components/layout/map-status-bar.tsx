import { useAppStore } from '@/store/app-store'
import { useMapStatusStore } from '@/store/map-status-store'

function formatCoordinate(value: number | null) {
  return value === null ? '--' : value.toFixed(6)
}

function formatHeight(value: number | null) {
  if (value === null) return '--'
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${value.toFixed(0)} m`
}

export function MapStatusBar() {
  const isTiles3d = useAppStore((state) => state.mode === 'tiles3d')
  const leaflet = useMapStatusStore((state) => state.leaflet)
  const cesium = useMapStatusStore((state) => state.cesium)
  const status = isTiles3d ? cesium : leaflet

  return (
    <footer className="flex h-6 shrink-0 items-center justify-end border-t border-border/60 bg-muted/30 px-3 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 items-center justify-end gap-3 tabular-nums">
        <span className="font-medium text-foreground/70">{isTiles3d ? '3D 坐标' : '地图坐标'}</span>
        <span>经度 {formatCoordinate(status.longitude)}</span>
        <span>纬度 {formatCoordinate(status.latitude)}</span>
        <span className="shrink-0">
          {isTiles3d
            ? `高度 ${formatHeight(cesium.height)}`
            : `缩放 ${leaflet.zoom === null ? '--' : leaflet.zoom}`}
        </span>
      </div>
    </footer>
  )
}
