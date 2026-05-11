import { create } from 'zustand'

import type { ReleaseNoteGroup } from './update-api'

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  noteGroups: ReleaseNoteGroup[]
  downloadUrl: string | null
  releaseUrl: string
}

export type UpdateCheckStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; message: string }
  | { kind: 'error'; message: string }

interface UpdateState {
  open: boolean
  info: UpdateInfo | null
  status: UpdateCheckStatus
  downloading: boolean
  progress: number
  showDialog: (info: UpdateInfo) => void
  closeDialog: () => void
  setStatus: (status: UpdateCheckStatus) => void
  setDownloading: (downloading: boolean) => void
  setProgress: (progress: number) => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  open: false,
  info: null,
  status: { kind: 'idle' },
  downloading: false,
  progress: 0,
  showDialog: (info) => set({ open: true, info, status: { kind: 'idle' }, downloading: false, progress: 0 }),
  closeDialog: () => set({ open: false, downloading: false, progress: 0 }),
  setStatus: (status) => set({ status }),
  setDownloading: (downloading) => set({ downloading }),
  setProgress: (progress) => set({ progress }),
}))
