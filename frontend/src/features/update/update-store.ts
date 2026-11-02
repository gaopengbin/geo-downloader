import { create } from 'zustand'

import type { ReleaseNoteGroup } from './update-api'
import type { UpdateTransfer } from './update-transfer'

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  noteGroups: ReleaseNoteGroup[]
  downloadUrl: string | null
  releaseUrl: string
  expectedSha256: string
  expectedSize: number
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
  transfer: UpdateTransfer | null
  showDialog: (info: UpdateInfo) => void
  closeDialog: () => void
  setStatus: (status: UpdateCheckStatus) => void
  setDownloading: (downloading: boolean) => void
  setProgress: (progress: number) => void
  setTransfer: (transfer: UpdateTransfer | null) => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  open: false,
  info: null,
  status: { kind: 'idle' },
  downloading: false,
  progress: 0,
  transfer: null,
  showDialog: (info) => set({ open: true, info, status: { kind: 'idle' }, downloading: false, progress: 0, transfer: null }),
  closeDialog: () => set({ open: false, downloading: false, progress: 0, transfer: null }),
  setStatus: (status) => set({ status }),
  setDownloading: (downloading) => set({ downloading }),
  setProgress: (progress) => set({ progress }),
  setTransfer: (transfer) => set({ transfer }),
}))
