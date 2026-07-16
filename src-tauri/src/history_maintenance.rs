//! Bounded background maintenance for historical task logs.

use crate::history::HistoryStore;
use crate::task_log::{remove_log_file_variants, LogMetadata};
use chrono::{DateTime, Duration, Utc};
use flate2::write::GzEncoder;
use flate2::Compression;
use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

pub const DEFAULT_BATCH_SIZE: usize = 100;
const COMPRESS_AFTER_DAYS: i64 = 7;
const EXPIRE_AFTER_DAYS: i64 = 90;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MaintenanceReport {
    pub scanned: usize,
    pub compressed: usize,
    pub expired: usize,
    pub orphans_removed: usize,
}

pub fn run_batch(
    store: &HistoryStore,
    log_dir: &Path,
    active_paths: &HashSet<PathBuf>,
    limit: usize,
) -> Result<MaintenanceReport, String> {
    run_batch_at(store, log_dir, active_paths, Utc::now(), limit)
}

pub(crate) fn run_batch_at(
    store: &HistoryStore,
    log_dir: &Path,
    active_paths: &HashSet<PathBuf>,
    now: DateTime<Utc>,
    limit: usize,
) -> Result<MaintenanceReport, String> {
    let mut report = MaintenanceReport::default();
    if limit == 0 {
        return Ok(report);
    }

    let compress_before = now - Duration::days(COMPRESS_AFTER_DAYS);
    let expire_before = now - Duration::days(EXPIRE_AFTER_DAYS);
    for record in store.records_requiring_log_maintenance(compress_before, expire_before, limit)? {
        let Some(path) = record.log_file.as_ref().map(PathBuf::from) else {
            continue;
        };
        report.scanned += 1;
        if active_paths.contains(&path) {
            continue;
        }
        let age = now.signed_duration_since(record.created_at);
        if age >= Duration::days(EXPIRE_AFTER_DAYS) {
            remove_log_file_variants(&path)?;
            store.clear_log_reference(&record.id)?;
            report.expired += 1;
        } else if age >= Duration::days(COMPRESS_AFTER_DAYS) && !record.log_compressed {
            if !path.exists() {
                let compressed_path = path.with_extension("log.gz");
                if compressed_path.exists() {
                    let original_size = record.log_original_size.max(record.log_stored_size);
                    let stored_size = compressed_path
                        .metadata()
                        .map_err(|e| format!("读取压缩日志大小失败: {e}"))?
                        .len();
                    store.update_log_metadata(
                        &record.id,
                        &LogMetadata {
                            path: Some(compressed_path),
                            compressed: true,
                            original_size,
                            stored_size,
                            truncated: record.log_truncated,
                            updated_at: Some(now),
                        },
                    )?;
                } else {
                    store.clear_log_reference(&record.id)?;
                }
                continue;
            }
            let metadata = compress_log(&path, record.log_truncated, now)?;
            store.update_log_metadata(&record.id, &metadata)?;
            report.compressed += 1;
        }
    }

    let remaining = limit.saturating_sub(report.scanned);
    if remaining > 0 && log_dir.exists() {
        let referenced = store.referenced_log_paths()?;
        for entry in std::fs::read_dir(log_dir)
            .map_err(|e| format!("扫描日志目录失败: {e}"))?
            .flatten()
        {
            if report.orphans_removed >= remaining {
                break;
            }
            let path = entry.path();
            if !is_log_path(&path) || referenced.contains(&path) || active_paths.contains(&path) {
                continue;
            }
            std::fs::remove_file(&path)
                .map_err(|e| format!("清理孤儿日志失败 {}: {e}", path.display()))?;
            report.orphans_removed += 1;
        }
    }

    Ok(report)
}

fn compress_log(source: &Path, truncated: bool, now: DateTime<Utc>) -> Result<LogMetadata, String> {
    let original_size = source
        .metadata()
        .map_err(|e| format!("读取日志大小失败 {}: {e}", source.display()))?
        .len();
    let destination = source.with_extension("log.gz");
    let temporary = source.with_extension("log.gz.tmp");
    let result = (|| -> Result<(), String> {
        let input = File::open(source)
            .map(BufReader::new)
            .map_err(|e| format!("打开待压缩日志失败 {}: {e}", source.display()))?;
        let output = File::create(&temporary)
            .map(BufWriter::new)
            .map_err(|e| format!("创建日志压缩临时文件失败: {e}"))?;
        let mut encoder = GzEncoder::new(output, Compression::default());
        let mut input = input;
        io::copy(&mut input, &mut encoder).map_err(|e| format!("压缩任务日志失败: {e}"))?;
        let mut output = encoder
            .finish()
            .map_err(|e| format!("完成日志压缩失败: {e}"))?;
        output
            .flush()
            .map_err(|e| format!("刷新日志压缩文件失败: {e}"))?;
        drop(output);
        std::fs::rename(&temporary, &destination)
            .map_err(|e| format!("提交日志压缩文件失败: {e}"))?;
        std::fs::remove_file(source).map_err(|e| format!("删除已压缩的原日志失败: {e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result?;
    let stored_size = destination
        .metadata()
        .map_err(|e| format!("读取压缩日志大小失败: {e}"))?
        .len();
    Ok(LogMetadata {
        path: Some(destination),
        compressed: true,
        original_size,
        stored_size,
        truncated,
        updated_at: Some(now),
    })
}

fn is_log_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    name.starts_with("task_") && (name.ends_with(".log") || name.ends_with(".log.gz"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{DownloadRecord, DownloadStatus};
    use chrono::TimeZone;
    use tempfile::TempDir;

    fn record(id: &str, path: &Path, created_at: DateTime<Utc>) -> DownloadRecord {
        DownloadRecord {
            id: id.to_string(),
            name: id.to_string(),
            source: "source".to_string(),
            source_name: "Source".to_string(),
            zoom: 1,
            format: "tiles".to_string(),
            file_path: "D:/output".to_string(),
            file_size: 0,
            tile_count: 1,
            failed_count: 0,
            created_at,
            status: DownloadStatus::Completed,
            log_file: Some(path.to_string_lossy().into_owned()),
            duration_secs: None,
            has_pyramid: false,
            log_compressed: false,
            log_original_size: 0,
            log_stored_size: 0,
            log_truncated: false,
            log_updated_at: None,
        }
    }

    #[test]
    fn maintenance_compresses_after_7_days_and_expires_after_90_days() {
        let tmp = TempDir::new().unwrap();
        let logs = tmp.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let store = HistoryStore::open_at(tmp.path()).unwrap();
        let now = Utc.timestamp_opt(2_000_000_000, 0).unwrap();
        let recent = logs.join("task_recent.log");
        let old = logs.join("task_old.log");
        let expired = logs.join("task_expired.log");
        for path in [&recent, &old, &expired] {
            std::fs::write(path, "[12:00:00] [INFO] hello\n").unwrap();
        }
        store
            .add(&record("recent", &recent, now - Duration::days(6)))
            .unwrap();
        store
            .add(&record("old", &old, now - Duration::days(8)))
            .unwrap();
        store
            .add(&record("expired", &expired, now - Duration::days(91)))
            .unwrap();

        let report = run_batch_at(&store, &logs, &HashSet::new(), now, 100).unwrap();
        assert!(recent.exists());
        assert!(!old.exists());
        assert!(old.with_extension("log.gz").exists());
        assert!(!expired.exists());
        assert_eq!(report.compressed, 1);
        assert_eq!(report.expired, 1);
        assert!(store.get("expired").unwrap().unwrap().log_file.is_none());
    }

    #[test]
    fn maintenance_skips_active_and_removes_orphans_in_batches() {
        let tmp = TempDir::new().unwrap();
        let logs = tmp.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let store = HistoryStore::open_at(tmp.path()).unwrap();
        let now = Utc.timestamp_opt(2_000_000_000, 0).unwrap();
        let active = logs.join("task_active.log");
        let orphan = logs.join("task_orphan.log");
        std::fs::write(&active, "active").unwrap();
        std::fs::write(&orphan, "orphan").unwrap();
        store
            .add(&record("active", &active, now - Duration::days(30)))
            .unwrap();
        let active_set = HashSet::from([active.clone()]);

        let report = run_batch_at(&store, &logs, &active_set, now, 1).unwrap();
        assert!(active.exists());
        assert!(orphan.exists());
        assert_eq!(report.scanned, 1);

        let report = run_batch_at(&store, &logs, &active_set, now, 2).unwrap();
        assert!(active.exists());
        assert!(!orphan.exists());
        assert_eq!(report.orphans_removed, 1);
    }
}
