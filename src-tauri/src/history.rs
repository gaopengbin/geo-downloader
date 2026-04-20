//! 下载历史记录模块

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use chrono::{DateTime, Utc};
use uuid::Uuid;

/// 下载记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadRecord {
    pub id: String,
    pub name: String,
    pub source: String,
    pub source_name: String,
    pub zoom: u8,
    pub format: String,
    pub file_path: String,
    pub file_size: u64,
    pub tile_count: u32,
    pub failed_count: u32,
    pub created_at: DateTime<Utc>,
    pub status: DownloadStatus,
    /// 关联的日志文件路径
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_file: Option<String>,
    /// 任务耗时（秒）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<u64>,
}

/// 下载状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Completed,
    Failed,
}

impl DownloadRecord {
    /// 创建新记录
    pub fn new(
        name: String,
        source: String,
        source_name: String,
        zoom: u8,
        format: String,
        file_path: String,
        file_size: u64,
        tile_count: u32,
        failed_count: u32,
        status: DownloadStatus,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            source,
            source_name,
            zoom,
            format,
            file_path,
            file_size,
            tile_count,
            failed_count,
            created_at: Utc::now(),
            status,
            log_file: None,
            duration_secs: None,
        }
    }

    /// 创建新记录（带日志文件）
    pub fn with_log_file(mut self, log_file: Option<String>) -> Self {
        self.log_file = log_file;
        self
    }

    pub fn with_duration(mut self, secs: u64) -> Self {
        self.duration_secs = Some(secs);
        self
    }
}

/// 历史记录管理器
pub struct HistoryManager {
    file_path: PathBuf,
}

impl HistoryManager {
    /// 创建管理器实例
    pub fn new() -> Result<Self, String> {
        let data_dir = get_data_dir()?;
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("无法创建数据目录: {}", e))?;
        
        let file_path = data_dir.join("history.json");
        Ok(Self { file_path })
    }

    /// 获取所有记录
    pub fn get_all(&self) -> Result<Vec<DownloadRecord>, String> {
        if !self.file_path.exists() {
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(&self.file_path)
            .map_err(|e| format!("读取历史记录失败: {}", e))?;
        
        if content.trim().is_empty() {
            return Ok(Vec::new());
        }

        serde_json::from_str(&content)
            .map_err(|e| format!("解析历史记录失败: {}", e))
    }

    /// 添加记录
    pub fn add(&self, record: DownloadRecord) -> Result<(), String> {
        let mut records = self.get_all()?;
        records.insert(0, record); // 新记录插入到最前面
        self.save(&records)
    }

    /// 删除记录
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut records = self.get_all()?;
        records.retain(|r| r.id != id);
        self.save(&records)
    }

    /// 清空所有记录
    pub fn clear(&self) -> Result<(), String> {
        self.save(&Vec::new())
    }

    /// 保存记录到文件
    fn save(&self, records: &[DownloadRecord]) -> Result<(), String> {
        let content = serde_json::to_string_pretty(records)
            .map_err(|e| format!("序列化失败: {}", e))?;
        
        fs::write(&self.file_path, content)
            .map_err(|e| format!("保存历史记录失败: {}", e))
    }
}

/// 获取数据目录
fn get_data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|p| p.join("geo-downloader"))
        .ok_or_else(|| "无法获取数据目录".to_string())
}
