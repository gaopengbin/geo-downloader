# 历史记录与任务日志性能改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将历史记录迁移到分页 SQLite，并为任务日志增加无阻塞写入、5 MiB 截断、7 天压缩和 90 天清理，避免长期使用后拖慢批量下载。

**Architecture:** `history.rs` 负责 SQLite schema、JSON 幂等迁移和历史 CRUD；`task_log.rs` 负责单任务日志写入、gzip 读取和文件维护；`history_maintenance.rs` 负责按批次压缩、过期及孤儿日志清理。Tauri 命令通过 `spawn_blocking` 调用共享 `HistoryStore`，前端只请求当前 50 条历史。

**Tech Stack:** Rust 2021、rusqlite 0.32（bundled）、flate2、chrono、Tauri 2、React 19、TanStack Query 5、TypeScript 6

---

## 文件结构

- Modify: `src-tauri/src/history.rs` — SQLite 历史模型、schema、迁移、分页和 CRUD。
- Create: `src-tauri/src/task_log.rs` — 独立日志 writer、5 MiB 截断、普通/gzip 日志读取。
- Create: `src-tauri/src/history_maintenance.rs` — 7 天压缩、90 天过期、孤儿日志清理的分批维护。
- Modify: `src-tauri/src/task.rs` — 使用独立日志 writer，磁盘 IO 移出任务表全局锁。
- Modify: `src-tauri/src/commands.rs` — 分页历史 API、异步数据库调用、日志元数据写入、删除联动。
- Modify: `src-tauri/src/lib.rs` — 注册模块并启动低优先级维护线程。
- Modify: `frontend/src/types/api.ts` — 分页响应和日志元数据类型。
- Modify: `frontend/src/features/history/history-api.ts` — 分页参数。
- Modify: `frontend/src/features/history/history-panel.tsx` — 每页 50 条和翻页 UI。
- Test: 各 Rust 模块内的 `#[cfg(test)]` 单元测试。

### Task 1: 建立 SQLite 历史 schema 和分页模型

**Files:**
- Modify: `src-tauri/src/history.rs:1-185`

- [ ] **Step 1: 写 schema、单条新增和分页失败测试**

在 `history.rs` 底部增加测试模块，先引用尚未实现的 `HistoryStore::open_at`、`add` 和 `page`：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
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
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml history::tests::page -- --nocapture`

Expected: FAIL，提示 `HistoryStore` 或新增日志字段未定义。

- [ ] **Step 3: 替换 JSON manager 为 SQLite store**

在 `history.rs` 中保留 `DownloadRecord`/`DownloadStatus` 名称以减少调用方改动，增加字段和分页类型：

```rust
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadRecord {
    // 保留现有字段
    // ...
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
```

实现 `HistoryStore::global()`、`open_at()` 和连接初始化。每次操作打开短生命周期连接，启用 WAL 和 busy timeout：

```rust
impl HistoryStore {
    pub fn global() -> Result<&'static Self, String> {
        if let Some(store) = GLOBAL.get() {
            return Ok(store);
        }
        let data_dir = get_data_dir()?;
        let store = Self::open_at(&data_dir)?;
        let _ = GLOBAL.set(store);
        GLOBAL.get().ok_or_else(|| "历史数据库初始化失败".to_string())
    }

    pub(crate) fn open_at(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
        let store = Self {
            db_path: data_dir.join("history.db"),
            legacy_json_path: data_dir.join("history.json"),
        };
        store.with_connection(|conn| {
            conn.execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=NORMAL;
                 PRAGMA busy_timeout=5000;
                 CREATE TABLE IF NOT EXISTS download_history (
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
                 ON download_history(created_at DESC);"
            )?;
            Ok(())
        })?;
        Ok(store)
    }

    fn with_connection<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut conn = Connection::open(&self.db_path).map_err(|e| format!("打开历史数据库失败: {e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
        f(&mut conn).map_err(|e| format!("历史数据库操作失败: {e}"))
    }
}
```

实现私有 `insert_record`、`row_to_record`，以及 `add(&DownloadRecord)`、`page(page, page_size)`。SQL 使用 `INSERT OR REPLACE`；分页使用 `COUNT(*)` 和 `ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`。`status` 存为 `completed` / `failed`，日期存 RFC3339。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml history::tests::page -- --nocapture`

Expected: 2 tests PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/history.rs
git commit -m "feat: store paged download history in sqlite"
```

### Task 2: 实现旧 JSON 全量幂等迁移

**Files:**
- Modify: `src-tauri/src/history.rs`

- [ ] **Step 1: 写迁移成功、重复执行和损坏文件测试**

```rust
#[test]
fn migrates_legacy_json_once_and_preserves_fields() {
    let tmp = TempDir::new().unwrap();
    let legacy = vec![record("a", 10), record("b", 20)];
    std::fs::write(
        tmp.path().join("history.json"),
        serde_json::to_vec_pretty(&legacy).unwrap(),
    ).unwrap();

    let store = HistoryStore::open_at(tmp.path()).unwrap();
    store.migrate_legacy_json().unwrap();
    store.migrate_legacy_json().unwrap();

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml history::tests::migrat history::tests::corrupt -- --nocapture`

Expected: FAIL，提示 `migrate_legacy_json` 未定义。

- [ ] **Step 3: 实现单事务迁移**

```rust
pub fn migrate_legacy_json(&self) -> Result<u64, String> {
    if !self.legacy_json_path.exists() {
        return Ok(0);
    }
    let bytes = std::fs::read(&self.legacy_json_path)
        .map_err(|e| format!("读取旧历史记录失败: {e}"))?;
    let records: Vec<DownloadRecord> = serde_json::from_slice(&bytes)
        .map_err(|e| format!("旧历史记录格式损坏，已保留原文件: {e}"))?;

    self.with_connection(|conn| {
        let tx = conn.transaction()?;
        for record in &records {
            insert_record(&tx, record, true)?; // INSERT OR IGNORE
        }
        tx.commit()?;
        Ok(())
    })?;

    let migrated = self.legacy_json_path.with_extension("json.migrated");
    if migrated.exists() {
        std::fs::remove_file(&migrated)
            .map_err(|e| format!("替换旧历史备份失败: {e}"))?;
    }
    std::fs::rename(&self.legacy_json_path, &migrated)
        .map_err(|e| format!("历史迁移已完成，但旧文件重命名失败: {e}"))?;
    Ok(records.len() as u64)
}
```

在 `HistoryStore::global()` 初始化后调用一次迁移；迁移错误向调用方返回，不把 JSON 改名或清空。

- [ ] **Step 4: 运行 history 全部测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml history::tests -- --nocapture`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/history.rs
git commit -m "feat: migrate legacy history json to sqlite"
```

### Task 3: 完成历史单条 CRUD 和并发一致性

**Files:**
- Modify: `src-tauri/src/history.rs`

- [ ] **Step 1: 写增删改清空及并发新增测试**

```rust
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

    let deleted_log = store.delete("a").unwrap();
    assert_eq!(deleted_log, None);
    assert!(store.get("a").unwrap().is_none());

    let logs = store.clear().unwrap();
    assert!(logs.is_empty());
    assert_eq!(store.page(1, 50).unwrap().total, 0);
}

#[test]
fn concurrent_adds_do_not_lose_records() {
    let tmp = TempDir::new().unwrap();
    let store = std::sync::Arc::new(HistoryStore::open_at(tmp.path()).unwrap());
    let mut joins = Vec::new();
    for i in 0..32 {
        let store = store.clone();
        joins.push(std::thread::spawn(move || {
            store.add(&record(&format!("r{i}"), i)).unwrap();
        }));
    }
    for join in joins { join.join().unwrap(); }
    assert_eq!(store.page(1, 50).unwrap().total, 32);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml history::tests::delete_update history::tests::concurrent_adds -- --nocapture`

Expected: FAIL，提示 `get/delete/update/clear` 签名未完成。

- [ ] **Step 3: 实现 CRUD 与日志元数据更新方法**

实现：

```rust
pub fn get(&self, id: &str) -> Result<Option<DownloadRecord>, String>;
pub fn update(&self, record: &DownloadRecord) -> Result<(), String>;
pub fn delete(&self, id: &str) -> Result<Option<PathBuf>, String>;
pub fn clear(&self) -> Result<Vec<PathBuf>, String>;
pub fn update_log_metadata(&self, id: &str, meta: &LogMetadata) -> Result<(), String>;
pub fn clear_log_reference(&self, id: &str) -> Result<(), String>;
pub fn referenced_log_paths(&self) -> Result<std::collections::HashSet<PathBuf>, String>;
```

`delete` 在删除前查询 `log_path` 并返回；`clear` 先收集全部非空日志路径再用单条 `DELETE FROM download_history` 清空。不要在数据库事务内删除文件。

- [ ] **Step 4: 运行 history 全部测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml history::tests -- --nocapture`

Expected: PASS，包括 32 个并发新增记录完整保留。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/history.rs
git commit -m "feat: add atomic history record operations"
```

### Task 4: 将任务日志写入移出 TaskManager 全局锁并限制 5 MiB

**Files:**
- Create: `src-tauri/src/task_log.rs`
- Modify: `src-tauri/src/task.rs:63-177,383-466`
- Modify: `src-tauri/src/lib.rs:1-22`

- [ ] **Step 1: 写日志截断和普通日志读取测试**

在 `task_log.rs` 中定义测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
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
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml task_log::tests -- --nocapture`

Expected: FAIL，模块和类型未定义。

- [ ] **Step 3: 实现 TaskLogWriter**

`task_log.rs` 提供：

```rust
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

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
    file: std::fs::File,
    bytes_written: u64,
    limit: u64,
    truncated: bool,
    marker_written: bool,
}
```

`append` 格式保持 `[HH:MM:SS] [LEVEL] message`。普通行超过限制时只写一次截断 marker；`metadata()` 使用当前文件长度返回元数据。`read_log_file` 先实现普通 `.log` 读取，复用当前解析规则。

- [ ] **Step 4: 改造 TaskEntry 和 append_log**

将 `TaskEntry.log_file` 改为：

```rust
log_writer: Option<Arc<std::sync::Mutex<crate::task_log::TaskLogWriter>>>,
```

`append_log` 必须先在任务表锁内更新内存并克隆 writer，再释放任务表锁后写磁盘：

```rust
pub fn append_log(&self, id: &str, level: &str, message: &str) -> Option<TaskLog> {
    let log = TaskLog { /* 当前时间、level、message */ };
    let writer = {
        let mut tasks = self.tasks.lock().unwrap();
        let entry = tasks.get_mut(id)?;
        entry.logs.push(log.clone());
        entry.log_writer.clone()
    };
    if let Some(writer) = writer {
        if let Ok(mut writer) = writer.lock() {
            let _ = writer.append(level, message);
        }
    }
    Some(log)
}
```

增加 `TaskManager::get_log_metadata(id)`，从独立 writer 读取 metadata。`get_log_file_path` 使用 metadata path，不枚举目录。

- [ ] **Step 5: 注册模块并运行测试**

在 `lib.rs` 增加 `pub mod task_log;`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml task_log::tests -- --nocapture`

Expected: PASS。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/task_log.rs src-tauri/src/task.rs src-tauri/src/lib.rs
git commit -m "fix: isolate and bound task log writes"
```

### Task 5: 实现 gzip 日志透明读取和后台维护算法

**Files:**
- Modify: `src-tauri/src/task_log.rs`
- Create: `src-tauri/src/history_maintenance.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写 gzip、7 天压缩、90 天过期和孤儿清理测试**

使用可注入的 `now`，不要让测试依赖系统时间：

```rust
#[test]
fn reads_gzip_log_transparently() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("task.log.gz");
    write_gzip_for_test(&path, b"[12:00:00] [WARN] compressed\n");
    let logs = read_log_file(&path).unwrap();
    assert_eq!(logs[0].level, "WARN");
}
```

在 `history_maintenance.rs`：

```rust
#[test]
fn maintenance_compresses_after_7_days_and_expires_after_90_days() {
    let fixture = MaintenanceFixture::new();
    let recent = fixture.log("recent.log", 6);
    let old = fixture.log("old.log", 8);
    let expired = fixture.log("expired.log", 91);

    let report = run_batch_at(
        &fixture.store,
        fixture.logs_dir(),
        &std::collections::HashSet::new(),
        fixture.now(),
        100,
    ).unwrap();

    assert!(recent.exists());
    assert!(!old.exists());
    assert!(old.with_extension("log.gz").exists());
    assert!(!expired.exists());
    assert_eq!(report.compressed, 1);
    assert_eq!(report.expired, 1);
}

#[test]
fn maintenance_skips_active_and_removes_orphans_in_batches() {
    let fixture = MaintenanceFixture::new();
    let active = fixture.log("active.log", 30);
    let orphan = fixture.orphan_log("orphan.log", 30);
    let active_set = std::collections::HashSet::from([active.clone()]);

    let report = run_batch_at(&fixture.store, fixture.logs_dir(), &active_set, fixture.now(), 1).unwrap();
    assert!(active.exists());
    assert!(!orphan.exists());
    assert_eq!(report.processed, 1);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml task_log::tests::reads_gzip history_maintenance::tests -- --nocapture`

Expected: FAIL，gzip 和 maintenance API 未定义。

- [ ] **Step 3: 实现 gzip 读取和原子压缩**

`task_log.rs` 中根据扩展名选择 reader：

```rust
pub fn read_log_file(path: &Path) -> Result<Vec<TaskLog>, String> {
    let file = std::fs::File::open(path)
        .map_err(|_| "日志已清理或不存在".to_string())?;
    let mut text = String::new();
    if path.extension().and_then(|e| e.to_str()) == Some("gz") {
        let mut decoder = flate2::read::GzDecoder::new(file);
        std::io::Read::read_to_string(&mut decoder, &mut text)
            .map_err(|e| format!("解压日志失败: {e}"))?;
    } else {
        let mut reader = std::io::BufReader::new(file);
        std::io::Read::read_to_string(&mut reader, &mut text)
            .map_err(|e| format!("读取日志失败: {e}"))?;
    }
    parse_log_text(&text)
}
```

增加 `compress_log(path)`：写入同目录 `.gz.tmp`，`GzEncoder<BufWriter<File>>` 使用默认压缩级别，flush/sync 后 rename 为 `.log.gz`，成功后删除 `.log`。返回新 `LogMetadata`。

- [ ] **Step 4: 实现分批维护**

`history_maintenance.rs` 提供：

```rust
pub const COMPRESS_AFTER_DAYS: i64 = 7;
pub const DELETE_AFTER_DAYS: i64 = 90;
pub const DEFAULT_BATCH_SIZE: usize = 100;

pub struct MaintenanceReport {
    pub processed: usize,
    pub compressed: usize,
    pub expired: usize,
    pub orphaned: usize,
}

pub fn run_batch_at(
    store: &HistoryStore,
    log_dir: &Path,
    active_logs: &HashSet<PathBuf>,
    now: DateTime<Utc>,
    limit: usize,
) -> Result<MaintenanceReport, String>;
```

处理顺序：数据库引用日志的 90 天删除 → 7 天压缩 → 日志目录中的未引用孤儿删除。每处理一个文件计入 `limit`；活动日志始终跳过。压缩/删除后用 `update_log_metadata` 或 `clear_log_reference` 更新 SQLite。单文件失败记录 `log::warn!` 并继续下一文件。

- [ ] **Step 5: 注册模块并运行测试**

在 `lib.rs` 增加 `pub mod history_maintenance;`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml task_log::tests history_maintenance::tests -- --nocapture`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/task_log.rs src-tauri/src/history_maintenance.rs src-tauri/src/lib.rs
git commit -m "feat: compress and expire historical task logs"
```

### Task 6: 将历史命令改为异步分页 SQLite API

**Files:**
- Modify: `src-tauri/src/commands.rs:406-555,1364-1647,2328-2417` 及其他 `HistoryManager::new()` 调用点
- Modify: `src-tauri/src/lib.rs:89-120`

- [ ] **Step 1: 增加可测试的 blocking helper**

在 `commands.rs` 历史命令附近增加：

```rust
async fn history_blocking<T, F>(op: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&'static HistoryStore) -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let store = HistoryStore::global()?;
        op(store)
    })
    .await
    .map_err(|e| format!("历史后台任务失败: {e}"))?
}
```

先运行 `cargo check`，Expected: FAIL，旧命令仍使用已删除的 `HistoryManager`。

- [ ] **Step 2: 改造分页、删除和清空命令**

```rust
#[tauri::command]
pub async fn get_download_history(page: Option<u32>, page_size: Option<u32>) -> Result<HistoryPage, String> {
    history_blocking(move |store| store.page(page.unwrap_or(1), page_size.unwrap_or(50))).await
}

#[tauri::command]
pub async fn delete_download_record(id: String) -> Result<(), String> {
    let log_path = history_blocking(move |store| store.delete(&id)).await?;
    if let Some(path) = log_path {
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn clear_download_history(
    task_manager: State<'_, Arc<TaskManager>>,
) -> Result<(), String> {
    let active = task_manager.active_log_paths();
    let paths = history_blocking(|store| store.clear()).await?;
    for path in paths {
        if !active.contains(&path) {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
    Ok(())
}
```

`add_download_record` 和金字塔状态更新同样改用 `history_blocking`，金字塔更新必须只更新目标记录，不再 `get_all` + `save_all`。

- [ ] **Step 3: 改造任务完成/失败历史写入**

新增：

```rust
async fn persist_history_record(record: DownloadRecord) -> Result<(), String> {
    history_blocking(move |store| store.add(&record)).await
}
```

所有 7 处 `HistoryManager::new().add(record)` 替换为 `persist_history_record(record).await`。构造 record 时从 `TaskManager::get_log_metadata` 写入日志路径、大小和截断字段。写历史失败只 `log::error!`，不得改变下载终态；仅成功后 emit `download-history-updated`。

- [ ] **Step 4: 改造日志读取错误语义**

`read_log_file` 返回 `Result<Vec<TaskLog>, String>`，先校验目标位于日志目录，再调用 `task_log::read_log_file`。普通 `.log` 和 `.gz` 都允许；不存在返回“日志已清理或不存在”。

- [ ] **Step 5: 编译并运行后端测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml history::tests task_log::tests history_maintenance::tests -- --nocapture`

Expected: PASS。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS，无 `HistoryManager` 引用。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "refactor: use async paged history operations"
```

### Task 7: 启动低优先级日志维护线程

**Files:**
- Modify: `src-tauri/src/task.rs`
- Modify: `src-tauri/src/lib.rs:161-214`
- Modify: `src-tauri/src/history_maintenance.rs`

- [ ] **Step 1: 为活动日志路径快照写测试**

在 `task.rs` 测试中创建两个任务并断言：

```rust
#[test]
fn active_log_paths_only_contains_live_task_logs() {
    let tmp = tempfile::TempDir::new().unwrap();
    let manager = TaskManager::new_with_log_dir(tmp.path().to_path_buf());
    manager.create_task(/* 固定 id 和最小参数 */);
    let paths = manager.active_log_paths();
    assert_eq!(paths.len(), 1);
    assert!(paths.iter().next().unwrap().starts_with(tmp.path()));
}
```

- [ ] **Step 2: 实现 `new_with_log_dir` 和 `active_log_paths`**

`new()` 调用内部 `new_with_log_dir(default_dir)`；`active_log_paths()` 只在任务表锁内克隆 writer 路径，不执行文件 IO。

- [ ] **Step 3: 在 setup 中启动维护循环**

从 Tauri state 克隆 `Arc<TaskManager>`，后台线程每次启动先等待 30 秒，之后每 30 分钟处理最多 100 个文件：

```rust
let task_manager = app.state::<Arc<TaskManager>>().inner().clone();
std::thread::spawn(move || {
    std::thread::sleep(std::time::Duration::from_secs(30));
    loop {
        match HistoryStore::global() {
            Ok(store) => {
                let active = task_manager.active_log_paths();
                let log_dir = task_manager.log_dir_path();
                if let Err(e) = history_maintenance::run_batch(
                    store,
                    &log_dir,
                    &active,
                    history_maintenance::DEFAULT_BATCH_SIZE,
                ) {
                    log::warn!("日志维护失败: {e}");
                }
            }
            Err(e) => log::warn!("历史数据库不可用，跳过日志维护: {e}"),
        }
        std::thread::sleep(std::time::Duration::from_secs(30 * 60));
    }
});
```

该线程不得 emit 历史刷新事件，也不得阻塞 setup。

- [ ] **Step 4: 运行测试和检查**

Run: `cargo test --manifest-path src-tauri/Cargo.toml task::tests::active_log_paths -- --nocapture`

Expected: PASS。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/task.rs src-tauri/src/lib.rs src-tauri/src/history_maintenance.rs
git commit -m "feat: maintain historical logs in background"
```

### Task 8: 前端接入分页历史 API

**Files:**
- Modify: `frontend/src/types/api.ts:239-253`
- Modify: `frontend/src/features/history/history-api.ts:1-43`
- Modify: `frontend/src/features/history/history-panel.tsx:362-504`

- [ ] **Step 1: 增加分页响应类型**

```typescript
export interface DownloadHistoryRecord {
  // 保留现有字段
  log_compressed?: boolean
  log_original_size?: number
  log_stored_size?: number
  log_truncated?: boolean
  log_updated_at?: string | null
}

export interface DownloadHistoryPage {
  records: DownloadHistoryRecord[]
  total: number
  page: number
  page_size: number
}
```

- [ ] **Step 2: 修改 API 参数**

```typescript
export function getDownloadHistory(page = 1, pageSize = 50) {
  return invokeCommand<DownloadHistoryPage>('get_download_history', {
    page,
    pageSize,
  })
}
```

删除/清空/金字塔 API 名称保持不变。

- [ ] **Step 3: 修改 query 和刷新事件**

在 `HistoryPanel` 增加 `page` state 和固定 `PAGE_SIZE = 50`：

```tsx
const PAGE_SIZE = 50
const [page, setPage] = useState(1)
const historyQuery = useQuery({
  queryKey: ['download-history', page],
  queryFn: () => getDownloadHistory(page, PAGE_SIZE),
  enabled: inTauri,
})
const data = historyQuery.data
const records = data?.records ?? []
const total = data?.total ?? 0
const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
```

事件 effect 只注册：

```tsx
listen('download-history-updated', () => {
  qc.invalidateQueries({ queryKey: ['download-history'] })
})
```

完全移除 `task-list-updated` 对历史的 invalidation。

- [ ] **Step 4: 增加分页 UI 和删除边界处理**

顶部仍显示总记录数。列表底部增加：

```tsx
<div className="flex items-center justify-between border-t pt-2 text-xs">
  <span className="text-muted-foreground">
    第 {page} / {totalPages} 页
  </span>
  <div className="flex gap-1">
    <Button size="sm" variant="outline" disabled={page <= 1 || historyQuery.isFetching}
      onClick={() => setPage((p) => Math.max(1, p - 1))}>
      上一页
    </Button>
    <Button size="sm" variant="outline" disabled={page >= totalPages || historyQuery.isFetching}
      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
      下一页
    </Button>
  </div>
</div>
```

增加 effect：当删除后 `page > totalPages` 时 `setPage(totalPages)`。清空成功时先 `setPage(1)` 再 invalidate。历史卡中 `log_truncated` 为 true 时显示 `日志已截断` outline badge。

- [ ] **Step 5: 构建前端**

Run: `npm --prefix frontend run build`

Expected: TypeScript 和 Vite build PASS。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/types/api.ts frontend/src/features/history/history-api.ts frontend/src/features/history/history-panel.tsx
git commit -m "feat: paginate download history UI"
```

### Task 9: 性能回归测试和迁移压力验证

**Files:**
- Modify: `src-tauri/src/history.rs`
- Modify: `src-tauri/src/history_maintenance.rs`

- [ ] **Step 1: 增加 4 万条迁移/分页测试**

测试生成 40,000 条精简 `DownloadRecord`，写入旧 JSON，迁移后只查询 50 条：

```rust
#[test]
fn migrates_40k_records_and_pages_without_loading_all_rows() {
    let tmp = TempDir::new().unwrap();
    let records: Vec<_> = (0..40_000)
        .map(|i| record(&format!("r{i}"), i))
        .collect();
    std::fs::write(
        tmp.path().join("history.json"),
        serde_json::to_vec(&records).unwrap(),
    ).unwrap();

    let store = HistoryStore::open_at(tmp.path()).unwrap();
    assert_eq!(store.migrate_legacy_json().unwrap(), 40_000);
    let page = store.page(1, 50).unwrap();
    assert_eq!(page.total, 40_000);
    assert_eq!(page.records.len(), 50);
    assert_eq!(page.records[0].id, "r39999");
}
```

- [ ] **Step 2: 运行压力测试**

Run: `cargo test --release --manifest-path src-tauri/Cargo.toml history::tests::migrates_40k -- --nocapture`

Expected: PASS；查询结果只含 50 条。记录实际耗时用于最终汇报，但不要写死脆弱的时间断言。

- [ ] **Step 3: 运行完整后端验证**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: 全部 PASS。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS。

- [ ] **Step 4: 运行完整前端验证**

Run: `npm --prefix frontend run lint`

Expected: PASS。

Run: `npm --prefix frontend run build`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/history.rs src-tauri/src/history_maintenance.rs
git commit -m "test: cover large history migration and maintenance"
```

### Task 10: 在真实应用中验证迁移、分页和并行任务

**Files:**
- No code changes expected

- [ ] **Step 1: 准备可恢复测试数据**

备份 `%LOCALAPPDATA%/geo-downloader/history.json` 和 `logs/`，不要覆盖用户唯一副本。若本机没有大历史文件，使用测试生成器在临时用户数据目录创建 40,000 条历史和一组 8 天/91 天日志。

- [ ] **Step 2: 启动桌面应用**

Run: `npm run dev`

Expected: Tauri 应用启动，下载功能无需等待历史迁移即可操作。

- [ ] **Step 3: 验证迁移和分页**

打开历史面板：

- 首次访问完成 JSON → SQLite 迁移；
- `history.json.migrated` 存在；
- 页面仅显示 50 张卡；
- 总数正确；
- 上一页/下一页可用；
- 删除当前页最后一条后页码保持有效。

- [ ] **Step 4: 验证日志策略**

- 普通 `.log` 可查看；
- `.log.gz` 可透明查看；
- 缺失/90 天过期日志显示“日志已清理或不存在”；
- 超过 5 MiB 的任务日志出现一次截断提示；
- 清空历史不会删除当前活动任务日志。

- [ ] **Step 5: 验证并行任务不再受历史面板影响**

创建至少 4 个小型批量任务并保持历史面板打开。确认：

- 多个任务同时推进；
- 每个完成任务只新增一条历史；
- UI 不因历史刷新冻结；
- 新任务创建和状态更新不等待日志磁盘写入。

- [ ] **Step 6: 检查工作区**

Run: `git status --short`

Expected: 只有预期改动；不包含测试生成的数据库、日志或用户数据。

---

## 计划自检

- 覆盖 SQLite schema、JSON 全量幂等迁移、分页、单条 CRUD 和并发写入。
- 覆盖日志 IO 脱离任务全局锁、5 MiB 截断、gzip 透明读取、7/90 天策略和孤儿清理。
- 覆盖删除/清空历史联动日志，并保护活动任务日志。
- 覆盖后台分批维护、错误不影响下载终态和前端仅监听专用历史事件。
- 覆盖 4 万条压力测试及真实 Tauri 应用手动验证。
