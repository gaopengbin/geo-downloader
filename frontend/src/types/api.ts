export type Nullable<T> = T | null

export type OutputFormat = 'geotiff' | 'tiles' | 'mbtiles' | 'gpkg' | string

export interface Bounds {
  north: number
  south: number
  east: number
  west: number
}

export type Position = [number, number]
export interface PolygonCoord {
  lat: number
  lng: number
}
/** 后端 DownloadRequest.polygon 类型为 Vec<Vec<PolygonCoord>>（多环） */
export type Polygon = PolygonCoord[][]

export interface TileSource {
  id?: string
  key?: string
  name: string
  url?: string
  url_template?: string
  type?: string
  max_zoom?: number
  min_zoom?: number
  subdomains?: string[]
  headers?: Record<string, string>
  [key: string]: unknown
}

export interface AppSettings {
  /** 天地图 Token */
  tianditu_token?: Nullable<string>
  /** 是否启用代理 */
  proxy_enabled?: boolean
  /** 代理地址 */
  proxy_url?: string
  /** 默认并发数 */
  default_concurrency?: number
  /** 默认缩放级别 */
  default_zoom?: number
  /** 默认输出格式 */
  default_format?: OutputFormat
  /** 默认图源 ID */
  default_source?: string
  /** 自定义图源列表 */
  custom_sources?: CustomTileSource[]
  /** 内置图源覆盖配置（用户修改后的内置图源） */
  source_overrides?: CustomTileSource[]
  /** Cesium Ion Access Token */
  cesium_ion_token?: Nullable<string>
  /** 调试模式：保留临时瓦片目录 */
  debug_mode?: boolean
  /** 内存预算 (MB)，512 - 16384 */
  memory_budget_mb?: number
  /** 允许无效 HTTPS 证书（默认 false，安全风险） */
  allow_invalid_certs?: boolean
  /** 启用瓦片缓存（默认 true） */
  tile_cache_enabled?: boolean
  /** 瓦片缓存容量上限 MB，0 = 不限 */
  tile_cache_max_size_mb?: number
  /** 瓦片缓存目录（null = 默认 data_local_dir） */
  tile_cache_dir?: Nullable<string>
  /**
   * 自动导出最低成功率阈值 (0.0 - 1.0)，Issue #31。
   * 0.0 = 有 1 张成功就导出（默认幸福路径）；1.0 = 必须全成功才导出；
   * 中间值 = 允许指定比例缺洞自动导出，超出则进 Paused 待用户决策。
   */
  min_export_success_ratio?: number
  /**
   * 流式导出并行流水线的 strip 缓冲 MB，范围 16 - 512，默认 64。Issue #27。
   * 越大越能重叠 IO 与 CPU，代价是内存峰值上升。
   */
  export_buffer_mb?: number
}

/** 自定义瓦片图源（与 Rust CustomTileSource 对齐） */
export interface CustomTileSource {
  /** 图源 ID（自动生成，前缀 custom_） */
  id: string
  /** 显示名称 */
  name: string
  /** URL 模板，支持 {x}/{y}/{z}/{s} 占位符 */
  url: string
  /** 子域名，逗号分隔 */
  subdomains?: string
  /** 最大缩放级别（默认 18） */
  max_zoom?: number
}

export interface SystemMemoryInfo {
  total_mb: number
  available_mb: number
  recommended_budget_mb?: number
  [key: string]: unknown
}

export interface DownloadRequest {
  bounds: Bounds
  zoom: number
  zoom_max?: Nullable<number>
  /** 任意级别多选：非空时覆盖 zoom..=zoom_max */
  zoom_levels?: Nullable<number[]>
  source: string
  format: OutputFormat
  save_path?: Nullable<string>
  concurrency?: number
  proxy?: Nullable<string>
  polygon?: Nullable<Polygon>
  crop_to_shape?: boolean
  source_name?: string
  tianditu_token?: Nullable<string>
  /** TIFF 压缩方式: 'none' | 'lzw' | 'deflate'，默认 lzw */
  compression?: string
  /** 是否构建影像金字塔（仅 GeoTIFF） */
  build_pyramid?: boolean
  /** 叠加图层 ID 列表（按顺序自下而上叠在主源之上，仅栅格输出生效） */
  overlay_sources?: Nullable<string[]>
  [key: string]: unknown
}

export interface BudgetCheckResult {
  allowed: boolean
  message?: string
  estimated_mb?: number
  budget_mb?: number
  [key: string]: unknown
}

export interface DownloadEstimate {
  tile_count: number
  cols?: number
  rows?: number
  estimated_size_mb?: number
  estimated_size?: string
  allowed?: boolean
  warning?: Nullable<string>
  budget_check?: Nullable<BudgetCheckResult>
  raw_size_mb?: Nullable<number>
  size_note?: Nullable<string>
  /** 瓦片下载流量（MB） */
  tile_download_mb?: number
  /** 输出文件大小（MB），综合裁剪/金字塔/压缩后 */
  estimated_output_mb?: number
  zoom?: number
  zoom_max?: Nullable<number>
  levels?: Array<{ zoom: number; tile_count: number; estimated_size_mb?: number }>
  [key: string]: unknown
}

export interface CreateTaskResult {
  task_id: string
  tile_count: number
}

export interface DownloadResult {
  success: boolean
  file_path?: string
  file_size?: number
  tile_count?: number
  failed_count?: number
  task_id?: string
  [key: string]: unknown
}

export interface TileProbeResult {
  has_data: boolean
  status_code?: number
  content_length?: number
  message?: string
  [key: string]: unknown
}

export type TaskStatus =
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'merging'
  | 'processing'
  | 'exporting'
  | 'building_pyramid'
  | 'completed'
  /** Issue #31：部分失败但已自动导出（成功率 ≥ min_export_success_ratio + 含失败瓦片） */
  | 'completed_with_gaps'
  | 'failed'
  | 'cancelled'

export interface TaskInfo {
  id: string
  name: string
  source?: string
  source_name?: string
  zoom?: number
  format?: OutputFormat
  save_path?: string
  status: TaskStatus | string
  progress?: number
  completed?: number
  total?: number
  failed_count?: number
  /** Issue #31：成功瓦片数（completed - failed_count，由 TaskManager 自动推算） */
  success_count?: number
  file_size?: number
  message?: string
  error?: string
  [key: string]: unknown
}

export interface TaskLog {
  timestamp: string
  level: string
  message: string
}

/** 持久化任务（断点续传列表项） */
export interface PersistedTask {
  task_id: string
  task_name: string
  source_name: string
  request: DownloadRequest
  tile_count: number
  created_at: string
}

export interface TaskProgressPayload {
  task_id: string
  status: TaskStatus | string
  progress: number
  completed: number
  total: number
  message?: string
}

export interface DownloadHistoryRecord {
  id: string | number
  name: string
  source?: string
  source_name?: string
  zoom?: number
  format?: OutputFormat
  file_path?: string
  file_size?: number
  tile_count?: number
  failed_count?: number
  success?: boolean
  created_at?: string
  [key: string]: unknown
}

export interface AdminDivision {
  code: string
  name: string
  [key: string]: unknown
}

export interface WaybackVersion {
  id: string
  date: string
  title: string
  layer_id: string
  [key: string]: unknown
}

export interface WaybackScanRequest {
  bbox: [number, number, number, number]
  zoom_min: number
  zoom_max: number
  force_refresh?: boolean
  proxy?: Nullable<string>
  scan_mode?: 'fast' | 'fine' | 'official'
  release_date_from?: Nullable<string>
  release_date_to?: Nullable<string>
  [key: string]: unknown
}

export interface WaybackScanProgress {
  scan_id: string
  current: number
  total: number
  elapsed_sec: number
  footprints_so_far: number
}

export interface WaybackReleaseCapture {
  capture_date_str: string
  ratio: number
  source_name: string
  resolution_m: number
}

export interface WaybackReleaseSummary {
  release_id: string
  release_date: string
  release_num: number
  dominant_capture_date: string
  dominant_ratio: number
  coverage_ratio: number
  source_name: string
  resolution_m: number
  captures: WaybackReleaseCapture[]
}

export interface WaybackScanResult {
  bbox: [number, number, number, number]
  zoom_min: number
  zoom_max: number
  scan_mode: string
  scanned_at: string
  expires_at: string
  releases_scanned: number
  releases: WaybackReleaseSummary[]
  footprints?: unknown[]
}

export type ScanWaybackResponse =
  | { kind: 'result'; bbox: [number, number, number, number]; releases_scanned: number; releases: WaybackReleaseSummary[]; [key: string]: unknown }
  | { kind: 'scanning'; scan_id: string; total: number }

export interface WaybackFootprintSelect {
  release_id: string
  release_date: string
  capture_date_str: string
  source_name: string
  resolution_m: number
}

export interface WaybackIncrementalRequest {
  bounds: Bounds
  zoom: number
  zoom_max?: Nullable<number>
  /** 任意级别多选；非空时优先 */
  zoom_levels?: Nullable<number[]>
  format: OutputFormat
  save_path: string
  footprints: WaybackFootprintSelect[]
  crop_to_shape?: boolean
  polygon?: Nullable<PolygonCoord[]>
  compression?: string
  build_pyramid?: boolean
  task_name_prefix?: Nullable<string>
  proxy?: Nullable<string>
}

export interface WaybackIncrementalResult {
  task_ids: string[]
}

export type Tiles3dSource =
  | { type: 'cesium_ion'; asset_id: number; access_token: string }
  | { type: 'url'; tileset_url: string; headers?: Record<string, string> }

export interface TilesetSummary {
  version: string
  extent?: Nullable<[number, number, number, number]>
  total_tiles: number
  content_tiles: number
  max_depth: number
  levels: number
  has_external_tilesets: boolean
}

export interface Tiles3dEstimate {
  total_tiles: number
  filtered_tiles: number
  content_tiles: number
}

export interface Tiles3dTaskRequest {
  source: Tiles3dSource
  /** [[lng, lat], ...] WGS-84 度环 */
  polygon?: Nullable<number[][]>
  save_path: string
  concurrency?: number
  proxy?: Nullable<string>
}

