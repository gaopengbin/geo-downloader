/**
 * 二维码远程资源（镜像服务器托管）
 *
 * 更新方式：
 *   1. 替换服务器上 C:\nginx-1.30.2\packages\qr-assets\ 下的图片（保持同名）
 *   2. 或更新 GitHub Release (tag: assets) 后手动同步到服务器
 *
 * 加载失败时会自动回退到打包进 App 的本地图（保证断网或服务器不可用时不裂图）。
 */

const REMOTE_BASE =
  'https://laogao.xyz/packages/qr-assets'

export type QrKey = 'gzh' | 'wxq' | 'wx' | 'zfb'

export const QR_ASSETS: Record<QrKey, { remote: string; local: string }> = {
  gzh: { remote: `${REMOTE_BASE}/gzh.jpg`, local: '/images/gzh.jpg' },
  wxq: { remote: `${REMOTE_BASE}/wxq_sq.png`, local: '/images/wxq_sq.png' },
  wx: { remote: `${REMOTE_BASE}/wx.jpg`, local: '/images/wx.jpg' },
  zfb: { remote: `${REMOTE_BASE}/zfb.jpg`, local: '/images/zfb.jpg' },
}

/**
 * 给 <img> 用的 onError 回退处理：远程加载失败时切到本地图，避免无限循环。
 */
export function fallbackToLocal(
  e: React.SyntheticEvent<HTMLImageElement>,
  key: QrKey,
) {
  const img = e.currentTarget
  const local = QR_ASSETS[key].local
  if (img.dataset.fallback === '1') return
  img.dataset.fallback = '1'
  img.src = local
}
