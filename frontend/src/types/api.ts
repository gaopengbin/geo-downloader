export type Nullable<T> = T | null

export type OutputFormat = 'geotiff' | 'tiles' | 'mbtiles' | 'gpkg' | string

export interface Bounds {
  north: number
  south: number
  east: number
  west: number
}

export type Position = [number, number]
export type Polygon = Position[] | Position[][] | Record<string, unknown>

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
  source: string
  format: OutputFormat
  save_path?: Nullable<string>
  concurrency?: number
  proxy?: Nullable<string>
  polygon?: Nullable<Polygon>
  crop_to_shape?: boolean
  source_name?: string
  tianditu_token?: Nullable<string>
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
  | 'completed'
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
  id?: string
  version_id?: string
  name?: string
  date?: string
  release_date?: string
  [key: string]: unknown
}

export interface WaybackScanRequest {
  bounds: Bounds
  zoom_min?: number
  zoom_max?: number
  start_date?: Nullable<string>
  end_date?: Nullable<string>
  release_ids?: string[]
  scan_mode?: 'fast' | 'fine' | string
  proxy?: Nullable<string>
  force_refresh?: boolean
  [key: string]: unknown
}

export interface WaybackScanProgress {
  scan_id: string
  status: string
  progress: number
  message?: string
  result?: unknown
  [key: string]: unknown
}

export interface WaybackIncrementalRequest {
  scan_id?: string
  groups?: unknown[]
  output_dir?: string
  format?: OutputFormat
  [key: string]: unknown
}

export interface Tiles3dSource {
  url?: string
  path?: string
  headers?: Record<string, string>
  [key: string]: unknown
}

export interface Tiles3dTaskRequest {
  source: Tiles3dSource
  output_dir?: string
  polygon?: Nullable<Polygon>
  proxy?: Nullable<string>
  [key: string]: unknown
}
