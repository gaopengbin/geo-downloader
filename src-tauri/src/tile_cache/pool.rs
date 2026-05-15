//! 多 source 连接池：每个 SourceKey 一个常驻 mbtiles 连接，LRU 上限 8。
//!
//! 也实现了对外的 `Store` 入口，对调用方屏蔽连接复用与磁盘容量管理。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use super::{
    active_downloads, get_config, store::TileStore, PruneReport, SourceInfo, SourceKey,
    SourceStats, StoredTile, TileCoord,
};

const POOL_MAX: usize = 8;

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
}

static GLOBAL_STORE: OnceLock<Store> = OnceLock::new();

impl Store {
    pub fn global() -> &'static Store {
        GLOBAL_STORE.get_or_init(|| Store {
            inner: Mutex::new(Inner::default()),
        })
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
            log::info!("[tile_cache] shutdown: checkpoint 并关闭了 {} 个 mbtiles 连接", n);
        }
    }

    pub fn get(&self, src: &SourceKey, coord: TileCoord) -> Result<Option<StoredTile>, String> {
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
        Ok(())
    }

    pub fn put_batch(
        &self,
        src: &SourceKey,
        batch: Vec<(TileCoord, StoredTile)>,
        info: Option<SourceInfo>,
    ) -> Result<(), String> {
        if !get_config().enabled || batch.is_empty() {
            return Ok(());
        }
        let handle = self.handle(src)?;
        let mut store = handle.lock().map_err(|_| "store poisoned".to_string())?;
        if let Some(info) = info {
            store.ensure_metadata(&info)?;
        }
        store.put_batch(&batch)
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
        let handle = self.handle(src)?;
        let mut store = handle.lock().map_err(|_| "store poisoned".to_string())?;
        store.ensure_metadata(&info)
    }

    /// 列出磁盘上所有 source 的统计信息（包括未在连接池中的）。
    pub fn stats(&self) -> Result<Vec<SourceStats>, String> {
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
            let size = entry
                .metadata()
                .map(|m| m.len())
                .unwrap_or(0);
            let src = SourceKey(stem);
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
        match src {
            Some(s) => {
                self.close(s);
                let path = Self::path_for(s);
                let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(&path);
                // WAL/journal 副文件
                let _ = std::fs::remove_file(path.with_extension("mbtiles-wal"));
                let _ = std::fs::remove_file(path.with_extension("mbtiles-shm"));
                Ok(size)
            }
            None => {
                // 关闭全部连接（先 checkpoint 再丢，避免删主文件后留下孤儿 -wal）
                self.shutdown();
                let cfg = get_config();
                let mut freed = 0u64;
                if let Ok(rd) = std::fs::read_dir(&cfg.root_dir) {
                    for entry in rd.flatten() {
                        let path = entry.path();
                        if path
                            .extension()
                            .and_then(|s| s.to_str())
                            .map(|e| e == "mbtiles" || e == "mbtiles-wal" || e == "mbtiles-shm")
                            .unwrap_or(false)
                        {
                            freed += entry.metadata().map(|m| m.len()).unwrap_or(0);
                            let _ = std::fs::remove_file(&path);
                        }
                    }
                }
                Ok(freed)
            }
        }
    }

    /// LRU 整库淘汰：按 gd_last_used_at 升序删，直到总大小 <= max_total_bytes。
    pub fn prune(&self, max_total_bytes: u64) -> Result<PruneReport, String> {
        if max_total_bytes == 0 {
            return Ok(PruneReport {
                removed_sources: vec![],
                freed_bytes: 0,
            });
        }
        let mut stats = self.stats()?;
        let total: u64 = stats.iter().map(|s| s.size_bytes).sum();
        if total <= max_total_bytes {
            return Ok(PruneReport {
                removed_sources: vec![],
                freed_bytes: 0,
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
        let mut freed = 0u64;
        let mut current = total;
        for s in stats {
            if current <= max_total_bytes {
                break;
            }
            let key = SourceKey(s.source.clone());
            let f = self.clear(Some(&key)).unwrap_or(0);
            current = current.saturating_sub(f);
            freed += f;
            removed.push(s.source);
        }
        Ok(PruneReport {
            removed_sources: removed,
            freed_bytes: freed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tile_cache::{set_root_dir, CacheConfig, set_config};
    use tempfile::tempdir;

    #[test]
    fn end_to_end_get_put() {
        let dir = tempdir().unwrap();
        set_config(CacheConfig {
            enabled: true,
            root_dir: dir.path().to_path_buf(),
            max_total_bytes: 10 * 1024 * 1024,
        });
        let store = Store::global();
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

        // 重置全局，避免影响其他测试
        set_root_dir(CacheConfig::default_root());
    }
}
