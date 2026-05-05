import { QR_ASSETS, type QrKey } from '@/lib/qr-assets'

/**
 * 返回二维码远程 URL，由 <img> 标签直接加载。
 *
 * 说明：早期版本曾使用 fetch() + localStorage 缓存 dataURL，但 GitHub Releases
 * 资源不带 Access-Control-Allow-Origin，WebView2 的 fetch() 被 CORS 拦截，
 * 导致永远静默回退到打包进 App 的本地兜底图。<img> 标签不受 CORS 约束，
 * 加载失败时由调用方的 onError={fallbackToLocal} 兜底。
 */
export function useCachedImage(key: QrKey): string {
  return QR_ASSETS[key].remote
}
