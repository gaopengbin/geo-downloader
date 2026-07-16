//! Download history backed by SQLite.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use uuid::Uuid;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<u64>,
    #[serde(default)]
    pub has_pyramid: bool,
    #[serde(default)]
    pub log_compressed: bool,
    #[serde(default)]
    pub log_original_size: u64,
    #[serde(default)]
    pub log_stored_size: u64,
    #[serde(default)]
    pub log_truncated: bool,
    #[serde(default)]
    pub log_updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Completed,
    Failed,
}

impl DownloadStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    fn from_str(value: &str) -> rusqlite::Result<Self> {
        match value {
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown download status: {other}").into(),
            )),
        }
    }
}

impl DownloadRecord {
    #[allow(clippy::too_many_arguments)]
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
            has_pyramid: false,
            log_compressed: false,
            log_original_size: 0,
            log_stored_size: 0,
            log_truncated: false,
            log_updated_at: None,
        }
    }

    pub fn with_log_file(mut self, log_file: Option<String>) -> Self {
        self.log_file = log_file;
        self
    }

    pub fn with_duration(mut self, secs: u64) -> Self {
        self.duration_secs = Some(secs);
        self
    }

    pub fn with_pyramid(mut self, has: bool) -> Self {
        self.has_pyramid = has;
        self
    }

    pub fn with_log_metadata(mut self, metadata: &crate::task_log::LogMetadata) -> Self {
        self.log_file = metadata
            .path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        self.log_compressed = metadata.compressed;
        self.log_original_size = metadata.original_size;
        self.log_stored_size = metadata.stored_size;
        self.log_truncated = metadata.truncated;
        self.log_updated_at = metadata.updated_at;
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryPage {
    pub records: Vec<DownloadRecord>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone)]
pub struct HistoryStore {
    db_path: PathBuf,
    legacy_json_path: PathBuf,
}

static GLOBAL: OnceLock<HistoryStore> = OnceLock::new();
static GLOBAL_INIT: Mutex<()> = Mutex::new(());

impl HistoryStore {
    pub fn global() -> Result<&'static Self, String> {
        if let Some(store) = GLOBAL.get() {
            return Ok(store);
        }

        let _guard = GLOBAL_INIT
            .lock()
            .map_err(|_| "历史数据库初始化锁异常".to_string())?;
        if let Some(store) = GLOBAL.get() {
            return Ok(store);
        }

        let store = Self::open_at(&get_data_dir()?)?;
        store.migrate_legacy_json()?;
        GLOBAL
            .set(store)
            .map_err(|_| "历史数据库初始化失败".to_string())?;
        GLOBAL
            .get()
            .ok_or_else(|| "历史数据库初始化失败".to_string())
    }

    pub(crate) fn open_at(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| format!("创建历史数据目录失败: {e}"))?;
        let store = Self {
            db_path: data_dir.join("history.db"),
            legacy_json_path: data_dir.join("history.json"),
        };
        store.with_connection(|conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS download_history (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    source TEXT NOT NULL,
                    source_name TEXT NOT NULL,
                    zoom INTEGER NOT NULL,
                    format TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    tile_count INTEGER NOT NULL,
                    failed_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    log_path TEXT,
                    duration_secs INTEGER,
                    has_pyramid INTEGER NOT NULL DEFAULT 0,
                    log_compressed INTEGER NOT NULL DEFAULT 0,
                    log_original_size INTEGER NOT NULL DEFAULT 0,
                    log_stored_size INTEGER NOT NULL DEFAULT 0,
                    log_truncated INTEGER NOT NULL DEFAULT 0,
                    log_updated_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_download_history_created_at
                    ON download_history(created_at DESC);",
            )?;
            Ok(())
        })?;
        Ok(store)
    }

    fn connection(&self) -> Result<Connection, String> {
        let conn =
            Connection::open(&self.db_path).map_err(|e| format!("打开历史数据库失败: {e}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("设置历史数据库超时失败: {e}"))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("启用历史数据库 WAL 失败: {e}"))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("设置历史数据库同步模式失败: {e}"))?;
        Ok(conn)
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let mut conn = self.connection()?;
        operation(&mut conn).map_err(|e| format!("历史数据库操作失败: {e}"))
    }

    pub fn migrate_legacy_json(&self) -> Result<u64, String> {
        if !self.legacy_json_path.exists() {
            return Ok(0);
        }
        let bytes = std::fs::read(&self.legacy_json_path)
            .map_err(|e| format!("读取旧历史记录失败: {e}"))?;
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return self.finish_empty_migration();
        }
        let records: Vec<DownloadRecord> = serde_json::from_slice(&bytes)
            .map_err(|e| format!("旧历史记录格式损坏，已保留原文件: {e}"))?;

        self.with_connection(|conn| {
            let tx = conn.transaction()?;
            for record in &records {
                insert_record(&tx, record, true)?;
            }
            tx.commit()
        })?;
        self.rename_migrated_json()?;
        Ok(records.len() as u64)
    }

    fn finish_empty_migration(&self) -> Result<u64, String> {
        self.rename_migrated_json()?;
        Ok(0)
    }

    fn rename_migrated_json(&self) -> Result<(), String> {
        let preferred = self.legacy_json_path.with_extension("json.migrated");
        let destination = if preferred.exists() {
            self.legacy_json_path.with_extension(format!(
                "json.migrated.{}",
                Utc::now().format("%Y%m%d%H%M%S")
            ))
        } else {
            preferred
        };
        std::fs::rename(&self.legacy_json_path, &destination)
            .map_err(|e| format!("历史迁移已写入数据库，但旧文件备份失败，原文件仍保留: {e}"))
    }

    pub fn add(&self, record: &DownloadRecord) -> Result<(), String> {
        self.with_connection(|conn| insert_record(conn, record, false))
    }

    pub fn get(&self, id: &str) -> Result<Option<DownloadRecord>, String> {
        self.with_connection(|conn| {
            conn.query_row(
                &format!("SELECT {HISTORY_COLUMNS} FROM download_history WHERE id = ?1"),
                [id],
                row_to_record,
            )
            .optional()
        })
    }

    pub fn page(&self, page: u32, page_size: u32) -> Result<HistoryPage, String> {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 200);
        self.with_connection(|conn| {
            let total = conn.query_row("SELECT COUNT(*) FROM download_history", [], |row| {
                row.get::<_, u64>(0)
            })?;
            let offset = u64::from(page - 1) * u64::from(page_size);
            let mut stmt = conn.prepare(&format!(
                "SELECT {HISTORY_COLUMNS} FROM download_history
                 ORDER BY created_at DESC, rowid DESC LIMIT ?1 OFFSET ?2"
            ))?;
            let records = stmt
                .query_map(params![page_size, offset], row_to_record)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(HistoryPage {
                records,
                total,
                page,
                page_size,
            })
        })
    }

    pub fn update(&self, record: &DownloadRecord) -> Result<(), String> {
        self.add(record)
    }

    pub fn delete(&self, id: &str) -> Result<Option<PathBuf>, String> {
        self.with_connection(|conn| {
            let tx = conn.transaction()?;
            let path = tx
                .query_row(
                    "SELECT log_path FROM download_history WHERE id = ?1",
                    [id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
                .map(PathBuf::from);
            tx.execute("DELETE FROM download_history WHERE id = ?1", [id])?;
            tx.commit()?;
            Ok(path)
        })
    }

    pub fn clear(&self) -> Result<Vec<PathBuf>, String> {
        self.with_connection(|conn| {
            let tx = conn.transaction()?;
            let paths = {
                let mut stmt =
                    tx.prepare("SELECT log_path FROM download_history WHERE log_path IS NOT NULL")?;
                let paths = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .map(|path| path.map(PathBuf::from))
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                paths
            };
            tx.execute("DELETE FROM download_history", [])?;
            tx.commit()?;
            Ok(paths)
        })
    }

    pub fn update_log_metadata(
        &self,
        id: &str,
        metadata: &crate::task_log::LogMetadata,
    ) -> Result<(), String> {
        self.with_connection(|conn| {
            conn.execute(
                "UPDATE download_history SET
                    log_path = ?2, log_compressed = ?3, log_original_size = ?4,
                    log_stored_size = ?5, log_truncated = ?6, log_updated_at = ?7
                 WHERE id = ?1",
                params![
                    id,
                    metadata
                        .path
                        .as_ref()
                        .map(|p| p.to_string_lossy().into_owned()),
                    metadata.compressed,
                    to_i64(metadata.original_size),
                    to_i64(metadata.stored_size),
                    metadata.truncated,
                    metadata.updated_at.map(|value| value.to_rfc3339()),
                ],
            )?;
            Ok(())
        })
    }

    pub fn clear_log_reference(&self, id: &str) -> Result<(), String> {
        self.with_connection(|conn| {
            conn.execute(
                "UPDATE download_history SET
                    log_path = NULL, log_compressed = 0, log_original_size = 0,
                    log_stored_size = 0, log_truncated = 0, log_updated_at = NULL
                 WHERE id = ?1",
                [id],
            )?;
            Ok(())
        })
    }

    pub fn referenced_log_paths(&self) -> Result<HashSet<PathBuf>, String> {
        self.with_connection(|conn| {
            let mut stmt =
                conn.prepare("SELECT log_path FROM download_history WHERE log_path IS NOT NULL")?;
            let paths = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .map(|path| path.map(PathBuf::from))
                .collect::<rusqlite::Result<HashSet<_>>>()?;
            Ok(paths)
        })
    }

    pub fn records_requiring_log_maintenance(
        &self,
        compress_before: DateTime<Utc>,
        expire_before: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<DownloadRecord>, String> {
        self.with_connection(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT {HISTORY_COLUMNS} FROM download_history
                 WHERE log_path IS NOT NULL
                   AND (created_at <= ?1 OR (created_at <= ?2 AND log_compressed = 0))
                 ORDER BY created_at ASC LIMIT ?3"
            ))?;
            let records = stmt
                .query_map(
                    params![
                        expire_before.to_rfc3339(),
                        compress_before.to_rfc3339(),
                        limit as u64
                    ],
                    row_to_record,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(records)
        })
    }
}

const HISTORY_COLUMNS: &str = "id, name, source, source_name, zoom, format, file_path,
    file_size, tile_count, failed_count, created_at, status, log_path, duration_secs,
    has_pyramid, log_compressed, log_original_size, log_stored_size, log_truncated,
    log_updated_at";

fn insert_record(
    conn: &Connection,
    record: &DownloadRecord,
    ignore_conflict: bool,
) -> rusqlite::Result<()> {
    let conflict = if ignore_conflict { "IGNORE" } else { "REPLACE" };
    conn.execute(
        &format!(
            "INSERT OR {conflict} INTO download_history (
                id, name, source, source_name, zoom, format, file_path, file_size,
                tile_count, failed_count, created_at, status, log_path, duration_secs,
                has_pyramid, log_compressed, log_original_size, log_stored_size,
                log_truncated, log_updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
             )"
        ),
        params![
            record.id,
            record.name,
            record.source,
            record.source_name,
            record.zoom,
            record.format,
            record.file_path,
            to_i64(record.file_size),
            record.tile_count,
            record.failed_count,
            record.created_at.to_rfc3339(),
            record.status.as_str(),
            record.log_file,
            record.duration_secs.map(to_i64),
            record.has_pyramid,
            record.log_compressed,
            to_i64(record.log_original_size),
            to_i64(record.log_stored_size),
            record.log_truncated,
            record.log_updated_at.map(|value| value.to_rfc3339()),
        ],
    )?;
    Ok(())
}

fn row_to_record(row: &Row<'_>) -> rusqlite::Result<DownloadRecord> {
    let created_at: String = row.get(10)?;
    let log_updated_at: Option<String> = row.get(19)?;
    Ok(DownloadRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        source: row.get(2)?,
        source_name: row.get(3)?,
        zoom: row.get(4)?,
        format: row.get(5)?,
        file_path: row.get(6)?,
        file_size: from_i64(row.get(7)?),
        tile_count: row.get(8)?,
        failed_count: row.get(9)?,
        created_at: parse_datetime(created_at, 10)?,
        status: DownloadStatus::from_str(&row.get::<_, String>(11)?)?,
        log_file: row.get(12)?,
        duration_secs: row.get::<_, Option<i64>>(13)?.map(from_i64),
        has_pyramid: row.get(14)?,
        log_compressed: row.get(15)?,
        log_original_size: from_i64(row.get(16)?),
        log_stored_size: from_i64(row.get(17)?),
        log_truncated: row.get(18)?,
        log_updated_at: log_updated_at
            .map(|value| parse_datetime(value, 19))
            .transpose()?,
    })
}

fn parse_datetime(value: String, column: usize) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                column,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn from_i64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or_default()
}

fn get_data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join("geo-downloader"))
        .ok_or_else(|| "无法获取历史数据目录".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tempfile::TempDir;

    fn record(id: &str, second: i64) -> DownloadRecord {
        DownloadRecord {
            id: id.to_string(),
            name: format!("task-{id}"),
            source: "arcgis".to_string(),
            source_name: "ArcGIS 卫星".to_string(),
            zoom: 17,
            format: "geotiff".to_string(),
            file_path: format!("D:/{id}.tif"),
            file_size: 123,
            tile_count: 20,
            failed_count: 0,
            created_at: Utc.timestamp_opt(second, 0).unwrap(),
            status: DownloadStatus::Completed,
            log_file: None,
            duration_secs: Some(1),
            has_pyramid: false,
            log_compressed: false,
            log_original_size: 0,
            log_stored_size: 0,
            log_truncated: false,
            log_updated_at: None,
        }
    }

    #[test]
    fn page_returns_newest_records_and_total() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::open_at(tmp.path()).unwrap();
        store.add(&record("old", 10)).unwrap();
        store.add(&record("new", 20)).unwrap();
        let page = store.page(1, 1).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.page, 1);
        assert_eq!(page.page_size, 1);
        assert_eq!(page.records[0].id, "new");
    }

    #[test]
    fn page_clamps_size_and_page_number() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::open_at(tmp.path()).unwrap();
        store.add(&record("one", 10)).unwrap();
        let page = store.page(0, 999).unwrap();
        assert_eq!(page.page, 1);
        assert_eq!(page.page_size, 200);
    }

    #[test]
    fn migrates_legacy_json_once_and_preserves_fields() {
        let tmp = TempDir::new().unwrap();
        let legacy = vec![record("a", 10), record("b", 20)];
        std::fs::write(
            tmp.path().join("history.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();
        let store = HistoryStore::open_at(tmp.path()).unwrap();
        assert_eq!(store.migrate_legacy_json().unwrap(), 2);
        assert_eq!(store.migrate_legacy_json().unwrap(), 0);
        let page = store.page(1, 50).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.records[0].id, "b");
        assert!(tmp.path().join("history.json.migrated").exists());
        assert!(!tmp.path().join("history.json").exists());
    }

    #[test]
    fn corrupt_legacy_json_is_kept_and_database_stays_empty() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("history.json"), b"not-json").unwrap();
        let store = HistoryStore::open_at(tmp.path()).unwrap();
        assert!(store.migrate_legacy_json().is_err());
        assert!(tmp.path().join("history.json").exists());
        assert_eq!(store.page(1, 50).unwrap().total, 0);
    }

    #[test]
    fn delete_update_and_clear_are_single_record_operations() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::open_at(tmp.path()).unwrap();
        let mut a = record("a", 10);
        store.add(&a).unwrap();
        store.add(&record("b", 20)).unwrap();
        a.has_pyramid = true;
        store.update(&a).unwrap();
        assert!(store.get("a").unwrap().unwrap().has_pyramid);
        assert_eq!(store.delete("a").unwrap(), None);
        assert!(store.get("a").unwrap().is_none());
        assert!(store.clear().unwrap().is_empty());
        assert_eq!(store.page(1, 50).unwrap().total, 0);
    }

    #[test]
    fn concurrent_adds_do_not_lose_records() {
        let tmp = TempDir::new().unwrap();
        let store = std::sync::Arc::new(HistoryStore::open_at(tmp.path()).unwrap());
        let joins = (0..32)
            .map(|i| {
                let store = store.clone();
                std::thread::spawn(move || store.add(&record(&format!("r{i}"), i)).unwrap())
            })
            .collect::<Vec<_>>();
        for join in joins {
            join.join().unwrap();
        }
        assert_eq!(store.page(1, 50).unwrap().total, 32);
    }

    #[test]
    fn migrates_40k_records_and_pages_without_loading_all_rows() {
        let tmp = TempDir::new().unwrap();
        let records = (0..40_000)
            .map(|i| record(&format!("r{i}"), i))
            .collect::<Vec<_>>();
        std::fs::write(
            tmp.path().join("history.json"),
            serde_json::to_vec(&records).unwrap(),
        )
        .unwrap();
        let store = HistoryStore::open_at(tmp.path()).unwrap();
        assert_eq!(store.migrate_legacy_json().unwrap(), 40_000);
        let page = store.page(1, 50).unwrap();
        assert_eq!(page.total, 40_000);
        assert_eq!(page.records.len(), 50);
        assert_eq!(page.records[0].id, "r39999");
    }
}
