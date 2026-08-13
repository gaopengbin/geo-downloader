/**
 * Leaflet 瓦片图层包装：先查本地 mbtiles 缓存（命中走 base64），未命中走原始 URL，
 * 加载成功后异步把瓦片字节回写到缓存。
 *
 * 不可见时（window.__TAURI_INTERNALS__ 不存在）退化为普通 L.TileLayer。
 *
 * 后端命令见 src-tauri/src/commands.rs:
 *   - cache_get_tile(source, z, x, y) -> Option<{ contentType, base64 }>
 *   - cache_put_tile({ source, z, x, y, contentType, base64, displayName, urlTemplate, format })
 */

import L from 'leaflet'
import { resolveTileUrl } from './tile-url'
import { invokeCommand, isTauriRuntime } from '@/lib/tauri'

export interface CachedTileLayerOptions extends L.TileLayerOptions {
  /** 缓存的 source key（建议用稳定的英文标识，如 'world_imagery' 或 'wayback_2024-03-14'）*/
  sourceKey: string
  /** 用于回填 mbtiles metadata 的展示名（中文） */
  displayName?: string
  /** 用于元数据记录的 URL 模板（含占位符），缺省取传入的 url */
  urlTemplate?: string
  /** 强制写入缓存的 format（不指定时由 contentType 推断） */
  format?: 'png' | 'jpg' | 'webp' | 'pbf'
  /** 仅启用读，不写回（用于离线预览历史导出） */
  readOnly?: boolean
}

const TAURI = isTauriRuntime()

const CachedTileLayerImpl = L.TileLayer.extend({
  initialize: function (urlTemplate: string, options: CachedTileLayerOptions) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(L.TileLayer.prototype as any).initialize.call(this, urlTemplate, options)
    this._cacheSourceKey = options.sourceKey
    this._cacheUrlTemplate = options.urlTemplate ?? urlTemplate
    this._cacheDisplayName = options.displayName ?? options.sourceKey
    this._cacheFormat = options.format
    this._cacheReadOnly = options.readOnly === true
  },

  getTileUrl: function (coords: L.Coords): string {
    const zoom = this._getZoomForUrl() as number
    const subdomain = this._getSubdomain(coords) as string
    return resolveTileUrl(
      this._url,
      { x: coords.x, y: coords.y, z: zoom },
      subdomain,
      L.Browser.retina ? '@2x' : '',
    )
  },

  createTile: function (coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement('img') as HTMLImageElement
    tile.alt = ''
    tile.setAttribute('role', 'presentation')
    // crossOrigin 用于让命中后续 canvas 提取（保留开关）
    if (this.options.crossOrigin || this.options.crossOrigin === '') {
      tile.crossOrigin =
        this.options.crossOrigin === true ? '' : this.options.crossOrigin
    }
    if (typeof this.options.referrerPolicy === 'string') {
      tile.referrerPolicy = this.options.referrerPolicy
    }

    const onError = () => {
      done(new Error('tile load failed') as unknown as Error, tile)
    }
    const onLoadFromCache = () => {
      done(undefined, tile)
    }
    const onLoadFromNetwork = () => {
      done(undefined, tile)
      if (!this._cacheReadOnly && TAURI) {
        // 异步回写，不阻塞渲染
        this._writeBackTile(tile, coords).catch(() => {
          /* swallow */
        })
      }
    }

    if (TAURI) {
      // 先尝试缓存：直接走 gdcache 自定义协议（避免 base64 中转）
      // Tauri v2 在 Windows/Android 上以 http://<scheme>.localhost/... 暴露，其它平台为 <scheme>://localhost/...
      const isWindows = navigator.userAgent.toLowerCase().includes('windows')
      const cachePrefix = isWindows
        ? 'http://gdcache.localhost'
        : 'gdcache://localhost'
      const cacheUrl = `${cachePrefix}/${encodeURIComponent(this._cacheSourceKey)}/${coords.z}/${coords.x}/${coords.y}`
      tile.onload = onLoadFromCache
      tile.onerror = () => {
        // 缓存未命中或解码失败：回退到 URL
        this._loadFromNetwork(tile, coords, onLoadFromNetwork, onError)
      }
      tile.src = cacheUrl
    } else {
      this._loadFromNetwork(tile, coords, onLoadFromNetwork, onError)
    }
    return tile
  },

  _loadFromNetwork: function (
    tile: HTMLImageElement,
    coords: L.Coords,
    onLoad: () => void,
    onError: () => void,
  ) {
    tile.onload = onLoad
    tile.onerror = onError
    const url = this.getTileUrl(coords)
    tile.src = url
  },

  _writeBackTile: async function (
    _tile: HTMLImageElement,
    coords: L.Coords,
  ): Promise<void> {
    const url = this.getTileUrl(coords)
    let blob: Blob | null = null
    try {
      const resp = await fetch(url, { cache: 'force-cache' })
      if (resp.ok) blob = await resp.blob()
    } catch {
      // CORS or network error — fall through to backend fetch
    }
    if (blob && blob.size > 0 && blob.size <= 4 * 1024 * 1024) {
      const base64 = await blobToBase64(blob)
      if (!base64) return
      await invokeCommand('cache_put_tile', {
        req: {
          source: this._cacheSourceKey,
          z: coords.z,
          x: coords.x,
          y: coords.y,
          contentType: blob.type || 'image/png',
          base64,
          displayName: this._cacheDisplayName,
          urlTemplate: this._cacheUrlTemplate,
          format: this._cacheFormat,
        },
      })
    } else {
      await invokeCommand('fetch_and_cache_tile', {
        req: {
          url,
          source: this._cacheSourceKey,
          z: coords.z,
          x: coords.x,
          y: coords.y,
          displayName: this._cacheDisplayName,
          urlTemplate: this._cacheUrlTemplate,
          format: this._cacheFormat,
        },
      })
    }
  },
})

function blobToBase64(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const r = reader.result
      if (typeof r !== 'string') {
        resolve(null)
        return
      }
      const idx = r.indexOf(',')
      resolve(idx >= 0 ? r.slice(idx + 1) : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

export function createCachedTileLayer(
  urlTemplate: string,
  options: CachedTileLayerOptions,
): L.TileLayer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (CachedTileLayerImpl as any)(urlTemplate, options) as L.TileLayer
}
