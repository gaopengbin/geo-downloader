//! 图源配置模块

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

/// 全局 TLS 严格性开关。
///
/// 默认 `false`（严格验证证书）。由应用启动流程（`lib.rs::run`）从
/// 用户设置读取 `allow_invalid_certs` 后统一调用 [`set_allow_invalid_certs`]
/// 初始化一次；运行时仅在用户显式变更设置后调用再次同步。
///
/// 读取者：`downloader.rs` / `tiles3d/fetcher.rs` / `commands.rs` 中
/// 所有 `reqwest::Client::builder()` 构造处。
static ALLOW_INVALID_CERTS: AtomicBool = AtomicBool::new(false);

/// 设置"允许无效证书"标志。**仅应从 settings 同步，不应在代码硬编码 true。**
pub fn set_allow_invalid_certs(allow: bool) {
    ALLOW_INVALID_CERTS.store(allow, Ordering::Relaxed);
}

/// 读取当前"允许无效证书"标志。**默认 false（严格 TLS 验证）。**
#[inline]
pub fn allow_invalid_certs() -> bool {
    ALLOW_INVALID_CERTS.load(Ordering::Relaxed)
}

/// 瓦片大小 (像素)
pub const TILE_SIZE: u32 = 256;

/// 最大并发下载数 (提升到 50 以提高下载速度)
pub const MAX_CONCURRENT: usize = 50;

/// 重试次数
pub const RETRY_TIMES: u32 = 2;

/// 请求超时 (秒)
pub const TIMEOUT_SECS: u64 = 15;

/// 请求间隔 (毫秒) - 减少延迟
pub const DELAY_MS: u64 = 20;

/// 瓦片图源配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileSource {
    pub id: String,
    pub name: String,
    pub url: String,
    pub subdomains: Vec<String>,
    pub max_zoom: u8,
    pub attribution: String,
}

/// 天地图默认 Token
pub const TIANDITU_DEFAULT_TOKEN: &str = "436ce7e50d27eede2f2929307e6b33c0";

/// 获取所有图源配置
pub fn get_tile_sources(tianditu_token: Option<&str>) -> HashMap<String, TileSource> {
    let token = tianditu_token.unwrap_or(TIANDITU_DEFAULT_TOKEN);
    let mut sources = HashMap::new();

    sources.insert(
        "google_satellite".to_string(),
        TileSource {
            id: "google_satellite".to_string(),
            name: "Google 卫星".to_string(),
            url: "https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}".to_string(),
            subdomains: vec!["0", "1", "2", "3"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 20,
            attribution: "© Google".to_string(),
        },
    );

    sources.insert(
        "google_map".to_string(),
        TileSource {
            id: "google_map".to_string(),
            name: "Google 地图".to_string(),
            url: "https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}".to_string(),
            subdomains: vec!["0", "1", "2", "3"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 20,
            attribution: "© Google".to_string(),
        },
    );

    sources.insert(
        "google_hybrid".to_string(),
        TileSource {
            id: "google_hybrid".to_string(),
            name: "Google 混合".to_string(),
            url: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}".to_string(),
            subdomains: vec!["0", "1", "2", "3"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 20,
            attribution: "© Google".to_string(),
        },
    );

    sources.insert(
        "osm".to_string(),
        TileSource {
            id: "osm".to_string(),
            name: "OpenStreetMap".to_string(),
            url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png".to_string(),
            subdomains: vec!["a", "b", "c"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 19,
            attribution: "© OpenStreetMap contributors".to_string(),
        },
    );

    sources.insert(
        "arcgis_satellite".to_string(),
        TileSource {
            id: "arcgis_satellite".to_string(),
            name: "ArcGIS 卫星".to_string(),
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}".to_string(),
            subdomains: vec![],
            max_zoom: 19,
            attribution: "© Esri".to_string(),
        },
    );

    sources.insert(
        "carto_light".to_string(),
        TileSource {
            id: "carto_light".to_string(),
            name: "Carto Light".to_string(),
            url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png".to_string(),
            subdomains: vec!["a", "b", "c", "d"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 19,
            attribution: "© CARTO".to_string(),
        },
    );

    sources.insert(
        "carto_dark".to_string(),
        TileSource {
            id: "carto_dark".to_string(),
            name: "Carto Dark".to_string(),
            url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png".to_string(),
            subdomains: vec!["a", "b", "c", "d"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 19,
            attribution: "© CARTO".to_string(),
        },
    );

    sources.insert(
        "arcgis_topo".to_string(),
        TileSource {
            id: "arcgis_topo".to_string(),
            name: "ArcGIS 地形".to_string(),
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}".to_string(),
            subdomains: vec![],
            max_zoom: 19,
            attribution: "© Esri".to_string(),
        },
    );

    sources.insert(
        "arcgis_street".to_string(),
        TileSource {
            id: "arcgis_street".to_string(),
            name: "ArcGIS 街道".to_string(),
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}".to_string(),
            subdomains: vec![],
            max_zoom: 19,
            attribution: "© Esri".to_string(),
        },
    );

    sources.insert(
        "opentopomap".to_string(),
        TileSource {
            id: "opentopomap".to_string(),
            name: "OpenTopoMap".to_string(),
            url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png".to_string(),
            subdomains: vec!["a", "b", "c"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 17,
            attribution: "© OpenTopoMap".to_string(),
        },
    );

    sources.insert(
        "gaode_map".to_string(),
        TileSource {
            id: "gaode_map".to_string(),
            name: "高德 地图".to_string(),
            url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}".to_string(),
            subdomains: vec!["1", "2", "3", "4"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 18,
            attribution: "© 高德地图".to_string(),
        },
    );

    sources.insert(
        "gaode_satellite".to_string(),
        TileSource {
            id: "gaode_satellite".to_string(),
            name: "高德 卫星".to_string(),
            url: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}".to_string(),
            subdomains: vec!["1", "2", "3", "4"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 18,
            attribution: "© 高德地图".to_string(),
        },
    );

    sources.insert(
        "tianditu_satellite".to_string(),
        TileSource {
            id: "tianditu_satellite".to_string(),
            name: "天地图 卫星".to_string(),
            url: format!(
                "https://t{{s}}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={{z}}&TILEROW={{y}}&TILECOL={{x}}&tk={}",
                token
            ),
            subdomains: vec!["0", "1", "2", "3", "4", "5", "6", "7"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 18,
            attribution: "© 天地图".to_string(),
        },
    );

    sources.insert(
        "tianditu_vector".to_string(),
        TileSource {
            id: "tianditu_vector".to_string(),
            name: "天地图 矢量".to_string(),
            url: format!(
                "https://t{{s}}.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={{z}}&TILEROW={{y}}&TILECOL={{x}}&tk={}",
                token
            ),
            subdomains: vec!["0", "1", "2", "3", "4", "5", "6", "7"]
                .into_iter()
                .map(String::from)
                .collect(),
            max_zoom: 18,
            attribution: "© 天地图".to_string(),
        },
    );

    // DEM: AWS Terrain Tiles (Terrarium 编码) - 全球免费
    sources.insert(
        "dem_terrarium".to_string(),
        TileSource {
            id: "dem_terrarium".to_string(),
            name: "DEM 高程 (Terrarium)".to_string(),
            url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png".to_string(),
            subdomains: vec![],
            max_zoom: 15,
            attribution: "Mapzen / AWS / NASADEM".to_string(),
        },
    );

    sources
}

/// 阿里云 DataV 行政区划 API
pub const DATAV_API: &str = "https://geo.datav.aliyun.com/areas_v3/bound/{code}.json";
pub const DATAV_FULL_API: &str = "https://geo.datav.aliyun.com/areas_v3/bound/{code}_full.json";

/// User-Agent 列表
pub const USER_AGENTS: &[&str] = &[
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];
