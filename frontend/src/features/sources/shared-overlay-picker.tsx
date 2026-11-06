import { useAppStore, type AppMode } from '@/store/app-store'
import type { TileSource } from '@/types/api'
import { EMPTY_OVERLAY_SELECTION } from './layer-selection'
import { OverlayPicker } from './overlay-picker'
import { FoundationControls } from '@/features/foundation/foundation-controls'

export function SharedOverlayPicker({ mode, sources, baseId, target = 'download' }: {
  mode: AppMode; sources: Record<string, TileSource>; baseId?: string | null; target?: 'preview' | 'download'
}) {
  const selection = useAppStore((state) => state.overlayLayersByMode[mode]) ?? EMPTY_OVERLAY_SELECTION
  const setSources = useAppStore((state) => state.setOverlaySources)
  const setVisible = useAppStore((state) => state.setOverlayVisibility)
  return <div className="space-y-3">
    <OverlayPicker sources={sources} baseId={baseId} value={selection.map((entry) => entry.sourceId)}
      selection={selection} target={target} onChange={(ids) => setSources(mode, ids)}
      onVisibilityChange={(id, visible) => setVisible(mode, id, visible)} />
    <FoundationControls />
  </div>
}
