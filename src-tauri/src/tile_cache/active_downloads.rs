//! 活跃下载坐标注册表：让 Store::put（浏览写缓存）能感知哪些瓦片正在被下载，
//! 从而在浏览补齐时通知下载器跳过。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use dashmap::DashSet;

use super::TileCoord;

type CoordKey = (String, u8, u32, u32);

static ACTIVE: OnceLock<DashSet<CoordKey>> = OnceLock::new();
static BROWSE_FILLED: AtomicU64 = AtomicU64::new(0);

fn active_set() -> &'static DashSet<CoordKey> {
    ACTIVE.get_or_init(DashSet::new)
}

/// 下载器启动时注册待下载坐标。
pub fn register(source: &str, coords: &[TileCoord]) {
    let set = active_set();
    for c in coords {
        set.insert((source.to_string(), c.z, c.x, c.y));
    }
}

/// 下载器结束时注销该 source 的所有坐标。
pub fn unregister(source: &str) {
    let set = active_set();
    set.retain(|k| k.0 != source);
}

/// Store::put 成功后调用：如果该坐标正在被下载，移除并返回 true。
pub fn notify_cached(source: &str, coord: TileCoord) -> bool {
    let key = (source.to_string(), coord.z, coord.x, coord.y);
    if active_set().remove(&key).is_some() {
        BROWSE_FILLED.fetch_add(1, Ordering::Relaxed);
        true
    } else {
        false
    }
}

/// tile future 内调用：检查该坐标是否仍在活跃下载集合中。
/// 返回 false 表示已被浏览补齐（已从集合中移除）。
pub fn is_still_pending(source: &str, coord: TileCoord) -> bool {
    let key = (source.to_string(), coord.z, coord.x, coord.y);
    active_set().contains(&key)
}

/// 获取累计被浏览补齐的瓦片数。
pub fn browse_filled_count() -> u64 {
    BROWSE_FILLED.load(Ordering::Relaxed)
}

/// 重置计数器（每个下载任务开始时调用）。
pub fn reset_browse_filled() {
    BROWSE_FILLED.store(0, Ordering::Relaxed);
}

/// RAII guard：drop 时自动 unregister 对应 source。
pub struct DownloadGuard {
    source: String,
}

impl DownloadGuard {
    pub fn new(source: &str, coords: &[TileCoord]) -> Self {
        register(source, coords);
        reset_browse_filled();
        Self { source: source.to_string() }
    }
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        unregister(&self.source);
    }
}
