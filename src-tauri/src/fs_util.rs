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
    available_space_for_existing_path(&existing)
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
    let output = std::process::Command::new("df")
        .args(["-Pk"])
        .arg(path)
        .output()
        .map_err(|e| format!("执行 df 失败: {}", e))?;
    if !output.status.success() {
        return Err("读取目标磁盘空间失败".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .last()
        .ok_or("df 未返回磁盘信息")?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    let available_kb = fields
        .get(3)
        .ok_or("df 返回格式异常")?
        .parse::<u64>()
        .map_err(|e| format!("解析磁盘空间失败: {}", e))?;
    Ok(available_kb.saturating_mul(1024))
}
