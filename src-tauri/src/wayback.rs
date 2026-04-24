//! Esri World Imagery Wayback 历史影像模块
//!
//! 从 Esri Wayback 服务获取历史卫星影像版本列表，
//! 并生成标准 TileSource 以复用现有下载流水线。

use crate::config::TileSource;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

/// fetch_releases_raw 的进程内缓存：TTL 1 小时
static RELEASES_CACHE: OnceLock<AsyncMutex<Option<(Instant, HashMap<String, WaybackReleaseRaw>)>>> = OnceLock::new();
const RELEASES_CACHE_TTL: Duration = Duration::from_secs(3600);

/// Wayback 配置 API 地址
const WAYBACK_CONFIG_URL: &str =
    "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";

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
#[derive(Debug, Clone, Serialize)]
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

/// 从 Esri S3 获取所有 Wayback 版本
pub async fn fetch_versions(proxy: Option<&str>) -> Result<Vec<WaybackVersion>, String> {
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

    Ok(versions)
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
    // https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{layerId}/{z}/{y}/{x}
    let url = format!(
        "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{}/{{z}}/{{y}}/{{x}}",
        version_id
    );

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
        let url = format!(
            "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{}/{}/{}/{}",
            version_id, z, y, x
        );
        match client
            .head(&url)
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
