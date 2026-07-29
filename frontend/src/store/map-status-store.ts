import { create } from 'zustand'

interface LeafletMapStatus {
  longitude: number | null
  latitude: number | null
  zoom: number | null
}

interface CesiumMapStatus {
  longitude: number | null
  latitude: number | null
  height: number | null
}

interface MapStatusState {
  leaflet: LeafletMapStatus
  cesium: CesiumMapStatus
  setLeafletPointer: (longitude: number | null, latitude: number | null) => void
  setLeafletZoom: (zoom: number | null) => void
  setCesiumPointer: (longitude: number | null, latitude: number | null) => void
  setCesiumHeight: (height: number | null) => void
}

export const useMapStatusStore = create<MapStatusState>((set) => ({
  leaflet: {
    longitude: null,
    latitude: null,
    zoom: null,
  },
  cesium: {
    longitude: null,
    latitude: null,
    height: null,
  },
  setLeafletPointer: (longitude, latitude) =>
    set((state) => ({
      leaflet: { ...state.leaflet, longitude, latitude },
    })),
  setLeafletZoom: (zoom) =>
    set((state) => ({
      leaflet: { ...state.leaflet, zoom },
    })),
  setCesiumPointer: (longitude, latitude) =>
    set((state) => ({
      cesium: { ...state.cesium, longitude, latitude },
    })),
  setCesiumHeight: (height) =>
    set((state) => ({
      cesium: { ...state.cesium, height },
    })),
}))
