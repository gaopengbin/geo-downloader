/**
 * 二维码远程资源（GitHub Releases 托管）
 *
 * 更新方式（无需 commit 代码）：
 *   1. 打开 https://github.com/gaopengbin/geo-downloader/releases/tag/assets
 *   2. 点击 "Edit" → 删掉旧图 → 拖拽新图（保持同名）→ Save
 *   3. 全平台（桌面 App / 官网 / README）即时生效
 *
 * 加载失败时会自动回退到打包进 App 的本地图（保证断网或 release 资源被删时不裂图）。
 */

const REMOTE_BASE =
  'https://github.com/gaopengbin/geo-downloader/releases/download/assets'

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
