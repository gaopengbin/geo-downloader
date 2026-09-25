//! Process-local cache access gate, independent of the desktop migration UI.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

static MIGRATING: AtomicBool = AtomicBool::new(false);
static CACHE_ACCESS_GATE: RwLock<()> = RwLock::new(());

pub fn is_migrating() -> bool {
    MIGRATING.load(Ordering::Acquire)
}

pub(crate) fn set_migrating(migrating: bool) {
    MIGRATING.store(migrating, Ordering::Release);
}

pub(crate) fn begin_cache_access() -> Option<RwLockReadGuard<'static, ()>> {
    if is_migrating() {
        return None;
    }
    let guard = CACHE_ACCESS_GATE.read().ok()?;
    if is_migrating() {
        return None;
    }
    Some(guard)
}

pub(crate) fn lock_cache_exclusive() -> Result<RwLockWriteGuard<'static, ()>, String> {
    CACHE_ACCESS_GATE
        .write()
        .map_err(|_| "缓存访问锁异常".to_string())
}
