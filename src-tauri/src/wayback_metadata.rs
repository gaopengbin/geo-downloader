//! Esri Wayback 元数据扫描与去重模块
//!
//! 扫描所有 Wayback release 的 metadata MapServer，按拍摄日期+几何去重，
//! 生成"独立拍摄清单"，避免按 release 全量下载产生的冗余。
//!
//! 详细设计见 docs/wayback-incremental-design.md

use crate::wayback::{fetch_releases_raw, WaybackReleaseRaw};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

/// 缓存 TTL（秒）= 7 天
const CACHE_TTL_SEC: i64 = 7 * 24 * 3600;
/// 最大缓存条目数
const CACHE_MAX_ENTRIES: usize = 50;
/// 扫描并发上限（dead_services 已可保护避免对故障服务持续打击，恢复到 8 提升速度）
const SCAN_CONCURRENCY: usize = 8;
/// 单次 metadata 查询超时（秒）
const QUERY_TIMEOUT_SEC: u64 = 20;
/// 网络错误最大重试次数（5xx 不重试）
const QUERY_MAX_RETRIES: u32 = 4;
/// 重试退避基数（毫秒），实际等待 = 基数 × 2^attempt
const RETRY_BACKOFF_BASE_MS: u64 = 1500;

// ============================================================
// 数据结构
// ============================================================

/// 一次"独立拍摄"的描述
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaybackFootprint {
    /// Unix 秒（从 SRC_DATE2 ms 截断到日）
    pub capture_date: i64,
    /// "YYYY-MM-DD"
    pub capture_date_str: String,
    /// 数据源（NICE_NAME，如 "Vivid Advanced"）
    pub source_name: String,
    /// 空间分辨率（米）
    pub resolution_m: f64,
    pub min_map_level: u32,
    pub max_map_level: u32,
    /// 最老包含此影像的 release id（waybackconfig 的 key）
    pub release_id: String,
    /// 该 release 的日期字符串（如 "2026-03-26"）
    pub release_date: String,
    /// release 顺序号（用于"最老 release"判定）
    pub release_num: u32,
    /// footprint 几何（GeoJSON Geometry，原样保存）
    pub geometry: Value,
    /// 几何去重哈希
    pub geometry_hash: String,
    /// 与用户 polygon 的覆盖比例（0..1），简化阶段用 bbox 估算
    pub coverage_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaybackScanResult {
    pub bbox: [f64; 4],
    pub zoom_min: u32,
    pub zoom_max: u32,
    /// 生成该缓存/扫描结果时使用的模式："fast" 或 "fine"
    #[serde(default = "default_scan_mode")]
    pub scan_mode: String,
    pub scanned_at: String,
    pub expires_at: String,
    pub releases_scanned: u32,
    /// 全部去重后的 footprint（保留兼容）
    pub footprints: Vec<WaybackFootprint>,
    /// 服务级聚合：每个 release 在 bbox 内的拍摄日期分布与主导日期
    #[serde(default)]
    pub releases: Vec<ReleaseSummary>,
}

/// 单个 release 在 bbox 内的拍摄日期分布摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseSummary {
    pub release_id: String,
    pub release_date: String,
    pub release_num: u32,
    /// 主导拍摄日期（占比最高），无数据时为空串
    pub dominant_capture_date: String,
    /// 主导日期占该 release 在 bbox 内总 footprint 面积的比例 (0..1)
    pub dominant_ratio: f64,
    /// 该 release 在 bbox 内 footprint 合计 / 用户 bbox 面积 (0..1)
    pub coverage_ratio: f64,
    /// 主导日期对应的数据源名（如 "Vivid Advanced"）
    pub source_name: String,
    /// 主导日期对应的分辨率（米）
    pub resolution_m: f64,
    /// 该 release 在 bbox 内的全部拍摄日期分布（按 ratio 倒序）
    pub captures: Vec<ReleaseCaptureBreakdown>,
}

/// release 内某个拍摄日期的分布项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseCaptureBreakdown {
    pub capture_date_str: String,
    pub ratio: f64,
    pub source_name: String,
    pub resolution_m: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WaybackScanProgress {
    pub scan_id: String,
    pub current: u32,
    pub total: u32,
    pub elapsed_sec: u64,
    pub footprints_so_far: u32,
}

// ============================================================
// zoom -> layer 映射
// ============================================================

/// 根据 zoom 范围选取需要查询的 metadata layer 集合
pub fn select_layers(z_min: u32, z_max: u32) -> Vec<u32> {
    let mut layers = HashSet::new();
    for zoom in z_min..=z_max {
        let layer = match zoom {
            22.. => 0,
            21 => 1,
            20 => 2,
            18..=19 => 3,
            17 => 4,
            16 => 5,
            14..=15 => 6,
            13 => 7,
            11..=12 => 9,
            10 => 10,
            9 => 11,
            _ => 12,
        };
        layers.insert(layer);
    }
    let mut v: Vec<u32> = layers.into_iter().collect();
    v.sort();
    v
}

fn default_scan_mode() -> String {
    "fast".to_string()
}

/// 规范化前端传入的扫描模式，避免未知值污染缓存键。
pub fn normalize_scan_mode(scan_mode: Option<&str>) -> String {
    match scan_mode {
        Some("fine") => "fine".to_string(),
        Some("official") => "official".to_string(),
        _ => "fast".to_string(),
    }
}

// ============================================================
// 进度跟踪
// ============================================================

#[derive(Default)]
pub struct ScanState {
    current: u32,
    total: u32,
    started_at: Option<std::time::Instant>,
    footprints_so_far: u32,
}

pub type ScanProgressMap = Arc<Mutex<HashMap<String, ScanState>>>;

pub fn new_progress_map() -> ScanProgressMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub async fn get_progress(map: &ScanProgressMap, scan_id: &str) -> Option<WaybackScanProgress> {
    let m = map.lock().await;
    m.get(scan_id).map(|s| WaybackScanProgress {
        scan_id: scan_id.to_string(),
        current: s.current,
        total: s.total,
        elapsed_sec: s.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0),
        footprints_so_far: s.footprints_so_far,
    })
}

/// 命令入口处提前占位，避免 fetch_releases_raw 期间前端轮询拿到 None
pub async fn insert_placeholder_progress(map: &ScanProgressMap, scan_id: &str, total: u32) {
    let mut m = map.lock().await;
    m.insert(
        scan_id.to_string(),
        ScanState {
            current: 0,
            total,
            started_at: Some(std::time::Instant::now()),
            footprints_so_far: 0,
        },
    );
}

// ============================================================
// 缓存管理
// ============================================================

fn cache_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|p| p.join("geo-downloader").join("wayback_cache"))
        .ok_or_else(|| "无法获取缓存目录".to_string())
}

/// bbox + zoom 范围 + 扫描模式的稳定哈希前缀，用作缓存文件名
fn cache_key(bbox: &[f64; 4], z_min: u32, z_max: u32, scan_mode: &str) -> String {
    let scan_mode = normalize_scan_mode(Some(scan_mode));
    let s = format!(
        "{:.6},{:.6},{:.6},{:.6}|{}|{}|{}",
        bbox[0], bbox[1], bbox[2], bbox[3], z_min, z_max, scan_mode
    );
    let h = simple_hash64(s.as_bytes());
    format!("{:016x}", h)
}

fn cache_path(bbox: &[f64; 4], z_min: u32, z_max: u32, scan_mode: &str) -> Result<PathBuf, String> {
    let dir = cache_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;
    Ok(dir.join(format!("{}.json", cache_key(bbox, z_min, z_max, scan_mode))))
}

fn load_cache(bbox: &[f64; 4], z_min: u32, z_max: u32, scan_mode: &str) -> Option<WaybackScanResult> {
    let path = cache_path(bbox, z_min, z_max, scan_mode).ok()?;
    if !path.exists() {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let result: WaybackScanResult = serde_json::from_slice(&bytes).ok()?;
    let expires = chrono::DateTime::parse_from_rfc3339(&result.expires_at).ok()?;
    if chrono::Utc::now() > expires {
        return None;
    }
    Some(result)
}

/// 对外暴露的缓存读取入口
pub fn try_load_cache(bbox: &[f64; 4], z_min: u32, z_max: u32, scan_mode: &str) -> Option<WaybackScanResult> {
    load_cache(bbox, z_min, z_max, scan_mode)
}

/// 按 release_date 范围过滤扫描结果（不改写缓存，仅返回视图）
pub fn filter_result_by_date(
    mut result: WaybackScanResult,
    date_from: Option<&str>,
    date_to: Option<&str>,
) -> WaybackScanResult {
    let from_ok = date_from.map(|s| !s.is_empty()).unwrap_or(false);
    let to_ok = date_to.map(|s| !s.is_empty()).unwrap_or(false);
    if !from_ok && !to_ok {
        return result;
    }
    let from = date_from.unwrap_or("");
    let to = date_to.unwrap_or("");
    let pass = |d: &str| -> bool {
        if from_ok && d < from { return false; }
        if to_ok && d > to { return false; }
        true
    };
    result.footprints.retain(|f| pass(&f.release_date));
    result.releases.retain(|r| pass(&r.release_date));
    result.releases_scanned = result.releases.len() as u32;
    result
}

fn save_cache(result: &WaybackScanResult) -> Result<(), String> {
    let path = cache_path(&result.bbox, result.zoom_min, result.zoom_max, &result.scan_mode)?;
    let json = serde_json::to_vec(result).map_err(|e| format!("序列化缓存失败: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("写入缓存失败: {}", e))?;
    prune_cache_lru().ok();
    Ok(())
}

/// LRU 淘汰多余缓存条目
fn prune_cache_lru() -> Result<(), String> {
    let dir = cache_dir()?;
    let entries: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| format!("读取缓存目录失败: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .collect();
    if entries.len() <= CACHE_MAX_ENTRIES {
        return Ok(());
    }
    let mut with_meta: Vec<_> = entries
        .into_iter()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            let mtime = m.modified().ok()?;
            Some((e.path(), mtime))
        })
        .collect();
    with_meta.sort_by_key(|(_, t)| *t); // 旧的在前
    let to_remove = with_meta.len() - CACHE_MAX_ENTRIES;
    for (path, _) in with_meta.into_iter().take(to_remove) {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

// ============================================================
// 主入口：扫描
// ============================================================

#[allow(clippy::too_many_arguments)]
pub async fn scan_metadata(
    bbox: [f64; 4],
    z_min: u32,
    z_max: u32,
    force_refresh: bool,
    proxy: Option<String>,
    progress: ScanProgressMap,
    scan_id: String,
    scan_mode: String,
) -> Result<WaybackScanResult, String> {
    let scan_mode = normalize_scan_mode(Some(&scan_mode));

    if !force_refresh {
        if let Some(cached) = load_cache(&bbox, z_min, z_max, &scan_mode) {
            log::info!(
                "wayback metadata: 使用缓存 (mode={}, {} footprints, scanned_at {})",
                cached.scan_mode,
                cached.footprints.len(),
                cached.scanned_at
            );
            return Ok(cached);
        }
    }

    // 扫描模式：
    // - official: 仅在 AOI 中心一个 tile 上探探 zoom_max 单 layer，最快（对齐官方「only versions with local changes」）
    // - fast: 仅 zoom_max 单 layer，查询 AOI 完整 bbox（默认）
    // - fine: 多 layer，查询 AOI 完整 bbox（更准）
    let layers = if scan_mode == "fine" {
        select_layers(z_min, z_max)
    } else {
        select_layers(z_max, z_max)
    };
    if layers.is_empty() {
        return Err("zoom 范围无效".to_string());
    }
    // official 模式使用 AOI 中心 tile 的微小 bbox，其余模式使用完整 bbox
    let query_bbox: [f64; 4] = if scan_mode == "official" {
        let cx = (bbox[0] + bbox[2]) / 2.0;
        let cy = (bbox[1] + bbox[3]) / 2.0;
        // 在 zoom_max 上一个 tile 的经度宽度（度）
        let tile_deg = 360.0 / (1u64 << z_max.min(22) as u64) as f64;
        let half = tile_deg.max(1e-6) / 2.0;
        [cx - half, cy - half, cx + half, cy + half]
    } else {
        bbox
    };

    let releases = fetch_releases_raw(proxy.as_deref()).await?;
    let total_tasks = (releases.len() as u32) * (layers.len() as u32);

    {
        let mut m = progress.lock().await;
        m.insert(
            scan_id.clone(),
            ScanState {
                current: 0,
                total: total_tasks,
                started_at: Some(std::time::Instant::now()),
                footprints_so_far: 0,
            },
        );
    }

    let client = build_client(proxy.as_deref())?;
    let semaphore = Arc::new(Semaphore::new(SCAN_CONCURRENCY));
    let collected: Arc<Mutex<Vec<WaybackFootprint>>> = Arc::new(Mutex::new(Vec::new()));
    // 死服务名单：扫描期间共享，遇到 5xx 的 metadata 服务直接跳过后续 layer
    let dead_services: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    // 按 release_num 排序：从最新到最旧
    let mut releases_sorted: Vec<(String, WaybackReleaseRaw)> = releases.into_iter().collect();
    releases_sorted.sort_by(|a, b| b.0.cmp(&a.0));

    let release_count = releases_sorted.len();

    let mut handles = Vec::new();

    for (release_id, release) in releases_sorted {
        let release_num: u32 = release_id.parse().unwrap_or(0);
        let release_date = parse_release_date(&release.item_title);

        for &layer_id in &layers {
            let sem = Arc::clone(&semaphore);
            let client = client.clone();
            let metadata_url = release.metadata_layer_url.clone();
            let collected = Arc::clone(&collected);
            let progress = Arc::clone(&progress);
            let scan_id = scan_id.clone();
            let release_id = release_id.clone();
            let release_date = release_date.clone();
            let dead_services = Arc::clone(&dead_services);

            let handle = tokio::spawn(async move {
                let _permit = sem.acquire().await.ok();
                let footprints = query_layer_with_retry(
                    &client,
                    &metadata_url,
                    layer_id,
                    &query_bbox,
                    &release_id,
                    &release_date,
                    release_num,
                    &dead_services,
                )
                .await
                .unwrap_or_else(|e| {
                    log::warn!(
                        "wayback metadata: release={} layer={} 查询失败: {}",
                        release_id, layer_id, e
                    );
                    Vec::new()
                });

                let added = footprints.len() as u32;
                {
                    let mut all = collected.lock().await;
                    all.extend(footprints);
                }
                let mut m = progress.lock().await;
                if let Some(s) = m.get_mut(&scan_id) {
                    s.current += 1;
                    s.footprints_so_far += added;
                }
            });
            handles.push(handle);
        }
    }

    for h in handles {
        let _ = h.await;
    }

    let raw = Arc::try_unwrap(collected)
        .map_err(|_| "提取扫描结果失败".to_string())?
        .into_inner();

    let releases = summarize_releases(&raw, &bbox);
    let footprints = dedupe_footprints(raw, &bbox);

    let now = chrono::Utc::now();
    let result = WaybackScanResult {
        bbox,
        zoom_min: z_min,
        zoom_max: z_max,
        scan_mode,
        scanned_at: now.to_rfc3339(),
        expires_at: (now + chrono::Duration::seconds(CACHE_TTL_SEC)).to_rfc3339(),
        releases_scanned: release_count as u32,
        footprints,
        releases,
    };

    save_cache(&result).ok();

    // 清理进度状态
    {
        let mut m = progress.lock().await;
        m.remove(&scan_id);
    }

    Ok(result)
}

// ============================================================
// HTTP 查询
// ============================================================

fn build_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(QUERY_TIMEOUT_SEC));
    if let Some(p) = proxy {
        if !p.is_empty() {
            builder = builder.proxy(
                reqwest::Proxy::all(p).map_err(|e| format!("代理配置错误: {}", e))?,
            );
        }
    }
    builder.build().map_err(|e| format!("HTTP 客户端创建失败: {}", e))
}

/// 查询错误分类
#[derive(Debug)]
enum QueryError {
    /// 网络层错误（DNS / connect / timeout / TLS / RST），值得重试
    Network(String),
    /// 上游服务 5xx，重试也无意义（Esri 端故障），应拉黑该服务
    UpstreamServerError(u16, String),
    /// 其他 HTTP 错误（4xx / 解析失败），不重试
    Other(String),
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(s) => write!(f, "网络错误: {}", s),
            Self::UpstreamServerError(code, s) => write!(f, "上游 {} 错误: {}", code, s),
            Self::Other(s) => write!(f, "{}", s),
        }
    }
}

/// 提取 reqwest 错误的根因链（避免只看到 "error sending request for url"）
fn format_reqwest_error(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut parts: Vec<String> = vec![e.to_string()];
    let mut src: Option<&(dyn Error + 'static)> = e.source();
    while let Some(s) = src {
        parts.push(s.to_string());
        src = s.source();
    }
    let kind = if e.is_timeout() { "timeout" }
               else if e.is_connect() { "connect" }
               else if e.is_request() { "request" }
               else if e.is_body() { "body" }
               else if e.is_decode() { "decode" }
               else { "other" };
    format!("[{}] {}", kind, parts.join(" → "))
}

#[allow(clippy::too_many_arguments)]
async fn query_layer_with_retry(
    client: &reqwest::Client,
    metadata_url: &str,
    layer_id: u32,
    bbox: &[f64; 4],
    release_id: &str,
    release_date: &str,
    release_num: u32,
    dead_services: &Arc<Mutex<HashSet<String>>>,
) -> Result<Vec<WaybackFootprint>, String> {
    // 死服务短路：如该 release 已被标记，直接跳过
    {
        let s = dead_services.lock().await;
        if s.contains(metadata_url) {
            return Ok(Vec::new());
        }
    }

    let mut last_err = String::from("未尝试");
    for attempt in 0..=QUERY_MAX_RETRIES {
        if attempt > 0 {
            let wait = RETRY_BACKOFF_BASE_MS * (1u64 << attempt.min(4));
            tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
        }
        match query_layer(
            client,
            metadata_url,
            layer_id,
            bbox,
            release_id,
            release_date,
            release_num,
        )
        .await
        {
            Ok(v) => return Ok(v),
            Err(QueryError::UpstreamServerError(code, msg)) => {
                // 5xx：上游故障，拉黑整个 metadata 服务，不重试
                let mut s = dead_services.lock().await;
                let newly = s.insert(metadata_url.to_string());
                if newly {
                    log::warn!(
                        "wayback metadata: release={} 上游 {} 错误，拉黑该 metadata 服务: {}",
                        release_id, code, metadata_url
                    );
                }
                return Err(format!("上游 {}: {}", code, msg));
            }
            Err(QueryError::Other(msg)) => {
                // 4xx / 解析失败：不重试
                return Err(msg);
            }
            Err(QueryError::Network(msg)) => {
                last_err = msg;
            }
        }
    }
    Err(format!("网络错误经 {} 次重试仍失败: {}", QUERY_MAX_RETRIES, last_err))
}

async fn query_layer(
    client: &reqwest::Client,
    metadata_url: &str,
    layer_id: u32,
    bbox: &[f64; 4],
    release_id: &str,
    release_date: &str,
    release_num: u32,
) -> Result<Vec<WaybackFootprint>, QueryError> {
    let url = format!(
        "{}/{}/query?geometry={},{},{},{}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&where=1%3D1&outFields=SRC_DATE2,NICE_NAME,SRC_RES,MinMapLevel,MaxMapLevel&returnGeometry=true&outSR=4326&f=geojson",
        metadata_url.trim_end_matches('/'),
        layer_id,
        bbox[0], bbox[1], bbox[2], bbox[3]
    );

    let resp = client
        .get(&url)
        .header("Referer", "https://livingatlas.arcgis.com/wayback/")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|e| QueryError::Network(format_reqwest_error(&e)))?;

    let status = resp.status();
    if !status.is_success() {
        let code = status.as_u16();
        let body_snippet = resp.text().await.ok().map(|s| {
            let trimmed: String = s.chars().take(120).collect();
            trimmed.replace('\n', " ")
        }).unwrap_or_default();
        if code >= 500 {
            return Err(QueryError::UpstreamServerError(code, body_snippet));
        }
        return Err(QueryError::Other(format!("HTTP {} {}", code, body_snippet)));
    }

    let json: Value = resp.json().await.map_err(|e| QueryError::Other(format!("解析 JSON 失败: {}", format_reqwest_error(&e))))?;

    let features = json
        .get("features")
        .and_then(|f| f.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::with_capacity(features.len());
    for feat in features {
        let props = feat.get("properties").cloned().unwrap_or(Value::Null);
        let geom = feat.get("geometry").cloned().unwrap_or(Value::Null);
        if geom.is_null() {
            continue;
        }
        let src_date2 = props.get("SRC_DATE2").and_then(|v| v.as_i64()).unwrap_or(0);
        if src_date2 <= 0 {
            continue; // TerraColor 底图等无拍摄日期
        }
        let day_sec = (src_date2 / 1000 / 86400) * 86400;
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(day_sec, 0)
            .unwrap_or_else(chrono::Utc::now);
        let date_str = dt.format("%Y-%m-%d").to_string();
        let geom_hash = hash_geometry(&geom);
        out.push(WaybackFootprint {
            capture_date: day_sec,
            capture_date_str: date_str,
            source_name: props.get("NICE_NAME").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            resolution_m: props.get("SRC_RES").and_then(|v| v.as_f64()).unwrap_or(0.0),
            min_map_level: props.get("MinMapLevel").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            max_map_level: props.get("MaxMapLevel").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            release_id: release_id.to_string(),
            release_date: release_date.to_string(),
            release_num,
            geometry: geom,
            geometry_hash: geom_hash,
            coverage_ratio: 0.0, // 后续在 dedupe 中计算
        });
    }
    Ok(out)
}

// ============================================================
// 去重
// ============================================================

/// 同一 (capture_date_day, geometry_hash) 在多个 release 中只保留最老的 release
fn dedupe_footprints(raw: Vec<WaybackFootprint>, bbox: &[f64; 4]) -> Vec<WaybackFootprint> {
    let mut map: HashMap<(i64, String), WaybackFootprint> = HashMap::new();
    for fp in raw {
        let key = (fp.capture_date, fp.geometry_hash.clone());
        match map.get(&key) {
            Some(existing) if existing.release_num <= fp.release_num => {
                // 保留更老的（release_num 越小越老）
            }
            _ => {
                map.insert(key, fp);
            }
        }
    }
    let mut out: Vec<WaybackFootprint> = map.into_iter().map(|(_, v)| v).collect();
    // 计算覆盖率（用 footprint bbox 与用户 bbox 求交占用户 bbox 比例的简化估算）
    for fp in &mut out {
        fp.coverage_ratio = estimate_coverage(&fp.geometry, bbox);
    }
    // 按拍摄日期倒序
    out.sort_by(|a, b| b.capture_date.cmp(&a.capture_date));
    out
}

/// 服务级聚合：按 release_id 分组，统计每个 release 在 bbox 内各拍摄日期的 footprint bbox 相交面积占比
///
/// 占比定义：
/// - 单 footprint 面积 = footprint geometry bbox 与用户 bbox 的相交面积（degree²）
/// - 同 release 内按 capture_date_str 累加 → 该日期在 release 内总面积
/// - dominant_ratio = 主导日期面积 / release 内全部日期面积合计
/// - coverage_ratio = release 内全部日期面积合计 / 用户 bbox 面积
fn summarize_releases(raw: &[WaybackFootprint], user_bbox: &[f64; 4]) -> Vec<ReleaseSummary> {
    use std::collections::BTreeMap;
    // release_id -> (release_date, release_num, capture_date_str -> (area, source_name, resolution))
    #[derive(Default)]
    struct ReleaseAgg {
        release_date: String,
        release_num: u32,
        captures: HashMap<String, (f64, String, f64)>,
    }
    let mut by_release: BTreeMap<String, ReleaseAgg> = BTreeMap::new();
    let user_area = ((user_bbox[2] - user_bbox[0]) * (user_bbox[3] - user_bbox[1])).max(1e-12);
    for fp in raw {
        let area = footprint_intersect_area(&fp.geometry, user_bbox);
        if area <= 0.0 {
            continue;
        }
        let entry = by_release.entry(fp.release_id.clone()).or_default();
        entry.release_date = fp.release_date.clone();
        entry.release_num = fp.release_num;
        let cap = entry
            .captures
            .entry(fp.capture_date_str.clone())
            .or_insert((0.0, fp.source_name.clone(), fp.resolution_m));
        cap.0 += area;
        // 同日期可能多 footprint，取最大分辨率（数值更小）和稳定的 source_name
        if fp.resolution_m > 0.0 && (cap.2 == 0.0 || fp.resolution_m < cap.2) {
            cap.2 = fp.resolution_m;
            cap.1 = fp.source_name.clone();
        }
    }
    let mut out = Vec::with_capacity(by_release.len());
    for (release_id, agg) in by_release {
        let total_area: f64 = agg.captures.values().map(|(a, _, _)| *a).sum();
        if total_area <= 0.0 {
            continue;
        }
        let mut breakdown: Vec<ReleaseCaptureBreakdown> = agg
            .captures
            .into_iter()
            .map(|(date, (area, src, res))| ReleaseCaptureBreakdown {
                capture_date_str: date,
                ratio: area / total_area,
                source_name: src,
                resolution_m: res,
            })
            .collect();
        breakdown.sort_by(|a, b| b.ratio.partial_cmp(&a.ratio).unwrap_or(std::cmp::Ordering::Equal));
        let (dom_date, dom_ratio, dom_src, dom_res) = breakdown
            .first()
            .map(|b| (b.capture_date_str.clone(), b.ratio, b.source_name.clone(), b.resolution_m))
            .unwrap_or_default();
        out.push(ReleaseSummary {
            release_id,
            release_date: agg.release_date,
            release_num: agg.release_num,
            dominant_capture_date: dom_date,
            dominant_ratio: dom_ratio,
            coverage_ratio: (total_area / user_area).clamp(0.0, 1.0),
            source_name: dom_src,
            resolution_m: dom_res,
            captures: breakdown,
        });
    }
    // 按 release 新→旧排序
    out.sort_by(|a, b| b.release_num.cmp(&a.release_num));
    out
}

/// footprint geometry bbox 与用户 bbox 的相交面积（degree²）
fn footprint_intersect_area(geom: &Value, user_bbox: &[f64; 4]) -> f64 {
    let fb = geometry_bbox(geom);
    if fb[2] <= fb[0] || fb[3] <= fb[1] {
        return 0.0;
    }
    let ix = [
        fb[0].max(user_bbox[0]),
        fb[1].max(user_bbox[1]),
        fb[2].min(user_bbox[2]),
        fb[3].min(user_bbox[3]),
    ];
    if ix[2] <= ix[0] || ix[3] <= ix[1] {
        return 0.0;
    }
    (ix[2] - ix[0]) * (ix[3] - ix[1])
}

/// 简化的覆盖率估算：用 footprint 几何 bbox 与用户 bbox 的相交面积比例
fn estimate_coverage(geom: &Value, user_bbox: &[f64; 4]) -> f64 {
    let fb = geometry_bbox(geom);
    if fb[2] <= fb[0] || fb[3] <= fb[1] {
        return 0.0;
    }
    let ix = [
        fb[0].max(user_bbox[0]),
        fb[1].max(user_bbox[1]),
        fb[2].min(user_bbox[2]),
        fb[3].min(user_bbox[3]),
    ];
    if ix[2] <= ix[0] || ix[3] <= ix[1] {
        return 0.0;
    }
    let inter = (ix[2] - ix[0]) * (ix[3] - ix[1]);
    let user_area = (user_bbox[2] - user_bbox[0]) * (user_bbox[3] - user_bbox[1]);
    if user_area <= 0.0 {
        return 0.0;
    }
    (inter / user_area).clamp(0.0, 1.0)
}

/// 提取 GeoJSON Geometry 的 bbox [minx, miny, maxx, maxy]
fn geometry_bbox(geom: &Value) -> [f64; 4] {
    let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    walk_coords(geom, &mut |x, y| {
        if x < bb[0] { bb[0] = x; }
        if y < bb[1] { bb[1] = y; }
        if x > bb[2] { bb[2] = x; }
        if y > bb[3] { bb[3] = y; }
    });
    if bb[0].is_infinite() {
        [0.0; 4]
    } else {
        bb
    }
}

fn walk_coords<F: FnMut(f64, f64)>(value: &Value, f: &mut F) {
    match value {
        Value::Array(arr) => {
            // 叶子坐标 [x, y] 或 [x, y, z]
            if arr.len() >= 2 && arr.iter().all(|v| v.is_number()) {
                let x = arr[0].as_f64().unwrap_or(0.0);
                let y = arr[1].as_f64().unwrap_or(0.0);
                f(x, y);
            } else {
                for v in arr {
                    walk_coords(v, f);
                }
            }
        }
        Value::Object(obj) => {
            if let Some(coords) = obj.get("coordinates") {
                walk_coords(coords, f);
            }
            // GeometryCollection
            if let Some(geoms) = obj.get("geometries") {
                walk_coords(geoms, f);
            }
        }
        _ => {}
    }
}

/// 几何哈希：扁平化所有坐标 → 量化（1e-4 度，约 11m）→ 64bit FNV-1a
fn hash_geometry(geom: &Value) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    let mul: u64 = 0x100000001b3;
    walk_coords(geom, &mut |x, y| {
        let qx = (x * 1e4).round() as i64;
        let qy = (y * 1e4).round() as i64;
        for b in qx.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(mul);
        }
        for b in qy.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(mul);
        }
    });
    format!("{:016x}", h)
}

fn simple_hash64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    let mul: u64 = 0x100000001b3;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(mul);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_scan_mode_defaults_unknown_values_to_fast() {
        assert_eq!(normalize_scan_mode(None), "fast");
        assert_eq!(normalize_scan_mode(Some("fast")), "fast");
        assert_eq!(normalize_scan_mode(Some("fine")), "fine");
        assert_eq!(normalize_scan_mode(Some("unexpected")), "fast");
    }

    #[test]
    fn cache_key_separates_fast_and_fine_modes() {
        let bbox = [116.1234567, 39.1234567, 116.7654321, 39.7654321];

        let fast = cache_key(&bbox, 12, 18, "fast");
        let fine = cache_key(&bbox, 12, 18, "fine");
        let unknown = cache_key(&bbox, 12, 18, "unexpected");

        assert_ne!(fast, fine);
        assert_eq!(fast, unknown);
    }
}

fn parse_release_date(item_title: &str) -> String {
    item_title
        .strip_prefix("World Imagery (Wayback ")
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or(item_title)
        .to_string()
}
