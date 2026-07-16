//! Per-task log writing and transparent plain/gzip reading.

use crate::task::TaskLog;
use chrono::{DateTime, Local, Utc};
use flate2::read::GzDecoder;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const TRUNCATION_MESSAGE: &str = "日志已达到 5 MiB，后续内容已截断";

#[derive(Debug, Clone, Default)]
pub struct LogMetadata {
    pub path: Option<PathBuf>,
    pub compressed: bool,
    pub original_size: u64,
    pub stored_size: u64,
    pub truncated: bool,
    pub updated_at: Option<DateTime<Utc>>,
}

pub struct TaskLogWriter {
    path: PathBuf,
    file: File,
    bytes_written: u64,
    limit: u64,
    truncated: bool,
    marker_written: bool,
}

impl TaskLogWriter {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::open_with_limit(path, MAX_LOG_BYTES)
    }

    pub(crate) fn open_with_limit(path: &Path, limit: u64) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建任务日志目录失败: {e}"))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("打开任务日志失败: {e}"))?;
        let bytes_written = file.metadata().map(|meta| meta.len()).unwrap_or_default();
        let marker_written = file_contains_marker(path);
        Ok(Self {
            path: path.to_path_buf(),
            file,
            bytes_written,
            limit,
            truncated: bytes_written >= limit || marker_written,
            marker_written,
        })
    }

    pub fn append(&mut self, level: &str, message: &str) -> Result<(), String> {
        if self.truncated {
            self.write_marker_once()?;
            return Ok(());
        }
        let line = format!(
            "[{}] [{}] {}\n",
            Local::now().format("%H:%M:%S"),
            level,
            message
        );
        let line_len = line.len() as u64;
        if self.bytes_written.saturating_add(line_len) > self.limit {
            self.truncated = true;
            self.write_marker_once()?;
            return Ok(());
        }
        self.file
            .write_all(line.as_bytes())
            .and_then(|_| self.file.flush())
            .map_err(|e| format!("写入任务日志失败: {e}"))?;
        self.bytes_written += line_len;
        Ok(())
    }

    fn write_marker_once(&mut self) -> Result<(), String> {
        if self.marker_written {
            return Ok(());
        }
        let marker = format!(
            "[{}] [WARN] {}\n",
            Local::now().format("%H:%M:%S"),
            TRUNCATION_MESSAGE
        );
        self.file
            .write_all(marker.as_bytes())
            .and_then(|_| self.file.flush())
            .map_err(|e| format!("写入日志截断标记失败: {e}"))?;
        self.bytes_written += marker.len() as u64;
        self.marker_written = true;
        Ok(())
    }

    pub fn metadata(&self) -> LogMetadata {
        let stored_size = self
            .file
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(self.bytes_written);
        LogMetadata {
            path: Some(self.path.clone()),
            compressed: false,
            original_size: stored_size,
            stored_size,
            truncated: self.truncated,
            updated_at: Some(Utc::now()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn read_log_file(path: &Path) -> Result<Vec<TaskLog>, String> {
    let file = File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "日志已清理或不存在".to_string()
        } else {
            format!("读取任务日志失败: {e}")
        }
    })?;
    let reader: Box<dyn BufRead> =
        if path.extension().and_then(|value| value.to_str()) == Some("gz") {
            Box::new(BufReader::new(GzDecoder::new(file)))
        } else {
            Box::new(BufReader::new(file))
        };
    parse_log_reader(reader)
}

fn parse_log_reader(reader: Box<dyn BufRead>) -> Result<Vec<TaskLog>, String> {
    reader
        .lines()
        .map(|line| line.map_err(|e| format!("解析任务日志失败: {e}")))
        .filter_map(|line| match line {
            Ok(line) => parse_log_line(&line).map(Ok),
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn parse_log_line(line: &str) -> Option<TaskLog> {
    let line = line.trim();
    let timestamp_end = line.find(']')?;
    if !line.starts_with('[') || timestamp_end <= 1 {
        return None;
    }
    let rest = line.get(timestamp_end + 1..)?.trim_start();
    if !rest.starts_with('[') {
        return None;
    }
    let level_end = rest.find(']')?;
    Some(TaskLog {
        timestamp: line[1..timestamp_end].to_string(),
        level: rest[1..level_end].to_string(),
        message: rest.get(level_end + 1..)?.trim_start().to_string(),
    })
}

fn file_contains_marker(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|content| content.contains(TRUNCATION_MESSAGE))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use tempfile::TempDir;

    #[test]
    fn writer_stops_at_limit_and_writes_one_truncation_marker() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("task.log");
        let mut writer = TaskLogWriter::open_with_limit(&path, 128).unwrap();
        for _ in 0..20 {
            writer.append("INFO", "abcdefghijklmnopqrstuvwxyz").unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(writer.metadata().truncated);
        assert_eq!(text.matches("后续内容已截断").count(), 1);
        assert!(text.len() <= 256);
    }

    #[test]
    fn reads_plain_log() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("task.log");
        std::fs::write(&path, "[12:00:00] [INFO] hello\n").unwrap();
        let logs = read_log_file(&path).unwrap();
        assert_eq!(logs[0].message, "hello");
    }

    #[test]
    fn reads_gzip_log() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("task.log.gz");
        let mut encoder = GzEncoder::new(File::create(&path).unwrap(), Compression::default());
        encoder
            .write_all(b"[12:00:00] [INFO] compressed\n")
            .unwrap();
        encoder.finish().unwrap();
        let logs = read_log_file(&path).unwrap();
        assert_eq!(logs[0].message, "compressed");
    }
}
