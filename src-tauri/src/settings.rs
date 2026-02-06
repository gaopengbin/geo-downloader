//! 应用设置模块

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 自定义瓦片图源
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomTileSource {
    /// 图源 ID（自动生成，前缀 custom_）
    pub id: String,
    /// 显示名称
    pub name: String,
    /// URL 模板，支持 {x}, {y}, {z}, {s} 占位符
    pub url: String,
    /// 子域名，逗号分隔
    #[serde(default)]
    pub subdomains: String,
    /// 最大缩放级别
    #[serde(default = "default_max_zoom")]
    pub max_zoom: u8,
}

fn default_max_zoom() -> u8 { 18 }

/// 应用设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// 天地图 Token
    #[serde(default)]
    pub tianditu_token: Option<String>,
    /// 是否启用代理
    #[serde(default = "default_proxy_enabled")]
    pub proxy_enabled: bool,
    /// 代理地址
    #[serde(default = "default_proxy_url")]
    pub proxy_url: String,
    /// 默认并发数
    #[serde(default = "default_concurrency")]
    pub default_concurrency: u32,
    /// 默认缩放级别
    #[serde(default = "default_zoom")]
    pub default_zoom: u8,
    /// 默认输出格式
    #[serde(default = "default_format")]
    pub default_format: String,
    /// 默认图源
    #[serde(default = "default_source")]
    pub default_source: String,
    /// 自定义图源列表
    #[serde(default)]
    pub custom_sources: Vec<CustomTileSource>,
}

fn default_proxy_enabled() -> bool { true }
fn default_proxy_url() -> String { "http://127.0.0.1:10808".to_string() }
fn default_concurrency() -> u32 { 30 }
fn default_zoom() -> u8 { 15 }
fn default_format() -> String { "geotiff".to_string() }
fn default_source() -> String { "osm".to_string() }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            tianditu_token: None,
            proxy_enabled: default_proxy_enabled(),
            proxy_url: default_proxy_url(),
            default_concurrency: default_concurrency(),
            default_zoom: default_zoom(),
            default_format: default_format(),
            default_source: default_source(),
            custom_sources: vec![],
        }
    }
}

/// 设置管理器
pub struct SettingsManager {
    file_path: PathBuf,
}

impl SettingsManager {
    /// 创建管理器实例
    pub fn new() -> Result<Self, String> {
        let data_dir = get_data_dir()?;
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("无法创建数据目录: {}", e))?;
        
        let file_path = data_dir.join("settings.json");
        Ok(Self { file_path })
    }

    /// 获取设置
    pub fn get(&self) -> Result<AppSettings, String> {
        if !self.file_path.exists() {
            return Ok(AppSettings::default());
        }

        let content = fs::read_to_string(&self.file_path)
            .map_err(|e| format!("读取设置失败: {}", e))?;
        
        if content.trim().is_empty() {
            return Ok(AppSettings::default());
        }

        serde_json::from_str(&content)
            .map_err(|e| format!("解析设置失败: {}", e))
    }

    /// 保存设置
    pub fn save(&self, settings: &AppSettings) -> Result<(), String> {
        let content = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("序列化失败: {}", e))?;
        
        fs::write(&self.file_path, content)
            .map_err(|e| format!("保存设置失败: {}", e))
    }
}

/// 获取数据目录
fn get_data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|p| p.join("tif-downloader"))
        .ok_or_else(|| "无法获取数据目录".to_string())
}
