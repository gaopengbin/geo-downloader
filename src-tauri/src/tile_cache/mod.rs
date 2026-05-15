//! Tile cache 公共类型与对外 API。
//!
//! 设计参考 `docs/browse-as-cache-design.md`。

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

pub mod store;
pub mod pool;
pub mod active_downloads;

pub use pool::Store;

/// 图源缓存键（同时也是 mbtiles 文件名前缀）。
///
/// 例如 `world_imagery`、`tdt_img`、`wayback_2024-03-14`。
#[derive(Debug, Clone, Hash, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceKey(pub String);

impl SourceKey {
    pub fn new(s: impl Into<String>) -> Self {
        Self(slugify(&s.into()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// XYZ 瓦片坐标（左上角原点）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TileCoord {
    pub z: u8,
    pub x: u32,
    pub y: u32,
}

/// 单个瓦片的缓存条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTile {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// 图源元信息（首次写入时记录）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SourceInfo {
    pub display_name: String,
    pub url_template: String,
    /// 'png' | 'jpg' | 'webp' | 'pbf'
    pub format: String,
    pub min_zoom: Option<u8>,
    pub max_zoom: Option<u8>,
    pub bounds: Option<[f64; 4]>,
    pub attribution: Option<String>,
    /// Wayback 等多版本图源的拍摄日期（仅信息，不影响 SourceKey）
    pub capture_at: Option<String>,
}

/// 单图源在缓存中的统计信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStats {
    pub source: String,
    pub display_name: String,
    pub format: String,
    pub tile_count: u64,
    pub size_bytes: u64,
    pub min_zoom: Option<u8>,
    pub max_zoom: Option<u8>,
    pub created_at: Option<String>,
    pub last_used_at: Option<String>,
}

/// 容量淘汰报告。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    pub removed_sources: Vec<String>,
    pub freed_bytes: u64,
}

/// XYZ → TMS 行号转换（MBTiles 用 TMS）。
#[inline]
pub fn xyz_to_tms_row(z: u8, y: u32) -> u32 {
    let max = (1u64 << z) - 1;
    (max as u32).wrapping_sub(y)
}

/// TMS → XYZ 行号转换。
#[inline]
pub fn tms_to_xyz_row(z: u8, y: u32) -> u32 {
    xyz_to_tms_row(z, y)
}

/// 解析 `gdcache://localhost/<source>/<z>/<x>/<y>[.ext]`
/// 或 Windows/Android 的 `http(s)://gdcache.localhost/<source>/<z>/<x>/<y>[.ext]`。
///
/// 返回 (source_id, z, x, y)；任何字段缺失或解析失败返回 None。
pub fn parse_gdcache_uri(uri: &str) -> Option<(String, u8, u32, u32)> {
    // 去掉 scheme 与 authority
    let after_scheme = uri.splitn(2, "://").nth(1)?;
    let path = after_scheme.splitn(2, '/').nth(1).unwrap_or("");
    // 去 query / fragment
    let path = path.split(|c| c == '?' || c == '#').next().unwrap_or(path);
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 4 {
        return None;
    }
    let source = urlencoding_decode(parts[0]);
    let z: u8 = parts[1].parse().ok()?;
    let x: u32 = parts[2].parse().ok()?;
    let y_str = parts[3].split('.').next().unwrap_or("");
    let y: u32 = y_str.parse().ok()?;
    Some((source, z, x, y))
}

/// 极简 percent-decode（仅处理 %XX，失败时按原字符返回）。
fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// 把任意字符串变成文件名安全的 slug：小写字母 / 数字 / `-` / `_`。
fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_underscore = false;
    for c in input.chars() {
        let mapped = match c {
            'A'..='Z' => Some(c.to_ascii_lowercase()),
            'a'..='z' | '0'..='9' | '-' | '_' => Some(c),
            _ => None,
        };
        match mapped {
            Some(ch) => {
                out.push(ch);
                last_underscore = false;
            }
            None => {
                if !last_underscore && !out.is_empty() {
                    out.push('_');
                    last_underscore = true;
                }
            }
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("source");
    }
    out
}

// ----------- 全局配置（缓存目录 / 上限） -----------

#[derive(Debug, Clone)]
pub struct CacheConfig {
    pub enabled: bool,
    pub root_dir: PathBuf,
    pub max_total_bytes: u64,
}

impl CacheConfig {
    pub fn default_root() -> PathBuf {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("geo-downloader")
            .join("tile_cache")
    }
}

static GLOBAL_CONFIG: OnceLock<std::sync::RwLock<CacheConfig>> = OnceLock::new();

fn config_lock() -> &'static std::sync::RwLock<CacheConfig> {
    GLOBAL_CONFIG.get_or_init(|| {
        std::sync::RwLock::new(CacheConfig {
            enabled: true,
            root_dir: CacheConfig::default_root(),
            max_total_bytes: 5 * 1024 * 1024 * 1024, // 5 GB
        })
    })
}

pub fn get_config() -> CacheConfig {
    config_lock().read().expect("cache config poisoned").clone()
}

pub fn set_config(cfg: CacheConfig) {
    *config_lock().write().expect("cache config poisoned") = cfg;
}

pub fn set_enabled(enabled: bool) {
    config_lock()
        .write()
        .expect("cache config poisoned")
        .enabled = enabled;
}

pub fn set_root_dir(dir: PathBuf) {
    // 切换目录前必须先关掉旧目录上的所有连接，否则旧目录会留下孤儿 -wal/-shm
    Store::global().shutdown();
    config_lock().write().expect("cache config poisoned").root_dir = dir;
}

pub fn set_max_total_bytes(bytes: u64) {
    config_lock()
        .write()
        .expect("cache config poisoned")
        .max_total_bytes = bytes;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("World Imagery"), "world_imagery");
        assert_eq!(slugify("Wayback 2024-03-14"), "wayback_2024-03-14");
        assert_eq!(slugify("天地图 IMG"), "img");
        assert_eq!(slugify(""), "source");
        assert_eq!(slugify("///"), "source");
    }

    #[test]
    fn xyz_tms_roundtrip() {
        for z in 0u8..=18 {
            let max = (1u64 << z) - 1;
            for &y in &[0u32, 1, (max / 2) as u32, max as u32] {
                let tms = xyz_to_tms_row(z, y);
                assert_eq!(tms_to_xyz_row(z, tms), y);
            }
        }
    }

    #[test]
    fn parse_gdcache_uri_basic() {
        assert_eq!(
            parse_gdcache_uri("gdcache://localhost/world_imagery/3/4/5"),
            Some(("world_imagery".to_string(), 3, 4, 5))
        );
        // 带扩展名
        assert_eq!(
            parse_gdcache_uri("gdcache://localhost/tdt_img/10/512/256.png"),
            Some(("tdt_img".to_string(), 10, 512, 256))
        );
        // Windows / Android 形式
        assert_eq!(
            parse_gdcache_uri("http://gdcache.localhost/wayback_22869/8/100/200"),
            Some(("wayback_22869".to_string(), 8, 100, 200))
        );
        // query / fragment 应被忽略
        assert_eq!(
            parse_gdcache_uri("gdcache://localhost/foo/1/2/3?bust=1#x"),
            Some(("foo".to_string(), 1, 2, 3))
        );
        // percent-encoded source
        assert_eq!(
            parse_gdcache_uri("gdcache://localhost/wayback%5F2024/0/0/0"),
            Some(("wayback_2024".to_string(), 0, 0, 0))
        );
    }

    #[test]
    fn parse_gdcache_uri_invalid() {
        assert_eq!(parse_gdcache_uri("gdcache://localhost/foo/1/2"), None);
        assert_eq!(parse_gdcache_uri("not-a-uri"), None);
        assert_eq!(parse_gdcache_uri("gdcache://localhost/foo/abc/2/3"), None);
        assert_eq!(parse_gdcache_uri("gdcache://localhost/foo/1/x/3"), None);
        assert_eq!(parse_gdcache_uri("gdcache://localhost/foo/1/2/y"), None);
    }
}
