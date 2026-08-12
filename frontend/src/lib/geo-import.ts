import type { GeoJsonObject } from 'geojson'
import shp, { combine, parseShp } from 'shpjs'
import JSZip from 'jszip'
import { kml as kmlToGeoJson } from '@tmcw/togeojson'
import { normalizeClosedKmlBoundaries } from './kml-region-normalizer'

const SUPPORTED_EXTENSIONS = ['.geojson', '.json', '.shp', '.zip', '.kml', '.kmz'] as const

export const SUPPORTED_REGION_FILE_EXTENSIONS: ReadonlyArray<string> = SUPPORTED_EXTENSIONS
export const REGION_FILE_ACCEPT_ATTR = SUPPORTED_EXTENSIONS.join(',')
export const REGION_FILE_FILTER_LABEL = '区域文件 (GeoJSON / Shapefile / KML / KMZ)'

export class UnsupportedRegionFileError extends Error {
  constructor(filename: string) {
    super(
      `不支持的格式：${filename}。仅支持 ${SUPPORTED_EXTENSIONS.join(' / ')}`,
    )
    this.name = 'UnsupportedRegionFileError'
  }
}

/**
 * 把 shpjs 内部 but-unzip 库抛出的 `but-unzip~N` 错误翻译成用户能看懂的中文提示。
 * 错误码定义见 but-unzip/index.browser.min.mjs：
 *   ~1 不支持的压缩方法（仅支持 store / deflate）
 *   ~2 找不到 EOCD signature → 传入的不是有效 ZIP
 *   ~3 Zip64 / 跨多盘 ZIP
 */
function translateShapefileError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)
  const match = /^but-unzip~(\d)/.exec(msg)
  if (!match) {
    return err instanceof Error ? err : new Error(msg)
  }
  switch (match[1]) {
    case '1':
      return new Error(
        'Shapefile ZIP 使用了不支持的压缩方法（仅支持 store / deflate）。请重新打包成标准 ZIP。',
      )
    case '2':
      return new Error(
        '无效或损坏的 Shapefile ZIP。请确认上传的是完整 ZIP 压缩包，且包含 .shp / .dbf / .prj / .shx 全套文件。',
      )
    case '3':
      return new Error(
        'Shapefile 使用了 Zip64 或跨多盘 ZIP 格式，暂不支持。请重新打包成单文件标准 ZIP。',
      )
    default:
      return new Error(`Shapefile 解压失败：${msg}`)
  }
}

function parseKmlText(text: string): GeoJsonObject {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const errNode = doc.querySelector('parsererror')
  if (errNode) {
    throw new Error('KML XML 解析失败')
  }
  const geojson = kmlToGeoJson(doc) as unknown as GeoJsonObject
  return normalizeClosedKmlBoundaries(geojson)
}

async function parseKmzBuffer(buf: ArrayBuffer): Promise<GeoJsonObject> {
  const zip = await JSZip.loadAsync(buf)
  // 优先 doc.kml；否则取首个 .kml
  const direct = zip.file(/^doc\.kml$/i)?.[0] ?? zip.file(/\.kml$/i)?.[0]
  if (!direct) {
    throw new Error('KMZ 中未找到 .kml 文件')
  }
  const text = await direct.async('text')
  return parseKmlText(text)
}

/**
 * 统一读取区域文件（GeoJSON / Shapefile zip / .shp / KML / KMZ），返回 GeoJSON 对象。
 * 不做空几何校验，调用方负责后续校验与提取。
 */
export async function parseRegionFile(file: File): Promise<GeoJsonObject> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.geojson') || name.endsWith('.json')) {
    const text = await file.text()
    return JSON.parse(text) as GeoJsonObject
  }
  if (name.endsWith('.zip')) {
    const buf = await file.arrayBuffer()
    try {
      return (await shp(buf)) as GeoJsonObject
    } catch (e) {
      throw translateShapefileError(e)
    }
  }
  if (name.endsWith('.shp')) {
    // 单独的 .shp 文件没有 .dbf/.prj/.shx，shpjs 默认入口走 ZIP 解析会报 but-unzip~2。
    // 改走 parseShp 拿到几何数组，再用 combine 包成空属性 FeatureCollection — 圈选下载区域只需几何。
    const buf = await file.arrayBuffer()
    try {
      const geoms = parseShp(buf)
      return combine([geoms, null]) as unknown as GeoJsonObject
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(
        `Shapefile 几何解析失败：${msg}。建议改用完整 ZIP（含 .shp/.dbf/.prj/.shx）以保留属性与坐标参考。`,
      )
    }
  }
  if (name.endsWith('.kml')) {
    const text = await file.text()
    return parseKmlText(text)
  }
  if (name.endsWith('.kmz')) {
    const buf = await file.arrayBuffer()
    return await parseKmzBuffer(buf)
  }
  throw new UnsupportedRegionFileError(file.name)
}
