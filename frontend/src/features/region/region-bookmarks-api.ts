import { invokeCommand } from '@/lib/tauri'
import type { LatLngRing, MapBounds } from '@/store/selection-store'

export interface RegionBookmark {
  id: string
  name: string
  bounds: MapBounds
  polygon: LatLngRing[] | null
  created_at: string
  updated_at: string
}

export function listRegionBookmarks() {
  return invokeCommand<RegionBookmark[]>('list_region_bookmarks')
}

export function createRegionBookmark(input: {
  name: string
  bounds: MapBounds
  polygon: LatLngRing[] | null
}) {
  return invokeCommand<RegionBookmark>('create_region_bookmark', input)
}

export function renameRegionBookmark(id: string, name: string) {
  return invokeCommand<RegionBookmark>('rename_region_bookmark', { id, name })
}

export function deleteRegionBookmark(id: string) {
  return invokeCommand<void>('delete_region_bookmark', { id })
}
