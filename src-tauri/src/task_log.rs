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

pub(crate) fn log_file_variants(path: &Path) -> Vec<PathBuf> {
    let value = path.to_string_lossy();
    let mut variants = vec![path.to_path_buf()];
    if let Some(raw) = value.strip_suffix(".log.gz") {
        variants.push(PathBuf::from(format!("{raw}.log")));
    } else if value.ends_with(".log") {
        variants.push(PathBuf::from(format!("{value}.gz")));
    }
    variants.sort();
    variants.dedup();
    variants
}

pub(crate) fn task_log_files(log_dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !log_dir.exists() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    for entry in std::fs::read_dir(log_dir)
        .map_err(|error| format!("扫描任务日志目录失败 {}: {error}", log_dir.display()))?
    {
        let entry = entry.map_err(|error| format!("读取任务日志目录项失败: {error}"))?;
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if entry.file_type().map(|kind| kind.is_file()).unwrap_or(false)
            && name.starts_with("task_")
            && (name.ends_with(".log") || name.ends_with(".log.gz"))
        {
            paths.push(path);
        }
    }
    Ok(paths)
}

pub(crate) fn remove_log_file_variants(path: &Path) -> Result<usize, String> {
    let mut removed = 0;
    for variant in log_file_variants(path) {
        match std::fs::remove_file(&variant) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "删除任务日志失败 {}: {error}",
                    variant.display()
                ))
            }
        }
    }
    Ok(removed)
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

    #[test]
    fn removes_plain_and_gzip_variants_together() {
        let tmp = TempDir::new().unwrap();
        let plain = tmp.path().join("task_123.log");
        let gzip = tmp.path().join("task_123.log.gz");
        std::fs::write(&plain, b"plain").unwrap();
        std::fs::write(&gzip, b"gzip").unwrap();

        assert_eq!(remove_log_file_variants(&plain).unwrap(), 2);
        assert!(!plain.exists());
        assert!(!gzip.exists());
        assert_eq!(remove_log_file_variants(&plain).unwrap(), 0);
    }

    #[test]
    fn reports_log_deletion_errors() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("task_locked.log");
        std::fs::create_dir(&path).unwrap();

        let error = remove_log_file_variants(&path).unwrap_err();
        assert!(error.contains("删除任务日志失败"));
        assert!(path.exists());
    }

    #[test]
    fn lists_only_task_log_files() {
        let tmp = TempDir::new().unwrap();
        let plain = tmp.path().join("task_old.log");
        let gzip = tmp.path().join("task_older.log.gz");
        std::fs::write(&plain, b"plain").unwrap();
        std::fs::write(&gzip, b"gzip").unwrap();
        std::fs::write(tmp.path().join("application.log"), b"keep").unwrap();

        let mut paths = task_log_files(tmp.path()).unwrap();
        paths.sort();
        let mut expected = vec![plain, gzip];
        expected.sort();
        assert_eq!(paths, expected);
    }
}
