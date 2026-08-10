//! Esri World Imagery Wayback 历史影像模块
//!
//! 从 Esri Wayback 服务获取历史卫星影像版本列表，
//! 并生成标准 TileSource 以复用现有下载流水线。

use crate::config::TileSource;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

/// fetch_releases_raw 的进程内缓存：TTL 1 小时
static RELEASES_CACHE: OnceLock<AsyncMutex<Option<(Instant, HashMap<String, WaybackReleaseRaw>)>>> = OnceLock::new();
const RELEASES_CACHE_TTL: Duration = Duration::from_secs(3600);

/// 网络请求超时（用于版本列表获取）
const VERSIONS_FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Wayback 配置 API 地址
const WAYBACK_CONFIG_URL: &str =
    "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";

/// Wayback 官网（Living Atlas）实际使用的瓦片入口。
///
/// `waybackconfig.json` 中的 itemURL 仍指向 WMTS 兼容路径，但官网网络面板使用该
/// mapserver 路径和 wayback-a CDN 主机。两者返回同一瓦片；这里跟齐官网入口，
/// 降低 WebView2/CDN 调度差异导致的超时概率。
const WAYBACK_TILE_BASE_URL: &str =
    "https://wayback-a.maptiles.arcgis.com/arcgis/rest/services/world_imagery/mapserver/tile";

/// 单个 Wayback 版本的原始配置
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaybackEntry {
    item_title: String,
    #[allow(dead_code)]
    #[serde(rename = "itemURL")]
    item_url: String,
    layer_identifier: String,
    #[serde(default)]
    metadata_layer_url: Option<String>,
}

/// 对外暴露的 release 原始信息（供 wayback_metadata 模块复用）
#[derive(Debug, Clone)]
pub struct WaybackReleaseRaw {
    pub item_title: String,
    pub metadata_layer_url: String,
    #[allow(dead_code)]
    pub layer_identifier: String,
}

/// 前端可显示的 Wayback 版本信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaybackVersion {
    /// 内部标识（layerId，如 "22869"）
    pub id: String,
    /// 显示标题，如 "2026-03-26"
    pub date: String,
    /// 完整标题
    pub title: String,
    /// 层标识符，如 "WB_2026_R03"
    pub layer_id: String,
}

/// get_wayback_versions 命令的返回值
#[derive(Debug, Clone, Serialize)]
pub struct WaybackVersionsResponse {
    pub versions: Vec<WaybackVersion>,
    pub from_cache: bool,
}

/// 版本列表磁盘缓存路径
fn versions_cache_path() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|p| p.join("geo-downloader").join("wayback_versions.json"))
        .ok_or_else(|| "无法获取数据目录".to_string())
}

/// 将版本列表持久化到磁盘
fn persist_versions(versions: &[WaybackVersion]) {
    if let Ok(path) = versions_cache_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(versions) {
            let _ = crate::fs_util::atomic_write(&path, json.as_bytes());
        }
    }
}

/// 从磁盘加载缓存的版本列表
fn load_cached_versions() -> Option<Vec<WaybackVersion>> {
    let path = versions_cache_path().ok()?;
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// 从 Esri S3 获取所有 Wayback 版本
pub async fn fetch_versions(proxy: Option<&str>) -> Result<Vec<WaybackVersion>, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(VERSIONS_FETCH_TIMEOUT);
    if let Some(p) = proxy {
        if !p.is_empty() {
            builder = builder.proxy(
                reqwest::Proxy::all(p).map_err(|e| format!("代理配置错误: {}", e))?,
            );
        }
    }
    let client = builder.build().map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let resp = client
        .get(WAYBACK_CONFIG_URL)
        .send()
        .await
        .map_err(|e| format!("获取 Wayback 配置失败: {}", e))?;

    let map: HashMap<String, WaybackEntry> = resp
        .json()
        .await
        .map_err(|e| format!("解析 Wayback 配置失败: {}", e))?;

    let mut versions: Vec<WaybackVersion> = map
        .into_iter()
        .map(|(id, entry)| {
            // itemTitle 格式: "World Imagery (Wayback 2026-03-26)"
            let date = entry
                .item_title
                .strip_prefix("World Imagery (Wayback ")
                .and_then(|s| s.strip_suffix(')'))
                .unwrap_or(&entry.item_title)
                .to_string();
            WaybackVersion {
                id,
                date,
                title: entry.item_title,
                layer_id: entry.layer_identifier,
            }
        })
        .collect();

    // 按日期降序排列（最新在前）
    versions.sort_by(|a, b| b.date.cmp(&a.date));

    // 持久化到磁盘
    persist_versions(&versions);

    Ok(versions)
}

/// 获取版本列表，网络失败时回退到磁盘缓存
pub async fn fetch_versions_with_fallback(
    proxy: Option<&str>,
) -> Result<WaybackVersionsResponse, String> {
    match fetch_versions(proxy).await {
        Ok(versions) => Ok(WaybackVersionsResponse {
            versions,
            from_cache: false,
        }),
        Err(e) => {
            log::warn!("Wayback 版本列表网络获取失败，尝试磁盘缓存: {}", e);
            match load_cached_versions() {
                Some(versions) => {
                    log::info!("使用磁盘缓存的版本列表 ({} 个版本)", versions.len());
                    Ok(WaybackVersionsResponse {
                        versions,
                        from_cache: true,
                    })
                }
                None => Err(format!("网络不可用且无本地缓存: {}", e)),
            }
        }
    }
}

/// 获取所有 release 的"原始详细信息"（供元数据扫描复用）
///
/// 返回 HashMap<release_id, WaybackReleaseRaw>，过滤掉缺少 metadata_layer_url 的条目。
/// 进程内缓存 1 小时，避免重复扫描时反复请求 waybackconfig.json。
pub async fn fetch_releases_raw(
    proxy: Option<&str>,
) -> Result<HashMap<String, WaybackReleaseRaw>, String> {
    let cache = RELEASES_CACHE.get_or_init(|| AsyncMutex::new(None));
    {
        let guard = cache.lock().await;
        if let Some((ts, data)) = guard.as_ref() {
            if ts.elapsed() < RELEASES_CACHE_TTL {
                log::debug!("wayback releases: 命中缓存 ({} 个 release)", data.len());
                return Ok(data.clone());
            }
        }
    }

    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15));
    if let Some(p) = proxy {
        if !p.is_empty() {
            builder = builder.proxy(
                reqwest::Proxy::all(p).map_err(|e| format!("代理配置错误: {}", e))?,
            );
        }
    }
    let client = builder.build().map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let resp = client
        .get(WAYBACK_CONFIG_URL)
        .send()
        .await
        .map_err(|e| format!("获取 Wayback 配置失败: {}", e))?;

    let map: HashMap<String, WaybackEntry> = resp
        .json()
        .await
        .map_err(|e| format!("解析 Wayback 配置失败: {}", e))?;

    let out: HashMap<String, WaybackReleaseRaw> = map
        .into_iter()
        .filter_map(|(id, entry)| {
            entry.metadata_layer_url.as_ref()?;
            Some((
                id,
                WaybackReleaseRaw {
                    item_title: entry.item_title,
                    metadata_layer_url: entry.metadata_layer_url.unwrap_or_default(),
                    layer_identifier: entry.layer_identifier,
                },
            ))
        })
        .collect();

    {
        let mut guard = cache.lock().await;
        *guard = Some((Instant::now(), out.clone()));
    }

    Ok(out)
}

/// 根据选定的 Wayback 版本 ID 构造 TileSource
///
/// `version_id`: waybackconfig.json 中的 key（如 "22869"）
/// `date`: 显示日期（如 "2026-03-26"），用于 source 命名
pub fn make_tile_source(version_id: &str, date: &str) -> TileSource {
    // Esri Wayback 瓦片 URL:
    // https://wayback-a.maptiles.arcgis.com/arcgis/rest/services/world_imagery/mapserver/tile/{layerId}/{z}/{y}/{x}
    let url = format!("{}/{}/{{z}}/{{y}}/{{x}}", WAYBACK_TILE_BASE_URL, version_id);

    TileSource {
        id: format!("wayback_{}", version_id),
        name: format!("Esri 历史影像 {}", date),
        url,
        subdomains: vec![],
        max_zoom: 19,
        attribution: "© Esri".to_string(),
    }
}

/// 探测某个版本在指定经纬度的最大可用缩放级别
///
/// 从 z=19 向下探测，返回第一个能成功获取瓦片的缩放级别
pub async fn probe_max_zoom(
    version_id: &str,
    lat: f64,
    lng: f64,
    proxy: Option<&str>,
) -> Result<u32, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8));
    if let Some(p) = proxy {
        if !p.is_empty() {
            builder = builder.proxy(
                reqwest::Proxy::all(p).map_err(|e| format!("代理配置错误: {}", e))?,
            );
        }
    }
    let client = builder.build().map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    for z in (1..=19u32).rev() {
        let (x, y) = lat_lng_to_tile(lat, lng, z);
        let url = format!("{}/{}/{}/{}/{}", WAYBACK_TILE_BASE_URL, version_id, z, y, x);
        match client
            .get(&url)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .header("Origin", "https://livingatlas.arcgis.com")
            .header("Referer", "https://livingatlas.arcgis.com/")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => return Ok(z),
            _ => continue,
        }
    }
    Err("未找到可用缩放级别".to_string())
}

/// 经纬度转瓦片坐标
fn lat_lng_to_tile(lat: f64, lng: f64, z: u32) -> (u32, u32) {
    let n = 2f64.powi(z as i32);
    let x = ((lng + 180.0) / 360.0 * n).floor() as u32;
    let lat_rad = lat.to_radians();
    let y = ((1.0 - lat_rad.tan().asinh() / std::f64::consts::PI) / 2.0 * n).floor() as u32;
    (x, y)
}
