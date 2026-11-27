//! 文件系统工具：原子写入等。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Keep a small reserve so a download cannot consume the last bytes on a volume.
pub const MIN_FREE_SPACE_BYTES: u64 = 512 * 1024 * 1024;

/// 原子写入：先写同目录临时文件，fsync 后 rename 覆盖目标，
/// 避免进程崩溃/断电时产生半截（截断）文件破坏 JSON 配置/状态。
///
/// 同目录 rename 在主流文件系统上是原子操作（Windows 上 Rust 使用
/// MoveFileEx 覆盖现有文件）。临时文件名带进程 id，避免不同进程撞名。
pub fn atomic_write(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty());
    let dir = dir.unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "out".to_string());
    let tmp_path = dir.join(format!(".{}.{}.tmp", file_name, std::process::id()));

    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(content)?;
        f.sync_all()?;
    }

    match fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // rename 失败时清理临时文件，避免遗留垃圾
            let _ = fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

pub fn nearest_existing_parent(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.exists() {
            return Some(candidate.to_path_buf());
        }
        current = candidate.parent();
    }
    None
}

pub fn available_space_for_path(path: &Path) -> Result<u64, String> {
    let existing = nearest_existing_parent(path)
        .ok_or_else(|| format!("找不到可用的磁盘路径: {}", path.display()))?;
    let directory = if existing.is_file() { existing.parent().unwrap_or(&existing) } else { &existing };
    available_space_for_existing_path(directory)
}

pub fn ensure_minimum_free_space(path: &Path) -> Result<(), String> {
    let available = available_space_for_path(path)?;
    if available < MIN_FREE_SPACE_BYTES {
        return Err(format!(
            "磁盘空间不足：{} 可用空间仅 {:.1} MB，至少需要保留 512 MB。任务数据已保留，释放空间后可继续。",
            path.display(),
            available as f64 / 1024.0 / 1024.0
        ));
    }
    Ok(())
}

/// Coordinates allocations by filesystem, including paths mounted under a different directory.
/// The mutex covers the space probe and reservation only. File writes can overlap.
#[derive(Default)]
pub(crate) struct VolumeWriteBudget {
    allocation_unit: u64,
    pending: std::sync::Mutex<u64>,
    completed: std::sync::Condvar,
}

impl VolumeWriteBudget {
    pub(crate) fn for_file(file: &fs::File, path: &Path) -> std::sync::Arc<Self> {
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex, OnceLock, Weak};
        static VOLUMES: OnceLock<Mutex<HashMap<Option<u64>, Weak<VolumeWriteBudget>>>> = OnceLock::new();
        let id = volume_id(file);
        // A filesystem can allocate one whole cluster per independent file write.
        // Keep a conservative allowance for volumes that do not report a cluster size.
        let allocation_unit = fs2::allocation_granularity(path).ok().filter(|&v| v > 0).unwrap_or(32 << 20);
        let mut volumes = VOLUMES.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner());
        if let Some(volume) = volumes.get(&id).and_then(Weak::upgrade) {
            return volume;
        }
        volumes.retain(|_, budget| budget.strong_count() > 0);
        let volume = Arc::new(Self { allocation_unit, ..Self::default() });
        volumes.insert(id, Arc::downgrade(&volume));
        volume
    }

    pub(crate) fn reserve(
        &self, bytes: u64, check: impl Fn(u64) -> Result<(), String>,
    ) -> Result<WriteReservation<'_>, String> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let total = pending.checked_add(bytes).ok_or("写入空间超出上限")?;
            match check(total) {
                Ok(()) => {
                    let unit = self.allocation_unit.max(1);
                    let allocated = bytes.div_ceil(unit).checked_mul(unit).ok_or("写入空间超出上限")?;
                    *pending = pending.checked_add(allocated).ok_or("写入空间超出上限")?;
                    return Ok(WriteReservation { volume: self, bytes: allocated });
                }
                Err(error) if *pending == 0 => return Err(error),
                Err(_) => {
                    // A peer may already have allocated its bytes but not yet returned from
                    // write(). Wait only when this write would fit on its own, then re-probe.
                    check(bytes)?;
                    pending = self.completed.wait(pending).unwrap_or_else(|e| e.into_inner());
                }
            }
        }
    }
}

pub(crate) struct WriteReservation<'a> {
    volume: &'a VolumeWriteBudget,
    bytes: u64,
}

impl Drop for WriteReservation<'_> {
    fn drop(&mut self) {
        let mut pending = self.volume.pending.lock().unwrap_or_else(|e| e.into_inner());
        *pending -= self.bytes;
        self.volume.completed.notify_all();
    }
}

#[cfg(unix)]
fn volume_id(file: &fs::File) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    file.metadata().ok().map(|metadata| metadata.dev())
}

#[cfg(windows)]
fn volume_id(file: &fs::File) -> Option<u64> {
    use std::os::windows::io::AsRawHandle;
    // BY_HANDLE_FILE_INFORMATION contains DWORD fields and three FILETIMEs (two DWORDs each).
    #[repr(C)]
    struct FileInfo {
        attributes: u32,
        times: [u32; 6],
        volume_serial: u32,
        size_links_and_index: [u32; 5],
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut FileInfo) -> i32;
    }
    let mut info = std::mem::MaybeUninit::uninit();
    // A file handle also resolves mounted folders and UNC shares. Filesystems which
    // don't provide an identifier share a conservative fallback budget.
    unsafe {
        (GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) != 0)
            .then(|| u64::from(info.assume_init().volume_serial))
    }
}

/// Check the next actual write, leaving the recovery reserve on the output volume.
pub(crate) fn ensure_write_space(path: &Path, write_bytes: u64) -> Result<(), String> {
    check_write_space(available_space_for_path(path)?, write_bytes)
}

pub(crate) fn check_write_space(available: u64, write_bytes: u64) -> Result<(), String> {
    if write_bytes == 0 && available < MIN_FREE_SPACE_BYTES {
        return Err(format!("磁盘空间不足：当前可用 {:.1} MB，至少需要保留 512 MB。",
            available as f64 / 1_048_576.0));
    }
    if available < write_bytes.saturating_add(MIN_FREE_SPACE_BYTES) {
        return Err(format!(
            "磁盘空间不足：本次写入需要 {:.1} MB，另需保留 512 MB，当前可用 {:.1} MB。",
            write_bytes as f64 / 1_048_576.0, available as f64 / 1_048_576.0,
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn available_space_for_existing_path(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory_name: *const u16,
            free_bytes_available: *mut u64,
            total_number_of_bytes: *mut u64,
            total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(format!(
            "读取目标磁盘空间失败: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(available)
    }
}

#[cfg(not(windows))]
fn available_space_for_existing_path(path: &Path) -> Result<u64, String> {
    fs2::available_space(path).map_err(|e| format!("读取目标磁盘空间失败: {e}"))
}

#[cfg(test)]
mod volume_write_tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[test]
    fn independent_small_writes_account_for_whole_filesystem_clusters() {
        let budget = VolumeWriteBudget { allocation_unit: 4096, ..VolumeWriteBudget::default() };
        let _first = budget.reserve(1, |_| Ok(())).unwrap();
        let _second = budget.reserve(1, |planned| {
            assert_eq!(planned, 4097);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn concurrent_writers_share_space_and_retry_after_capacity_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let second_dir = dir.path().join("other folder");
        fs::create_dir(&second_dir).unwrap();
        let first_path = dir.path().join("first.part");
        let second_path = second_dir.join("second.part");
        let mut first = fs::File::create(&first_path).unwrap();
        let mut second = fs::File::create(&second_path).unwrap();
        assert!(Arc::ptr_eq(&VolumeWriteBudget::for_file(&first, &first_path), &VolumeWriteBudget::for_file(&second, &second_path)));

        // Isolated logical capacity on real files so parallel tests on this drive do not
        // contribute unrelated reservations. Each write fits alone; both together do not.
        let budget = VolumeWriteBudget::default();
        let block = [42u8; 4096];
        let capacity = MIN_FREE_SPACE_BYTES + 6144;
        let check = |capacity: u64, planned| {
            let used = fs::metadata(&first_path).unwrap().len() + fs::metadata(&second_path).unwrap().len();
            check_write_space(capacity.saturating_sub(used), planned)
        };
        std::thread::scope(|scope| {
            let (detected, waiting) = mpsc::channel();
            let first_write = budget.reserve(4096, |n| check(capacity, n)).unwrap();
            let second_ref = &mut second;
            let budget_ref = &budget;
            let second_writer = scope.spawn(move || {
                let _reserve = budget_ref.reserve(4096, |planned| {
                    if planned == 8192 { detected.send(()).unwrap(); }
                    check(capacity, planned)
                })?;
                second_ref.write_all(&block).map_err(|e| e.to_string())
            });
            waiting.recv_timeout(Duration::from_secs(5)).unwrap();
            first.write_all(&block).unwrap();
            drop(first_write);
            let error = second_writer.join().unwrap().unwrap_err();
            assert!(error.contains("磁盘空间不足"));
        });
        assert_eq!(fs::metadata(&second_path).unwrap().len(), 0);
        assert!(capacity - fs::metadata(&first_path).unwrap().len() >= MIN_FREE_SPACE_BYTES);

        // Ample space admits independent writes concurrently without waiting.
        let ample = capacity + 12288;
        let _first = budget.reserve(4096, |n| check(ample, n)).unwrap();
        let _second = budget.reserve(4096, |n| check(ample, n)).unwrap();
        second.write_all(&block).unwrap();
        assert_eq!(fs::read(&second_path).unwrap(), block);
    }
}
