//! 多 source 连接池：每个 SourceKey 一个常驻 mbtiles 连接，LRU 上限 8。
//!
//! 也实现了对外的 `Store` 入口，对调用方屏蔽连接复用与磁盘容量管理。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::{
    active_downloads, get_config, store::TileStore, PruneReport, SourceInfo, SourceKey,
    SourceStats, StoredTile, TileCoord,
};

const POOL_MAX: usize = 8;
const AUTO_PRUNE_WRITE_THRESHOLD: u64 = 64 * 1024 * 1024;
const AUTO_PRUNE_CHECK_INTERVAL: Duration = Duration::from_secs(30);
const AUTO_PRUNE_TARGET_PERCENT: u64 = 90;

struct PoolEntry {
    store: Arc<Mutex<TileStore>>,
    last_used: Instant,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, PoolEntry>,
}

impl Inner {
    fn evict_if_needed(&mut self) -> Vec<PoolEntry> {
        let mut evicted = Vec::new();
        while self.entries.len() > POOL_MAX {
            // 找出最久未用的踢掉
            if let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| k.clone())
            {
                if let Some(e) = self.entries.remove(&oldest_key) {
                    evicted.push(e);
                }
            } else {
                break;
            }
        }
        evicted
    }
}

pub struct Store {
    inner: Mutex<Inner>,
    prune_gate: Mutex<()>,
    auto_prune: Mutex<AutoPruneState>,
}

struct AutoPruneState {
    bytes_since_check: u64,
    last_check: Instant,
}

impl Default for AutoPruneState {
    fn default() -> Self {
        Self {
            bytes_since_check: 0,
            last_check: Instant::now(),
        }
    }
}

static GLOBAL_STORE: OnceLock<Store> = OnceLock::new();

impl Store {
    pub fn global() -> &'static Store {
        GLOBAL_STORE.get_or_init(Self::new)
    }

    fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            prune_gate: Mutex::new(()),
            auto_prune: Mutex::new(AutoPruneState::default()),
        }
    }

    fn path_for(src: &SourceKey) -> PathBuf {
        let cfg = get_config();
        cfg.root_dir.join(format!("{}.mbtiles", src.as_str()))
    }

    /// 获取/创建 source 对应的 store handle。
    fn handle(&self, src: &SourceKey) -> Result<Arc<Mutex<TileStore>>, String> {
        let mut inner = self.inner.lock().map_err(|_| "pool poisoned".to_string())?;
        if let Some(entry) = inner.entries.get_mut(src.as_str()) {
            entry.last_used = Instant::now();
            return Ok(entry.store.clone());
        }
        let path = Self::path_for(src);
        let store = TileStore::open(&path, src.as_str())?;
        let arc = Arc::new(Mutex::new(store));
        inner.entries.insert(
            src.as_str().to_string(),
            PoolEntry {
                store: arc.clone(),
                last_used: Instant::now(),
            },
        );
        let evicted = inner.evict_if_needed();
        // 释放 inner 锁后再 checkpoint，避免阻塞其它 source 的请求
        drop(inner);
        for e in evicted {
            Self::checkpoint_entry(e);
        }
        Ok(arc)
    }

    /// 关闭 source 对应的连接（用于删除文件前）。
    fn close(&self, src: &SourceKey) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(entry) = inner.entries.remove(src.as_str()) {
                Self::checkpoint_entry(entry);
            }
        }
    }

    /// 取出 PoolEntry 并执行 checkpoint + close（在 Mutex 外执行，避免长时间持锁）。
    fn checkpoint_entry(entry: PoolEntry) {
        // Arc<Mutex<TileStore>>：必须是唯一持有者才能 try_unwrap 取出 TileStore
        match Arc::try_unwrap(entry.store) {
            Ok(mutex) => match mutex.into_inner() {
                Ok(store) => store.checkpoint_and_close(),
                Err(_) => log::warn!("[tile_cache] store mutex poisoned, 跳过 checkpoint"),
            },
            Err(_arc) => {
                // 还有其它持有者（理论上不该发生：调用 shutdown/close 前应保证无并发使用）
                log::warn!("[tile_cache] 连接仍被借用，无法 checkpoint，连接将随后续 drop 关闭");
            }
        }
    }

    /// 关闭并清空整个连接池：对每个 entry 执行 checkpoint(TRUNCATE) + journal_mode=DELETE + close。
    /// 用于：进程退出、缓存目录切换。安全可重复调用。
    pub fn shutdown(&self) {
        let drained: Vec<PoolEntry> = match self.inner.lock() {
            Ok(mut inner) => inner.entries.drain().map(|(_, v)| v).collect(),
            Err(_) => {
                log::warn!("[tile_cache] pool poisoned, 跳过 shutdown");
                return;
            }
        };
        let n = drained.len();
        for entry in drained {
            Self::checkpoint_entry(entry);
        }
        if n > 0 {
            log::info!(
                "[tile_cache] shutdown: checkpoint 并关闭了 {} 个 mbtiles 连接",
                n
            );
        }
    }

    pub fn get(&self, src: &SourceKey, coord: TileCoord) -> Result<Option<StoredTile>, String> {
        let Some(_access) = crate::cache_migration::begin_cache_access() else {
            return Ok(None);
        };
        if !get_config().enabled {
            return Ok(None);
        }
        let path = Self::path_for(src);
        if !path.exists() {
            return Ok(None);
        }
        let handle = self.handle(src)?;
        let store = handle.lock().map_err(|_| "store poisoned".to_string())?;
        store.get(coord)
    }

    pub fn put(
        &self,
        src: &SourceKey,
        coord: TileCoord,
        tile: StoredTile,
        info: Option<SourceInfo>,
    ) -> Result<(), String> {
        let written_bytes = tile.bytes.len() as u64;
        {
            let Some(_access) = crate::cache_migration::begin_cache_access() else {
                return Ok(());
            };
            if !get_config().enabled {
                return Ok(());
            }
            let handle = self.handle(src)?;
            let mut store = handle.lock().map_err(|_| "store poisoned".to_string())?;
            if let Some(info) = info {
                store.ensure_metadata(&info)?;
            } else {
                store.touch().ok();
            }
            store.put(coord, &tile)?;
            active_downloads::notify_cached(src.as_str(), coord);
        }
        self.maybe_auto_prune(written_bytes, false);
        Ok(())
    }

    pub fn put_batch(
        &self,
        src: &SourceKey,
        batch: Vec<(TileCoord, StoredTile)>,
        info: Option<SourceInfo>,
    ) -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        let written_bytes = batch.iter().map(|(_, tile)| tile.bytes.len() as u64).sum();
        {
            let Some(_access) = crate::cache_migration::begin_cache_access() else {
                return Ok(());
            };
            if !get_config().enabled {
                return Ok(());
            }
            let handle = self.handle(src)?;
            let mut store = handle.lock().map_err(|_| "store poisoned".to_string())?;
            if let Some(info) = info {
                store.ensure_metadata(&info)?;
            }
            store.put_batch(&batch)?;
        }
        self.maybe_auto_prune(written_bytes, false);
        Ok(())
    }

    /// 批量判断哪些坐标已在缓存中。
    ///
    /// 用于下载循环开始前的预过滤：把已命中的瓦片从待下载列表里剔除，
    /// 避免每张瓦片一次 `get` 单独走 SQL 占用并发槽位。
    ///
    /// 缓存禁用、文件不存在或入参为空时返回空集（不视为错误）。
    pub fn contains_batch(
        &self,
        src: &SourceKey,
        coords: &[TileCoord],
    ) -> Result<HashSet<TileCoord>, String> {
        let Some(_access) = crate::cache_migration::begin_cache_access() else {
            return Ok(HashSet::new());
        };
        if !get_config().enabled || coords.is_empty() {
            return Ok(HashSet::new());
        }
        let path = Self::path_for(src);
        if !path.exists() {
            return Ok(HashSet::new());
        }
        let handle = self.handle(src)?;
        let store = handle.lock().map_err(|_| "store poisoned".to_string())?;
        store.contains_batch(coords)
    }

    pub fn ensure_source(&self, src: &SourceKey, info: SourceInfo) -> Result<(), String> {
        let Some(_access) = crate::cache_migration::begin_cache_access() else {
            return Ok(());
        };
        let handle = self.handle(src)?;
        let mut store = handle.lock().map_err(|_| "store poisoned".to_string())?;
        store.ensure_metadata(&info)
    }

    /// 列出磁盘上所有 source 的统计信息（包括未在连接池中的）。
    pub fn stats(&self) -> Result<Vec<SourceStats>, String> {
        let _access = crate::cache_migration::begin_cache_access()
            .ok_or_else(|| "缓存正在迁移".to_string())?;
        self.stats_inner()
    }

    pub(crate) fn stats_during_migration(&self) -> Result<Vec<SourceStats>, String> {
        self.stats_inner()
    }

    fn stats_inner(&self) -> Result<Vec<SourceStats>, String> {
        let cfg = get_config();
        if !cfg.root_dir.exists() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&cfg.root_dir).map_err(|e| e.to_string())? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("mbtiles") {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let size = Self::source_disk_size(&path);
            let src = SourceKey::from_slug(stem);
            let handle = match self.handle(&src) {
                Ok(h) => h,
                Err(_) => continue,
            };
            let store = match handle.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            if let Ok(s) = store.stats(size) {
                out.push(s);
            }
        }
        Ok(out)
    }

    /// 清理：source=Some 删单库；None 全清。返回释放的字节数。
    pub fn clear(&self, src: Option<&SourceKey>) -> Result<u64, String> {
        let _prune = self
            .prune_gate
            .lock()
            .map_err(|_| "prune lock poisoned".to_string())?;
        let _access = crate::cache_migration::begin_cache_access()
            .ok_or_else(|| "缓存正在迁移".to_string())?;
        self.clear_inner(src)
    }

    fn clear_inner(&self, src: Option<&SourceKey>) -> Result<u64, String> {
        match src {
            Some(s) => {
                self.close(s);
                let path = Self::path_for(s);
                Self::remove_source_files(&path)
            }
            None => {
                // 关闭全部连接（先 checkpoint 再丢，避免删主文件后留下孤儿 -wal）
                self.shutdown();
                let cfg = get_config();
                let mut freed = 0u64;
                if let Ok(rd) = std::fs::read_dir(&cfg.root_dir) {
                    let sources: Vec<PathBuf> = rd
                        .flatten()
                        .map(|entry| entry.path())
                        .filter(|path| {
                            path.extension().and_then(|value| value.to_str()) == Some("mbtiles")
                        })
                        .collect();
                    for path in sources {
                        freed += Self::remove_source_files(&path)?;
                    }
                }
                freed += Self::remove_orphan_companions(&cfg.root_dir)?;
                Ok(freed)
            }
        }
    }

    /// LRU 整库淘汰：按 gd_last_used_at 升序删，直到总大小 <= max_total_bytes。
    pub fn prune(&self, max_total_bytes: u64) -> Result<PruneReport, String> {
        let _prune = self
            .prune_gate
            .lock()
            .map_err(|_| "prune lock poisoned".to_string())?;
        let _access = crate::cache_migration::begin_cache_access()
            .ok_or_else(|| "缓存正在迁移".to_string())?;
        self.prune_inner(max_total_bytes)
    }

    fn prune_inner(&self, max_total_bytes: u64) -> Result<PruneReport, String> {
        if max_total_bytes == 0 {
            return Ok(PruneReport {
                removed_sources: vec![],
                freed_bytes: 0,
            });
        }
        let config = get_config();
        let orphan_freed = Self::remove_orphan_companions(&config.root_dir)?;
        let mut stats = self.stats_inner()?;
        let total: u64 = stats.iter().map(|s| s.size_bytes).sum();
        if total <= max_total_bytes {
            return Ok(PruneReport {
                removed_sources: vec![],
                freed_bytes: orphan_freed,
            });
        }
        // 升序：last_used_at 缺失视为最早
        stats.sort_by(|a, b| {
            a.last_used_at
                .as_deref()
                .unwrap_or("")
                .cmp(b.last_used_at.as_deref().unwrap_or(""))
        });
        let mut removed = Vec::new();
        let mut freed = orphan_freed;
        let mut current = total;
        for s in stats {
            if current <= max_total_bytes {
                break;
            }
            if active_downloads::is_source_active(&s.source) || self.source_is_busy(&s.source) {
                continue;
            }
            let key = SourceKey::from_slug(s.source.clone());
            let f = match self.clear_inner(Some(&key)) {
                Ok(freed) => freed,
                Err(error) => {
                    log::warn!("[tile_cache] 自动清理 {} 失败: {}", s.source, error);
                    continue;
                }
            };
            current = current.saturating_sub(f);
            freed += f;
            if f > 0 {
                removed.push(s.source);
            }
        }
        Ok(PruneReport {
            removed_sources: removed,
            freed_bytes: freed,
        })
    }

    fn source_disk_size(path: &std::path::Path) -> u64 {
        [
            path.to_path_buf(),
            path.with_extension("mbtiles-wal"),
            path.with_extension("mbtiles-shm"),
        ]
        .iter()
        .map(|candidate| {
            candidate
                .metadata()
                .map(|metadata| metadata.len())
                .unwrap_or(0)
        })
        .sum()
    }

    fn remove_source_files(path: &std::path::Path) -> Result<u64, String> {
        let candidates = [
            path.to_path_buf(),
            path.with_extension("mbtiles-wal"),
            path.with_extension("mbtiles-shm"),
        ];
        let mut freed = 0;
        for candidate in candidates {
            if !candidate.exists() {
                continue;
            }
            let size = candidate
                .metadata()
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            std::fs::remove_file(&candidate)
                .map_err(|error| format!("删除缓存失败 {}: {}", candidate.display(), error))?;
            freed += size;
        }
        Ok(freed)
    }

    fn remove_orphan_companions(root: &std::path::Path) -> Result<u64, String> {
        if !root.exists() {
            return Ok(0);
        }
        let mut freed = 0;
        for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
            let path = match entry {
                Ok(entry) => entry.path(),
                Err(_) => continue,
            };
            let is_companion = matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("mbtiles-wal" | "mbtiles-shm")
            );
            if !is_companion || path.with_extension("mbtiles").exists() {
                continue;
            }
            let size = path.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            std::fs::remove_file(&path)
                .map_err(|error| format!("删除孤立缓存文件失败 {}: {}", path.display(), error))?;
            freed += size;
        }
        Ok(freed)
    }

    fn source_is_busy(&self, source: &str) -> bool {
        let Ok(inner) = self.inner.lock() else {
            return true;
        };
        let Some(entry) = inner.entries.get(source) else {
            return false;
        };
        if Arc::strong_count(&entry.store) > 1 {
            return true;
        }
        let busy = entry.store.try_lock().is_err();
        busy
    }

    fn maybe_auto_prune(&self, written_bytes: u64, force: bool) {
        let config = get_config();
        if !config.enabled || config.max_total_bytes == 0 {
            return;
        }
        let should_check = {
            let Ok(mut state) = self.auto_prune.lock() else {
                return;
            };
            state.bytes_since_check = state.bytes_since_check.saturating_add(written_bytes);
            let due = force
                || state.bytes_since_check >= AUTO_PRUNE_WRITE_THRESHOLD
                || state.last_check.elapsed() >= AUTO_PRUNE_CHECK_INTERVAL;
            if due {
                state.bytes_since_check = 0;
                state.last_check = Instant::now();
            }
            due
        };
        if !should_check {
            return;
        }
        let Ok(_prune) = self.prune_gate.try_lock() else {
            return;
        };
        let Some(_access) = crate::cache_migration::begin_cache_access() else {
            return;
        };
        let target = config
            .max_total_bytes
            .saturating_mul(AUTO_PRUNE_TARGET_PERCENT)
            / 100;
        match self.prune_inner(target) {
            Ok(report) if report.freed_bytes > 0 => log::info!(
                "[tile_cache] 自动清理 {} 个图源，释放 {} 字节",
                report.removed_sources.len(),
                report.freed_bytes
            ),
            Ok(_) => {}
            Err(error) => log::warn!("[tile_cache] 自动容量检查失败: {}", error),
        }
    }

    pub fn request_capacity_check(&self) {
        self.maybe_auto_prune(0, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tile_cache::{get_config, set_config, CacheConfig};
    use tempfile::tempdir;

    static CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct ConfigRestore(CacheConfig);

    impl Drop for ConfigRestore {
        fn drop(&mut self) {
            set_config(self.0.clone());
        }
    }

    #[test]
    fn end_to_end_get_put() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap();
        let dir = tempdir().unwrap();
        let _restore = ConfigRestore(get_config());
        set_config(CacheConfig {
            enabled: true,
            root_dir: dir.path().to_path_buf(),
            max_total_bytes: 10 * 1024 * 1024,
        });
        let store = Store::new();
        let src = SourceKey::new("World Imagery");
        let coord = TileCoord { z: 4, x: 3, y: 5 };
        assert!(store.get(&src, coord).unwrap().is_none());
        store
            .put(
                &src,
                coord,
                StoredTile {
                    bytes: vec![9; 10],
                    content_type: "image/png".into(),
                },
                Some(SourceInfo {
                    display_name: "World Imagery".into(),
                    url_template: "https://x".into(),
                    format: "png".into(),
                    ..Default::default()
                }),
            )
            .unwrap();
        let got = store.get(&src, coord).unwrap().unwrap();
        assert_eq!(got.bytes, vec![9; 10]);
        let stats = store.stats().unwrap();
        assert!(stats.iter().any(|s| s.source == src.as_str()));
        // clear 单库
        let freed = store.clear(Some(&src)).unwrap();
        assert!(freed > 0);
        assert!(store.get(&src, coord).unwrap().is_none());
    }

    #[test]
    fn source_size_and_removal_include_wal_and_shm_files() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("source.mbtiles");
        let wal = path.with_extension("mbtiles-wal");
        let shm = path.with_extension("mbtiles-shm");
        std::fs::write(&path, [1u8; 3]).unwrap();
        std::fs::write(&wal, [2u8; 5]).unwrap();
        std::fs::write(&shm, [3u8; 7]).unwrap();

        assert_eq!(Store::source_disk_size(&path), 15);
        assert_eq!(Store::remove_source_files(&path).unwrap(), 15);
        assert!(!path.exists());
        assert!(!wal.exists());
        assert!(!shm.exists());
    }

    #[test]
    fn clear_all_removes_orphan_wal_and_shm_files() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap();
        let dir = tempdir().unwrap();
        let _restore = ConfigRestore(get_config());
        set_config(CacheConfig {
            enabled: true,
            root_dir: dir.path().to_path_buf(),
            max_total_bytes: 1024,
        });
        let wal = dir.path().join("orphan.mbtiles-wal");
        let shm = dir.path().join("orphan.mbtiles-shm");
        std::fs::write(&wal, [1u8; 5]).unwrap();
        std::fs::write(&shm, [2u8; 7]).unwrap();

        let store = Store::new();
        assert_eq!(store.clear(None).unwrap(), 12);
        assert!(!wal.exists());
        assert!(!shm.exists());
    }

    #[test]
    fn write_path_prunes_cache_when_capacity_check_is_due() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap();
        let dir = tempdir().unwrap();
        let _restore = ConfigRestore(get_config());
        set_config(CacheConfig {
            enabled: true,
            root_dir: dir.path().to_path_buf(),
            max_total_bytes: 1024,
        });
        let store = Store::new();
        let source = SourceKey::new("auto prune source");
        let path = Store::path_for(&source);
        store.auto_prune.lock().unwrap().last_check = Instant::now() - AUTO_PRUNE_CHECK_INTERVAL;
        store
            .put(
                &source,
                TileCoord { z: 1, x: 0, y: 0 },
                StoredTile {
                    bytes: vec![7; 4096],
                    content_type: "image/png".into(),
                },
                Some(SourceInfo {
                    display_name: "Auto prune".into(),
                    url_template: "https://example.invalid/{z}/{x}/{y}".into(),
                    format: "png".into(),
                    ..Default::default()
                }),
            )
            .unwrap();

        assert!(!path.exists());
        assert!(store.stats().unwrap().is_empty());
    }

    #[test]
    fn active_download_source_is_pruned_only_after_unregister() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap();
        let dir = tempdir().unwrap();
        let _restore = ConfigRestore(get_config());
        set_config(CacheConfig {
            enabled: true,
            root_dir: dir.path().to_path_buf(),
            max_total_bytes: 1024,
        });
        let store = Store::new();
        let source = SourceKey::new("active source prune test");
        let coord = TileCoord { z: 1, x: 0, y: 0 };
        let path = Store::path_for(&source);
        active_downloads::register(source.as_str(), &[coord]);
        store.auto_prune.lock().unwrap().last_check = Instant::now() - AUTO_PRUNE_CHECK_INTERVAL;
        let put_result = store.put(
            &source,
            coord,
            StoredTile {
                bytes: vec![7; 4096],
                content_type: "image/png".into(),
            },
            Some(SourceInfo {
                display_name: "Active source".into(),
                url_template: "https://example.invalid/{z}/{x}/{y}".into(),
                format: "png".into(),
                ..Default::default()
            }),
        );
        let existed_while_active = path.exists();
        active_downloads::unregister(source.as_str());
        put_result.unwrap();
        assert!(existed_while_active);

        store.request_capacity_check();

        assert!(!path.exists());
    }
}
