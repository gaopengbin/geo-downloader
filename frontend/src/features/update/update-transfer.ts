export interface UpdateTransfer {
  source: 'mirror' | 'github'
  phase: 'downloading' | 'switching' | 'verifying' | 'installing'
  attempt: number
  progress: number
  downloaded: number
  total: number
  bytesPerSecond: number
  reason: 'slow' | 'timeout' | 'unavailable' | 'invalid' | null
}

export function installerIntegrity(asset: { size?: unknown; sha256?: unknown; digest?: unknown }) {
  const raw = typeof asset.sha256 === 'string' && asset.sha256
    ? asset.sha256 : typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : ''
  if (!/^[a-f\d]{64}$/i.test(raw) || typeof asset.size !== 'number'
    || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error('UPDATE_INTEGRITY_MISSING')
  }
  return { expectedSha256: raw.toLowerCase(), expectedSize: asset.size }
}

export function updateSpeed(bytesPerSecond: number) {
  const speed = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0
  return speed >= 1024 * 1024 ? `${(speed / 1024 / 1024).toFixed(1)} MB/s` : `${(speed / 1024).toFixed(1)} KB/s`
}
