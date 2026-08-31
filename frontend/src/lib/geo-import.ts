import type { Feature, GeoJsonObject } from 'geojson'
import shp, { combine, parseShp } from 'shpjs'
import JSZip from 'jszip'
import proj4 from 'proj4'
import { basename } from '@tauri-apps/api/path'
import { readFile } from '@tauri-apps/plugin-fs'
import { kml as kmlToGeoJson } from '@tmcw/togeojson'
import { normalizeClosedKmlBoundaries } from './kml-region-normalizer.ts'
import { invokeCommand } from './tauri.ts'

const SUPPORTED_EXTENSIONS = ['.geojson', '.json', '.shp', '.zip', '.kml', '.kmz'] as const

export const SUPPORTED_REGION_FILE_EXTENSIONS: ReadonlyArray<string> = SUPPORTED_EXTENSIONS
export const REGION_FILE_ACCEPT_ATTR = SUPPORTED_EXTENSIONS.join(',')
export const REGION_FILE_FILTER_LABEL = '区域文件 (GeoJSON / Shapefile / KML / KMZ)'

export interface RegionCrsInfo {
  status: 'standard' | 'declared' | 'missing'
  label: string
  sidecars: string[]
  needsConfirmation: boolean
}

export interface ParsedRegionFile {
  geojson: GeoJsonObject
  filename: string
  crs: RegionCrsInfo
}

export interface CoordinateValidation {
  valid: boolean
  coordinateCount: number
  invalidCount: number
  firstInvalid: [number, number] | null
}

interface ShapefileSidecarFile {
  path: string
  name: string
  extension: string
}

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

function standardCrs(label = 'WGS 84（EPSG:4326）'): RegionCrsInfo {
  return { status: 'standard', label, sidecars: [], needsConfirmation: false }
}

function missingShapefileCrs(sidecars: string[] = []): RegionCrsInfo {
  return {
    status: 'missing',
    label: '未找到 .prj，坐标系未知',
    sidecars,
    needsConfirmation: true,
  }
}

function projectionLabel(wkt: string): string {
  const directEpsg = /^EPSG\s*:\s*(\d+)$/i.exec(wkt.trim())?.[1]
  if (directEpsg) return `EPSG:${directEpsg}`
  const epsgMatches = Array.from(
    wkt.matchAll(/(?:AUTHORITY|ID)\s*\[\s*["']EPSG["']\s*,\s*["']?(\d+)["']?\s*\]/gi),
  )
  const epsg = epsgMatches.at(-1)?.[1]
  if (epsg) return `EPSG:${epsg}`
  const name = /^(?:PROJCS|GEOGCS)\s*\[\s*["']([^"']+)["']/i.exec(wkt.trim())?.[1]
  return name || '已从 .prj 读取坐标系'
}

function validateProjection(wkt: string, filename: string): string {
  const trimmed = wkt.trim()
  if (!trimmed) throw new Error(`${filename} 为空，无法识别坐标系`)
  try {
    proj4(trimmed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${filename} 无法解析：${message}`, { cause: error })
  }
  return projectionLabel(trimmed)
}

function normalizeShapefileResult(value: unknown): GeoJsonObject {
  if (!Array.isArray(value)) return value as GeoJsonObject
  const features = value.flatMap((collection, collectionIndex) => {
    if (!collection || typeof collection !== 'object' || !('features' in collection)) return []
    const sourceFile = 'fileName' in collection && typeof collection.fileName === 'string'
      ? collection.fileName
      : `layer-${collectionIndex + 1}`
    const sourceFeatures = Array.isArray(collection.features) ? collection.features as Feature[] : []
    return sourceFeatures.map((feature: Feature) => ({
      ...feature,
      properties: {
        ...(feature && typeof feature === 'object' && 'properties' in feature && feature.properties
          ? feature.properties
          : {}),
        __source_file: sourceFile,
      },
    }))
  })
  return { type: 'FeatureCollection', features } as GeoJsonObject
}

function visitGeometryCoordinates(geometry: unknown, visit: (position: unknown) => void) {
  if (!geometry || typeof geometry !== 'object') return
  const value = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown[] }
  if (value.type === 'GeometryCollection') {
    value.geometries?.forEach((child) => visitGeometryCoordinates(child, visit))
    return
  }
  const walk = (coordinates: unknown) => {
    if (!Array.isArray(coordinates)) return
    if (
      coordinates.length >= 2 &&
      typeof coordinates[0] === 'number' &&
      typeof coordinates[1] === 'number'
    ) {
      visit(coordinates)
      return
    }
    coordinates.forEach(walk)
  }
  walk(value.coordinates)
}

/** Validate coordinates after every importer has normalized them to WGS84 longitude/latitude. */
export function validateWgs84Coordinates(geojson: GeoJsonObject): CoordinateValidation {
  let coordinateCount = 0
  let invalidCount = 0
  let firstInvalid: [number, number] | null = null
  const visit = (position: unknown) => {
    const [lng, lat] = position as number[]
    coordinateCount += 1
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      invalidCount += 1
      firstInvalid ??= [lng, lat]
    }
  }
  const value = geojson as unknown as {
    type?: string
    geometry?: unknown
    features?: Array<{ geometry?: unknown }>
    geometries?: unknown[]
  }
  if (value.type === 'FeatureCollection') {
    value.features?.forEach((feature) => visitGeometryCoordinates(feature.geometry, visit))
  } else if (value.type === 'Feature') {
    visitGeometryCoordinates(value.geometry, visit)
  } else {
    visitGeometryCoordinates(value, visit)
  }
  return {
    valid: coordinateCount > 0 && invalidCount === 0,
    coordinateCount,
    invalidCount,
    firstInvalid,
  }
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
export async function parseRegionFile(file: File): Promise<ParsedRegionFile> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.geojson') || name.endsWith('.json')) {
    const text = await file.text()
    return { geojson: JSON.parse(text) as GeoJsonObject, filename: file.name, crs: standardCrs() }
  }
  if (name.endsWith('.zip')) {
    const buf = await file.arrayBuffer()
    try {
      const zip = await JSZip.loadAsync(buf)
      const entries = Object.values(zip.files).filter((entry) => !entry.dir)
      const sidecars = entries
        .map((entry) => entry.name.split('/').pop() ?? entry.name)
        .filter((entryName) => /\.(shp|shx|dbf|prj|cpg)$/i.test(entryName))
      const projectionFiles = entries.filter((entry) => /\.prj$/i.test(entry.name))
      const labels = await Promise.all(projectionFiles.map(async (entry) => {
        const wkt = await entry.async('text')
        return validateProjection(wkt, entry.name)
      }))
      const crs = projectionFiles.length > 0
        ? {
            status: 'declared' as const,
            label: Array.from(new Set(labels)).join(' / '),
            sidecars,
            needsConfirmation: false,
          }
        : missingShapefileCrs(sidecars)
      const geojson = normalizeShapefileResult(await shp(buf))
      return { geojson, filename: file.name, crs }
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
      return {
        geojson: combine([geoms, null]) as unknown as GeoJsonObject,
        filename: file.name,
        crs: missingShapefileCrs(['.shp']),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(
        `Shapefile 几何解析失败：${msg}。建议改用完整 ZIP（含 .shp/.dbf/.prj/.shx）以保留属性与坐标参考。`,
        { cause: e },
      )
    }
  }
  if (name.endsWith('.kml')) {
    const text = await file.text()
    return { geojson: parseKmlText(text), filename: file.name, crs: standardCrs() }
  }
  if (name.endsWith('.kmz')) {
    const buf = await file.arrayBuffer()
    return { geojson: await parseKmzBuffer(buf), filename: file.name, crs: standardCrs() }
  }
  throw new UnsupportedRegionFileError(file.name)
}

/** Read a desktop-selected file and discover same-basename Shapefile sidecars. */
export async function parseRegionPath(path: string): Promise<ParsedRegionFile> {
  const filename = await basename(path)
  if (!/\.shp$/i.test(filename)) {
    const bytes = await readFile(path)
    return parseRegionFile(new File([bytes], filename))
  }

  const sidecars = await invokeCommand<ShapefileSidecarFile[]>(
    'authorize_shapefile_sidecars',
    { path },
  )
  const matching = new Map(sidecars.map((sidecar) => [sidecar.extension, sidecar]))

  const readSidecar = async (extension: string) => {
    const sidecar = matching.get(extension)
    return sidecar ? readFile(sidecar.path) : undefined
  }
  const shpBytes = await readSidecar('shp') ?? await readFile(path)
  const dbfBytes = await readSidecar('dbf')
  const prjBytes = await readSidecar('prj')
  const cpgBytes = await readSidecar('cpg')
  const sidecarNames = sidecars.map((sidecar) => sidecar.name)
  let crs = missingShapefileCrs(sidecarNames)
  if (prjBytes) {
    const wkt = new TextDecoder().decode(prjBytes)
    crs = {
      status: 'declared',
      label: validateProjection(wkt, matching.get('prj')?.name ?? `${filename}.prj`),
      sidecars: sidecarNames,
      needsConfirmation: false,
    }
  }
  const geojson = normalizeShapefileResult(await shp({
    shp: shpBytes,
    dbf: dbfBytes,
    prj: prjBytes,
    cpg: cpgBytes,
  }))
  return { geojson, filename, crs }
}
