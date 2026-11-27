//! 单个 mbtiles 文件的读写封装。
//!
//! 仅在 `pool.rs` 中通过 Mutex 同步访问，store 层无需自己加锁。

use std::collections::HashSet;
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags};

use super::{xyz_to_tms_row, SourceInfo, SourceStats, StoredTile, TileCoord};

pub struct TileStore {
    conn: Connection,
    source_key: String,
    tried_bulk_journal: bool,
}

impl TileStore {
    /// 打开（必要时创建）一个 mbtiles 文件。
    pub fn open(path: &Path, source_key: &str) -> Result<Self, String> {
        Self::open_for_workload(path, source_key, false)
    }

    pub(super) fn open_for_workload(path: &Path, source_key: &str, bulk_download: bool) -> Result<Self, String> {
        // For a freshly created bulk database the rollback journal only needs
        // pre-existing pages. Newly appended tile payloads can go straight to
        // the DB instead of being written to WAL and checkpointed again.
        let fresh_bulk = bulk_download && !path.exists();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建缓存目录失败 {}: {}", parent.display(), e))?;
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("打开 mbtiles 失败 {}: {}", path.display(), e))?;

        // 性能调优
        if fresh_bulk {
            conn.pragma_update(None, "synchronous", "FULL").map_err(|e| e.to_string())?;
        } else {
            conn.pragma_update(None, "journal_mode", "WAL").ok();
            conn.pragma_update(None, "synchronous", "NORMAL").ok();
        }
        conn.pragma_update(None, "temp_store", "MEMORY").ok();
        conn.pragma_update(None, "cache_size", -8000i64).ok();
        conn.pragma_update(None, "mmap_size", 268_435_456i64).ok();

        // schema
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE IF NOT EXISTS tiles (
                 zoom_level  INTEGER NOT NULL,
                 tile_column INTEGER NOT NULL,
                 tile_row    INTEGER NOT NULL,
                 tile_data   BLOB NOT NULL,
                 PRIMARY KEY (zoom_level, tile_column, tile_row)
             );",
        )
        .map_err(|e| format!("初始化 mbtiles schema 失败: {}", e))?;

        Ok(Self {
            conn,
            source_key: source_key.to_string(),
            tried_bulk_journal: fresh_bulk,
        })
    }

    // A preview, preflight or another process may already have this database
    // open. A journal-mode change is optional and must never wait for an
    // external reader. Restore the connection's ordinary write timeout.
    fn try_journal_mode(&self, pragma: &str) -> Option<String> {
        let timeout_ms = self.conn.pragma_query_value(None, "busy_timeout", |r| r.get::<_, u32>(0)).ok()?;
        self.conn.busy_timeout(std::time::Duration::ZERO).ok()?;
        let mode = self.conn.query_row(pragma, [], |r| r.get(0)).ok();
        let _ = self.conn.busy_timeout(std::time::Duration::from_millis(timeout_ms.into()));
        mode
    }

    pub(super) fn prepare_bulk_journal(&mut self) {
        if self.tried_bulk_journal { return; }
        self.tried_bulk_journal = true;
        if self.conn.pragma_update(None, "synchronous", "FULL").is_ok()
            && self.try_journal_mode("PRAGMA journal_mode=DELETE").as_deref() != Some("delete")
        {
            let _ = self.conn.pragma_update(None, "synchronous", "NORMAL");
        }
    }

    pub(super) fn resume_browse_journal(&mut self) {
        if !self.tried_bulk_journal { return; }
        self.tried_bulk_journal = false;
        if self.try_journal_mode("PRAGMA journal_mode=WAL").as_deref() == Some("wal") {
            let _ = self.conn.pragma_update(None, "synchronous", "NORMAL");
        }
    }

    /// 写入或更新基础元数据。仅在缺失时填入，不覆盖用户已有值（除了 last_used_at）。
    pub fn ensure_metadata(&mut self, info: &SourceInfo) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339();
        let pairs: Vec<(&str, String)> = vec![
            ("name", if info.display_name.is_empty() { self.source_key.clone() } else { info.display_name.clone() }),
            ("format", if info.format.is_empty() { "png".into() } else { info.format.clone() }),
            ("type", "baselayer".into()),
            ("version", "1".into()),
            ("description", "Cached by GeoDownloader".into()),
            ("gd_source_key", self.source_key.clone()),
            ("gd_url_template", info.url_template.clone()),
            ("gd_capture_at", info.capture_at.clone().unwrap_or_default()),
            ("gd_created_at", now.clone()),
        ];
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for (k, v) in &pairs {
            tx.execute(
                "INSERT OR IGNORE INTO metadata (name, value) VALUES (?1, ?2)",
                params![k, v],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(b) = info.bounds {
            tx.execute(
                "INSERT OR IGNORE INTO metadata (name, value) VALUES ('bounds', ?1)",
                params![format!("{},{},{},{}", b[0], b[1], b[2], b[3])],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(z) = info.min_zoom {
            tx.execute(
                "INSERT OR IGNORE INTO metadata (name, value) VALUES ('minzoom', ?1)",
                params![z.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(z) = info.max_zoom {
            tx.execute(
                "INSERT OR IGNORE INTO metadata (name, value) VALUES ('maxzoom', ?1)",
                params![z.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(a) = &info.attribution {
            tx.execute(
                "INSERT OR IGNORE INTO metadata (name, value) VALUES ('attribution', ?1)",
                params![a],
            )
            .map_err(|e| e.to_string())?;
        }
        // last_used_at 总是覆盖
        tx.execute(
            "INSERT INTO metadata (name, value) VALUES ('gd_last_used_at', ?1)
             ON CONFLICT(name) DO UPDATE SET value=excluded.value",
            params![now],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 查询单个瓦片。
    pub fn get(&self, c: TileCoord) -> Result<Option<StoredTile>, String> {
        let tms_y = xyz_to_tms_row(c.z, c.y);
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT tile_data FROM tiles WHERE zoom_level=?1 AND tile_column=?2 AND tile_row=?3",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(params![c.z as i64, c.x as i64, tms_y as i64])
            .map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let bytes: Vec<u8> = row.get(0).map_err(|e| e.to_string())?;
            let content_type = self.cached_format_to_mime();
            return Ok(Some(StoredTile { bytes, content_type }));
        }
        Ok(None)
    }

    /// 单瓦片写入（失败不抛异常给调用方流程，仅返回 Err 让上层 log）。
    pub fn put(&mut self, c: TileCoord, tile: &StoredTile) -> Result<(), String> {
        let tms_y = xyz_to_tms_row(c.z, c.y);
        self.conn
            .execute(
                "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?1,?2,?3,?4)",
                params![c.z as i64, c.x as i64, tms_y as i64, tile.bytes],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 批量写入（事务）。
    pub fn put_batch(&mut self, batch: &[(TileCoord, StoredTile)]) -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?1,?2,?3,?4)
                     ON CONFLICT(zoom_level,tile_column,tile_row) DO UPDATE SET tile_data=excluded.tile_data
                     WHERE tiles.tile_data <> excluded.tile_data",
                )
                .map_err(|e| e.to_string())?;
            for (c, tile) in batch {
                let tms_y = xyz_to_tms_row(c.z, c.y);
                stmt.execute(params![c.z as i64, c.x as i64, tms_y as i64, tile.bytes])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 批量判断哪些坐标已在缓存中。
    ///
    /// 分批 (300/批) 走 `WHERE (zoom_level, tile_column, tile_row) IN (VALUES ...)`
    /// 单条 SQL，避免每张瓦片一次 prepare + query；命中检查走主键索引，
    /// 整体复杂度 O(N log N)。批大小取 300 是为了把单语句占位符控制在
    /// 300 × 3 = 900 个之内，留出余量给传统 SQLite 999 参数上限。
    ///
    /// 注意：传入的 `coords` 是 XYZ 坐标（左上角原点），内部自动转 TMS；
    /// 返回的 `HashSet` 元素亦为原始 XYZ 坐标。
    pub fn contains_batch(&self, coords: &[TileCoord]) -> Result<HashSet<TileCoord>, String> {
        use std::collections::HashMap;
        if coords.is_empty() {
            return Ok(HashSet::new());
        }
        // (z, x, tms_y) -> 原始 XYZ TileCoord 的反查映射
        let mut idx: HashMap<(u8, u32, u32), TileCoord> = HashMap::with_capacity(coords.len());
        for &c in coords {
            let tms_y = xyz_to_tms_row(c.z, c.y);
            idx.insert((c.z, c.x, tms_y), c);
        }

        const BATCH_SIZE: usize = 300;
        let mut found: HashSet<TileCoord> = HashSet::with_capacity(coords.len() / 2 + 1);

        for chunk in coords.chunks(BATCH_SIZE) {
            // 构造 SQL：WHERE (z,x,y) IN (VALUES (?,?,?), (?,?,?), ...)
            let mut sql = String::with_capacity(96 + chunk.len() * 8);
            sql.push_str(
                "SELECT zoom_level, tile_column, tile_row FROM tiles \
                 WHERE (zoom_level, tile_column, tile_row) IN (VALUES ",
            );
            for i in 0..chunk.len() {
                if i > 0 {
                    sql.push(',');
                }
                sql.push_str("(?,?,?)");
            }
            sql.push(')');

            let mut p: Vec<i64> = Vec::with_capacity(chunk.len() * 3);
            for c in chunk {
                let tms_y = xyz_to_tms_row(c.z, c.y);
                p.push(c.z as i64);
                p.push(c.x as i64);
                p.push(tms_y as i64);
            }

            let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
            let mut rows = stmt
                .query(rusqlite::params_from_iter(&p))
                .map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let z: i64 = row.get(0).map_err(|e| e.to_string())?;
                let x: i64 = row.get(1).map_err(|e| e.to_string())?;
                let tms_y: i64 = row.get(2).map_err(|e| e.to_string())?;
                if let Some(&orig) = idx.get(&(z as u8, x as u32, tms_y as u32)) {
                    found.insert(orig);
                }
            }
        }
        Ok(found)
    }

    /// 更新 last_used_at（不要在每次 get 都调用，性能敏感）。
    pub fn touch(&mut self) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn
            .execute(
                "INSERT INTO metadata (name, value) VALUES ('gd_last_used_at', ?1)
                 ON CONFLICT(name) DO UPDATE SET value=excluded.value",
                params![now],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 统计信息。
    pub fn stats(&self, file_size: u64) -> Result<SourceStats, String> {
        let tile_count: u64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM tiles", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let read_meta = |k: &str| -> Option<String> {
            self.conn
                .query_row(
                    "SELECT value FROM metadata WHERE name=?1",
                    params![k],
                    |r| r.get::<_, String>(0),
                )
                .ok()
        };
        let display_name = read_meta("name").unwrap_or_else(|| self.source_key.clone());
        let format = read_meta("format").unwrap_or_else(|| "png".to_string());
        let min_zoom = read_meta("minzoom").and_then(|s| s.parse::<u8>().ok());
        let max_zoom = read_meta("maxzoom").and_then(|s| s.parse::<u8>().ok());
        let created_at = read_meta("gd_created_at");
        let last_used_at = read_meta("gd_last_used_at");
        Ok(SourceStats {
            source: self.source_key.clone(),
            display_name,
            format,
            tile_count,
            size_bytes: file_size,
            min_zoom,
            max_zoom,
            created_at,
            last_used_at,
        })
    }

    /// 优雅关闭：先 checkpoint(TRUNCATE) 把 WAL 数据合并回主库并截断 WAL，
    /// 再切回 DELETE journal 模式，使后续 close 时 SQLite 自动删除 -wal/-shm 副文件。
    /// 任一步骤失败都不阻塞流程（只 log），因为关闭时不能传播错误。
    pub fn checkpoint_and_close(self) {
        let conn = self.conn;
        // 1) 强制 checkpoint，把 WAL 中已提交的页全部写回主库并截断 WAL
        if let Err(e) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())) {
            log::warn!("[tile_cache] wal_checkpoint(TRUNCATE) 失败 ({}): {}", self.source_key, e);
        }
        // 2) 切回 DELETE 模式，下次 open 时 SQLite 会清理掉残留 -wal/-shm
        if let Err(e) = conn.pragma_update(None, "journal_mode", "DELETE") {
            log::warn!("[tile_cache] 切回 journal_mode=DELETE 失败 ({}): {}", self.source_key, e);
        }
        // 3) 显式 close（drop 也会 close，但 close() 能拿到错误）
        if let Err((_, e)) = conn.close() {
            log::warn!("[tile_cache] close 连接失败 ({}): {}", self.source_key, e);
        }
    }

    fn cached_format_to_mime(&self) -> String {
        let fmt = self
            .conn
            .query_row(
                "SELECT value FROM metadata WHERE name='format'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "png".to_string());
        match fmt.as_str() {
            "jpg" | "jpeg" => "image/jpeg".into(),
            "webp" => "image/webp".into(),
            "pbf" => "application/x-protobuf".into(),
            _ => "image/png".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn open_and_read_write() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.mbtiles");
        let mut store = TileStore::open(&path, "test").unwrap();
        let info = SourceInfo {
            display_name: "Test".into(),
            url_template: "https://x/{z}/{x}/{y}.png".into(),
            format: "png".into(),
            ..Default::default()
        };
        store.ensure_metadata(&info).unwrap();

        let coord = TileCoord { z: 5, x: 10, y: 12 };
        assert!(store.get(coord).unwrap().is_none());
        let tile = StoredTile {
            bytes: vec![1, 2, 3, 4, 5],
            content_type: "image/png".into(),
        };
        store.put(coord, &tile).unwrap();
        let got = store.get(coord).unwrap().unwrap();
        assert_eq!(got.bytes, tile.bytes);
        assert_eq!(got.content_type, "image/png");

        // 行号转换：相邻 y 应能正确区分
        let coord2 = TileCoord { z: 5, x: 10, y: 13 };
        assert!(store.get(coord2).unwrap().is_none());
    }

    #[test]
    fn batch_write() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("batch.mbtiles");
        let mut store = TileStore::open(&path, "batch").unwrap();
        store.ensure_metadata(&SourceInfo::default()).unwrap();
        let batch: Vec<_> = (0..10)
            .map(|i| {
                (
                    TileCoord { z: 3, x: i, y: i },
                    StoredTile {
                        bytes: vec![i as u8; 4],
                        content_type: "image/png".into(),
                    },
                )
            })
            .collect();
        store.put_batch(&batch).unwrap();
        for (c, t) in &batch {
            let got = store.get(*c).unwrap().unwrap();
            assert_eq!(got.bytes, t.bytes);
        }
        let stats = store.stats(0).unwrap();
        assert_eq!(stats.tile_count, 10);
    }

    #[test]
    fn batch_writes_skip_identical_payloads_and_replace_changed_tiles() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("download.mbtiles");
        let mut store = TileStore::open_for_workload(&path, "download", true).unwrap();
        let mode: String = store.conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
        assert_eq!(mode, "delete");
        let coord = TileCoord { z: 1, x: 0, y: 0 };
        let mut batch = [(coord, StoredTile { bytes: vec![1; 4096], content_type: "image/png".into() })];
        store.put_batch(&batch).unwrap();
        let changes = store.conn.total_changes();
        store.put_batch(&batch).unwrap();
        assert_eq!(store.conn.total_changes(), changes);
        batch[0].1.bytes[0] = 9;
        store.put_batch(&batch).unwrap();
        drop(store);
        let store = TileStore::open(&path, "download").unwrap();
        assert_eq!(store.get(coord).unwrap().unwrap().bytes, batch[0].1.bytes);
    }

    #[test]
    fn bulk_journal_reuses_preview_database_and_respects_external_readers() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("preview.mbtiles");
        let mut store = TileStore::open(&path, "preview").unwrap();
        let mode = |s: &TileStore| s.conn.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0)).unwrap();
        store.prepare_bulk_journal();
        assert_eq!(mode(&store), "delete");
        store.resume_browse_journal();
        assert_eq!(mode(&store), "wal");
        let reader = Connection::open(&path).unwrap();
        reader.execute_batch("BEGIN; SELECT count(*) FROM tiles;").unwrap();
        store.prepare_bulk_journal();
        assert_eq!(mode(&store), "wal");
        let coord = TileCoord { z: 1, x: 1, y: 1 };
        store.put_batch(&[(coord, StoredTile { bytes: vec![7], content_type: "image/png".into() })]).unwrap();
        assert_eq!(store.get(coord).unwrap().unwrap().bytes, [7]);
    }

    /// 空入参直接返回空集，不应触碰 DB。
    #[test]
    fn contains_batch_empty_input() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("empty.mbtiles");
        let store = TileStore::open(&path, "empty").unwrap();
        let got = store.contains_batch(&[]).unwrap();
        assert!(got.is_empty());
    }

    /// 全命中：所有传入坐标都已 put 过。
    #[test]
    fn contains_batch_all_hit() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("all_hit.mbtiles");
        let mut store = TileStore::open(&path, "all_hit").unwrap();
        store.ensure_metadata(&SourceInfo::default()).unwrap();
        let coords: Vec<TileCoord> = (0..20)
            .map(|i| TileCoord { z: 6, x: i, y: i * 2 })
            .collect();
        let batch: Vec<_> = coords
            .iter()
            .map(|c| {
                (
                    *c,
                    StoredTile {
                        bytes: vec![c.x as u8; 3],
                        content_type: "image/png".into(),
                    },
                )
            })
            .collect();
        store.put_batch(&batch).unwrap();
        let got = store.contains_batch(&coords).unwrap();
        assert_eq!(got.len(), coords.len());
        for c in &coords {
            assert!(got.contains(c), "missing coord {:?}", c);
        }
    }

    /// 部分命中：只 put 一半坐标，contains_batch 应只返回这一半。
    #[test]
    fn contains_batch_partial_hit() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("partial.mbtiles");
        let mut store = TileStore::open(&path, "partial").unwrap();
        store.ensure_metadata(&SourceInfo::default()).unwrap();
        let all: Vec<TileCoord> = (0..30)
            .map(|i| TileCoord { z: 7, x: i, y: 100 + i })
            .collect();
        // 偶数下标的 put 进去
        let hit_subset: Vec<TileCoord> = all.iter().copied().step_by(2).collect();
        let batch: Vec<_> = hit_subset
            .iter()
            .map(|c| (*c, StoredTile { bytes: vec![1], content_type: "image/png".into() }))
            .collect();
        store.put_batch(&batch).unwrap();

        let got = store.contains_batch(&all).unwrap();
        assert_eq!(got.len(), hit_subset.len());
        for c in &hit_subset {
            assert!(got.contains(c), "expected hit {:?}", c);
        }
        // 奇数下标都不应命中
        for (i, c) in all.iter().enumerate() {
            if i % 2 == 1 {
                assert!(!got.contains(c), "unexpected hit {:?}", c);
            }
        }
    }

    /// 跨批切分：>300 个坐标（BATCH_SIZE）走多轮 SQL，应该都正确命中。
    /// 同时覆盖 XYZ → TMS 行号转换在 chunks 跨越时不会错位。
    #[test]
    fn contains_batch_crosses_batch_boundary() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cross.mbtiles");
        let mut store = TileStore::open(&path, "cross").unwrap();
        store.ensure_metadata(&SourceInfo::default()).unwrap();
        // 750 个坐标，跨 3 个 batch（300 + 300 + 150）
        let coords: Vec<TileCoord> = (0..750u32)
            .map(|i| TileCoord { z: 8, x: i, y: i + 1 })
            .collect();
        let batch: Vec<_> = coords
            .iter()
            .map(|c| (*c, StoredTile { bytes: vec![0], content_type: "image/png".into() }))
            .collect();
        store.put_batch(&batch).unwrap();

        let got = store.contains_batch(&coords).unwrap();
        assert_eq!(got.len(), coords.len(), "all {} coords should hit", coords.len());

        // 故意混入一些不存在的坐标，验证不会误报
        let mut mixed: Vec<TileCoord> = coords.clone();
        mixed.push(TileCoord { z: 8, x: 99999, y: 99999 });
        mixed.push(TileCoord { z: 9, x: 0, y: 0 });
        let got2 = store.contains_batch(&mixed).unwrap();
        assert_eq!(got2.len(), coords.len(), "miss must not be reported");
    }
}
