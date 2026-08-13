//! 下载任务管理模块

use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// 任务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Downloading,
    Paused,
    /// Issue #31：成功率过低，跳过自动导出，等待用户决策（补漏重试 / 强制导出）。
    /// 独立于 Paused，避免被「暂停/恢复」开关误操作成假 Downloading 卡死。
    #[serde(rename = "pending_decision")]
    PendingDecision,
    Merging,
    Processing,
    Exporting,
    Completed,
    /// 部分失败但已自动导出（Issue #31）：成功率 ≥ `min_export_success_ratio`，
    /// 导出已完成但存在缺块，需要在 UI 标缺块徽章供用户决定是否补漏重导。
    #[serde(rename = "completed_with_gaps")]
    CompletedWithGaps,
    Failed,
    Cancelled,
}

/// 任务信息
#[derive(Debug, Clone, Serialize)]
pub struct TaskInfo {
    pub id: String,
    pub name: String,
    pub source: String,
    pub source_name: String,
    pub zoom: u8,
    pub format: String,
    pub save_path: String,
    pub status: TaskStatus,
    pub progress: f64,
    pub completed: u32,
    pub total: u32,
    pub failed_count: u32,
    /// 成功瓦片数（completed - failed_count - no_data，Issue #31）。
    /// TaskManager 在 update_progress 时按 completed/failed_count 自动推算，
    /// 调用方无须显式传递。
    #[serde(default)]
    pub success_count: u32,
    pub file_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 日志条目
#[derive(Debug, Clone, Serialize)]
pub struct TaskLog {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

/// 暂停控制句柄
#[derive(Clone)]
pub struct PauseControl {
    pub flag: Arc<AtomicBool>,
    pub notify: Arc<Notify>,
}

impl PauseControl {
    fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn is_paused(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    /// 如果当前处于暂停状态，等待恢复
    pub async fn wait_if_paused(&self) {
        loop {
            // 先登记 waiter（enable）再检查 flag，避免 toggle_pause 的 notify_waiters()
            // 在「检查 flag」与「await」之间触发导致丢失唤醒 → 暂停永久卡死。
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.flag.load(Ordering::Relaxed) {
                return;
            }
            notified.await;
        }
    }
}

/// 内部任务条目（包含取消令牌）
struct TaskEntry {
    info: TaskInfo,
    cancel_token: CancellationToken,
    pause_control: PauseControl,
    logs: Vec<TaskLog>,
    log_writer: Option<Arc<Mutex<crate::task_log::TaskLogWriter>>>,
}

/// 全局任务管理器
pub struct TaskManager {
    tasks: Arc<Mutex<HashMap<String, TaskEntry>>>,
    log_dir: PathBuf,
}

impl TaskManager {
    pub fn new() -> Self {
        let log_dir = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("geo-downloader")
            .join("logs");
        Self::new_with_log_dir(log_dir)
    }

    pub(crate) fn new_with_log_dir(log_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&log_dir);
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            log_dir,
        }
    }

    /// 创建新任务，返回 (task_id, CancellationToken)
    pub fn create_task(
        &self,
        id: String,
        name: String,
        source: String,
        source_name: String,
        zoom: u8,
        format: String,
        save_path: String,
        total: u32,
    ) -> (CancellationToken, PauseControl) {
        let cancel_token = CancellationToken::new();
        let pause_control = PauseControl::new();
        let info = TaskInfo {
            id: id.clone(),
            name,
            source,
            source_name,
            zoom,
            format,
            save_path,
            status: TaskStatus::Pending,
            progress: 0.0,
            completed: 0,
            total,
            failed_count: 0,
            success_count: 0,
            file_size: 0,
            message: None,
            error: None,
        };
        // 创建日志文件
        let log_path = self.log_dir.join(format!("task_{}.log", task_id_prefix(&id)));
        let log_writer = crate::task_log::TaskLogWriter::open(&log_path)
            .map(|writer| Arc::new(Mutex::new(writer)))
            .map_err(|error| log::warn!("{error}"))
            .ok();
        let entry = TaskEntry {
            info,
            cancel_token: cancel_token.clone(),
            pause_control: pause_control.clone(),
            logs: Vec::new(),
            log_writer,
        };
        self.tasks.lock().unwrap().insert(id, entry);
        (cancel_token, pause_control)
    }

    /// 更新任务进度
    pub fn update_progress(
        &self,
        id: &str,
        status: TaskStatus,
        progress: f64,
        completed: u32,
        failed_count: u32,
        message: Option<String>,
    ) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            // 终态保护：已取消 / 已完成（含缺块）/ 已失败的任务不再被进度回调覆盖
            if matches!(
                entry.info.status,
                TaskStatus::Cancelled
                    | TaskStatus::Completed
                    | TaskStatus::CompletedWithGaps
                    | TaskStatus::Failed
            ) {
                return;
            }
            entry.info.status = if entry.pause_control.is_paused()
                && matches!(status, TaskStatus::Pending | TaskStatus::Downloading)
            {
                TaskStatus::Paused
            } else {
                status
            };
            entry.info.progress = progress;
            entry.info.completed = completed;
            entry.info.failed_count = failed_count;
            // Issue #31：success_count 自动推算，避免调用方分散维护
            entry.info.success_count = completed.saturating_sub(failed_count);
            entry.info.message = message;
        }
    }

    /// 标记任务完成
    pub fn complete_task(&self, id: &str, file_size: u64) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            // 终态保护：已取消/失败/完成的任务不被覆写
            if matches!(
                entry.info.status,
                TaskStatus::Cancelled
                    | TaskStatus::Failed
                    | TaskStatus::Completed
                    | TaskStatus::CompletedWithGaps
            ) {
                return;
            }
            entry.info.status = TaskStatus::Completed;
            entry.info.progress = 100.0;
            entry.info.file_size = file_size;
            entry.info.message = Some("完成".to_string());
        }
    }

    /// 标记任务完成但有缺块（Issue #31）
    ///
    /// 成功率 ≥ `min_export_success_ratio` 时走自动导出，若伴随失败瓦片则状态
    /// 切到 `CompletedWithGaps` 而非 `Completed`，让 UI 展示缺块徽章。
    pub fn complete_task_with_gaps(&self, id: &str, file_size: u64, failed_count: u32) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            // 终态保护：已取消/失败/完成的任务不被覆写
            if matches!(
                entry.info.status,
                TaskStatus::Cancelled
                    | TaskStatus::Failed
                    | TaskStatus::Completed
                    | TaskStatus::CompletedWithGaps
            ) {
                return;
            }
            entry.info.status = TaskStatus::CompletedWithGaps;
            entry.info.progress = 100.0;
            entry.info.file_size = file_size;
            entry.info.failed_count = failed_count;
            entry.info.message = Some(format!("完成但有 {} 张缺块", failed_count));
        }
    }

    /// 标记任务等待用户决策（Issue #31）
    ///
    /// 成功率 < `min_export_success_ratio` 时跳过导出，缓存保留供用户后续选择
    /// 「补漏重试」(`resume_task`) 或「强制按现状导出」(`export_partial_task`)。
    pub fn mark_pending_decision(&self, id: &str, reason: String) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            // 终态保护：已取消/失败/完成的任务不被覆写
            if matches!(
                entry.info.status,
                TaskStatus::Cancelled
                    | TaskStatus::Failed
                    | TaskStatus::Completed
                    | TaskStatus::CompletedWithGaps
            ) {
                return;
            }
            entry.info.status = TaskStatus::PendingDecision;
            entry.info.message = Some(reason);
        }
    }

    /// 标记任务失败
    pub fn fail_task(&self, id: &str, error: String) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            // 终态保护：已取消/已完成的任务不被覆写成失败
            if matches!(
                entry.info.status,
                TaskStatus::Cancelled
                    | TaskStatus::Completed
                    | TaskStatus::CompletedWithGaps
            ) {
                return;
            }
            entry.info.status = TaskStatus::Failed;
            entry.info.error = Some(error);
        }
    }

    /// 取消任务
    pub fn cancel_task(&self, id: &str) -> bool {
        if let Some(entry) = self.tasks.lock().unwrap().get(id) {
            if entry.info.status != TaskStatus::Completed
                && entry.info.status != TaskStatus::CompletedWithGaps
                && entry.info.status != TaskStatus::Failed
                && entry.info.status != TaskStatus::Cancelled
            {
                entry.cancel_token.cancel();
                // A paused worker is waiting on PauseControl and would not observe the
                // cancellation token until it is woken up.
                entry.pause_control.flag.store(false, Ordering::Relaxed);
                entry.pause_control.notify.notify_waiters();
                return true;
            }
        }
        false
    }

    /// 将取消的任务标记状态
    pub fn mark_cancelled(&self, id: &str) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            entry.info.status = TaskStatus::Cancelled;
            entry.info.message = Some("已取消".to_string());
        }
    }

    /// 暂停/恢复任务，返回 (成功, 当前是否暂停)
    pub fn toggle_pause(&self, id: &str) -> (bool, bool) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            if !matches!(
                entry.info.status,
                TaskStatus::Pending | TaskStatus::Downloading | TaskStatus::Paused
            ) {
                return (false, false);
            }
            let is_paused = entry.pause_control.is_paused();
            if is_paused {
                // 恢复
                entry.pause_control.flag.store(false, Ordering::Relaxed);
                entry.pause_control.notify.notify_waiters();
                entry.info.status = TaskStatus::Downloading;
                entry.info.message = Some("已恢复下载".to_string());
                (true, false)
            } else {
                // 暂停
                entry.pause_control.flag.store(true, Ordering::Relaxed);
                entry.info.status = TaskStatus::Paused;
                entry.info.message = Some("已暂停".to_string());
                (true, true)
            }
        } else {
            (false, false)
        }
    }

    /// 获取所有任务信息
    pub fn get_all_tasks(&self) -> Vec<TaskInfo> {
        self.tasks
            .lock()
            .unwrap()
            .values()
            .map(|e| e.info.clone())
            .collect()
    }

    pub fn has_active_tasks(&self) -> bool {
        self.tasks.lock().unwrap().values().any(|entry| {
            !matches!(
                entry.info.status,
                TaskStatus::Completed
                    | TaskStatus::CompletedWithGaps
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
            )
        })
    }

    /// 移除已完成/失败/取消的任务
    pub fn remove_finished(&self, id: &str) {
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(entry) = tasks.get(id) {
            if matches!(
                entry.info.status,
                TaskStatus::Completed
                    | TaskStatus::CompletedWithGaps
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
            ) {
                tasks.remove(id);
            }
        }
    }

    /// 追加任务日志
    pub fn append_log(&self, id: &str, level: &str, message: &str) -> Option<TaskLog> {
        let log = TaskLog {
            timestamp: Local::now().format("%H:%M:%S").to_string(),
            level: level.to_string(),
            message: message.to_string(),
        };
        let writer = {
            let mut tasks = self.tasks.lock().unwrap();
            let entry = tasks.get_mut(id)?;
            entry.logs.push(log.clone());
            entry.log_writer.clone()
        };
        if let Some(writer) = writer {
            if let Ok(mut writer) = writer.lock() {
                if let Err(error) = writer.append(level, message) {
                    log::warn!("{error}");
                }
            }
        }
        Some(log)
    }

    /// 获取任务日志（内存优先，若任务已移除则从文件回读）
    pub fn get_logs(&self, id: &str) -> Vec<TaskLog> {
        let tasks = self.tasks.lock().unwrap();
        if let Some(entry) = tasks.get(id) {
            if !entry.logs.is_empty() {
                return entry.logs.clone();
            }
        }
        drop(tasks);
        // 内存为空，尝试从日志文件回读
        self.read_log_file(id)
    }

    /// 从磁盘日志文件读取日志
    fn read_log_file(&self, id: &str) -> Vec<TaskLog> {
        let log_path = self.log_dir.join(format!("task_{}.log", task_id_prefix(id)));
        crate::task_log::read_log_file(&log_path).unwrap_or_default()
    }

    /// 按完整文件路径读取日志
    pub fn read_log_file_by_path(path: &str) -> Result<Vec<TaskLog>, String> {
        crate::task_log::read_log_file(Path::new(path))
    }

    /// 获取任务日志文件路径
    pub fn get_log_file_path(&self, id: &str) -> Option<String> {
        self.get_log_metadata(id)
            .and_then(|metadata| metadata.path)
            .map(|path| path.to_string_lossy().into_owned())
    }

    pub fn get_log_metadata(&self, id: &str) -> Option<crate::task_log::LogMetadata> {
        let writer = self.tasks.lock().unwrap().get(id)?.log_writer.clone()?;
        writer.lock().ok().map(|writer| writer.metadata())
    }

    pub fn active_log_paths(&self) -> std::collections::HashSet<PathBuf> {
        let writers = self.tasks.lock().unwrap().values()
            .filter(|entry| !matches!(entry.info.status,
                TaskStatus::Completed | TaskStatus::CompletedWithGaps |
                TaskStatus::Failed | TaskStatus::Cancelled))
            .filter_map(|entry| entry.log_writer.clone())
            .collect::<Vec<_>>();
        writers.into_iter()
            .filter_map(|writer| writer.lock().ok().map(|writer| writer.path().to_path_buf()))
            .collect()
    }

    pub fn log_dir_path(&self) -> PathBuf {
        self.log_dir.clone()
    }

    /// 获取日志目录路径
    pub fn get_log_dir(&self) -> String {
        self.log_dir.to_string_lossy().to_string()
    }

    /// 检查任务是否已取消
    pub fn is_cancelled(&self, id: &str) -> bool {
        if let Some(entry) = self.tasks.lock().unwrap().get(id) {
            entry.cancel_token.is_cancelled()
        } else {
            false
        }
    }
}

fn task_id_prefix(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn active_log_paths_only_contains_live_task_logs() {
        let tmp = TempDir::new().unwrap();
        let manager = TaskManager::new_with_log_dir(tmp.path().to_path_buf());
        manager.create_task(
            "12345678-task".to_string(), "task".to_string(), "source".to_string(),
            "Source".to_string(), 1, "tiles".to_string(), "D:/output".to_string(), 1,
        );
        let paths = manager.active_log_paths();
        assert_eq!(paths.len(), 1);
        assert!(paths.iter().next().unwrap().starts_with(tmp.path()));
        manager.complete_task("12345678-task", 0);
        assert!(manager.active_log_paths().is_empty());
    }

    #[test]
    fn concurrent_tasks_keep_independent_log_writers() {
        let tmp = TempDir::new().unwrap();
        let manager = Arc::new(TaskManager::new_with_log_dir(tmp.path().to_path_buf()));
        let ids = (0..4).map(|index| format!("{index:08}-task"))
            .collect::<Vec<_>>();
        for id in &ids {
            manager.create_task(
                id.clone(), id.clone(), "source".to_string(), "Source".to_string(),
                1, "tiles".to_string(), "D:/output".to_string(), 100,
            );
        }
        let joins = ids.iter().cloned().map(|id| {
            let manager = manager.clone();
            std::thread::spawn(move || {
                for index in 0..100 {
                    manager.append_log(&id, "INFO", &format!("line-{index}"));
                }
            })
        }).collect::<Vec<_>>();
        for join in joins { join.join().unwrap(); }

        for id in &ids {
            assert_eq!(manager.get_logs(id).len(), 100);
            assert!(manager.get_log_metadata(id).unwrap().stored_size > 0);
        }
        assert_eq!(manager.active_log_paths().len(), 4);
    }

    #[test]
    fn concurrent_tasks_pause_independently() {
        let tmp = TempDir::new().unwrap();
        let manager = TaskManager::new_with_log_dir(tmp.path().to_path_buf());
        for id in ["first-task", "second-task"] {
            manager.create_task(
                id.to_string(), id.to_string(), "source".to_string(), "Source".to_string(),
                1, "tiles".to_string(), "D:/output".to_string(), 100,
            );
            manager.update_progress(id, TaskStatus::Downloading, 10.0, 10, 0, None);
        }

        assert_eq!(manager.toggle_pause("second-task"), (true, true));
        let tasks = manager.get_all_tasks();
        assert_eq!(
            tasks.iter().find(|task| task.id == "first-task").unwrap().status,
            TaskStatus::Downloading
        );
        assert_eq!(
            tasks.iter().find(|task| task.id == "second-task").unwrap().status,
            TaskStatus::Paused
        );

        assert_eq!(manager.toggle_pause("first-task"), (true, true));
        assert_eq!(manager.toggle_pause("second-task"), (true, false));
        let tasks = manager.get_all_tasks();
        assert_eq!(
            tasks.iter().find(|task| task.id == "first-task").unwrap().status,
            TaskStatus::Paused
        );
        assert_eq!(
            tasks.iter().find(|task| task.id == "second-task").unwrap().status,
            TaskStatus::Downloading
        );
    }

    #[test]
    fn pending_task_can_be_paused_and_cancelled() {
        let tmp = TempDir::new().unwrap();
        let manager = TaskManager::new_with_log_dir(tmp.path().to_path_buf());
        let (_, pause) = manager.create_task(
            "pending-task".to_string(), "task".to_string(), "source".to_string(),
            "Source".to_string(), 1, "tiles".to_string(), "D:/output".to_string(), 100,
        );

        assert_eq!(manager.toggle_pause("pending-task"), (true, true));
        manager.update_progress(
            "pending-task", TaskStatus::Downloading, 0.0, 0, 0, None,
        );
        assert_eq!(manager.get_all_tasks()[0].status, TaskStatus::Paused);

        assert!(manager.cancel_task("pending-task"));
        assert!(!pause.is_paused());
    }
}

// ============ 任务持久化（断点续传） ============

use crate::commands::DownloadRequest;

/// 持久化的任务数据（用于崩溃后恢复）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedTask {
    pub task_id: String,
    pub task_name: String,
    pub source_name: String,
    pub request: DownloadRequest,
    pub tile_count: u32,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<String>,
}

fn tasks_dir() -> PathBuf {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("geo-downloader")
        .join("tasks");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 保存任务到磁盘
pub fn save_task_file(task: &PersistedTask) -> Result<(), String> {
    let path = tasks_dir().join(format!("{}.json", task.task_id));
    let content = serde_json::to_string_pretty(task)
        .map_err(|e| format!("序列化失败: {}", e))?;
    crate::fs_util::atomic_write(&path, content.as_bytes())
        .map_err(|e| format!("保存任务文件失败: {}", e))
}

/// 删除持久化任务文件
pub fn remove_task_file(task_id: &str) {
    let path = tasks_dir().join(format!("{}.json", task_id));
    let _ = std::fs::remove_file(path);
}

/// 加载所有可恢复的任务
pub fn load_resumable_tasks() -> Vec<PersistedTask> {
    let dir = tasks_dir();
    load_resumable_tasks_from(&dir)
}

fn load_resumable_tasks_from(dir: &Path) -> Vec<PersistedTask> {
    let mut tasks = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "json") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(task) = serde_json::from_str::<PersistedTask>(&content) {
                        // 工作目录即使被系统或用户清理，任务描述仍可用于从头恢复。
                        tasks.push(task);
                    }
                }
            }
        }
    }
    tasks
}

pub fn task_work_dir(task_id: &str, request: &DownloadRequest) -> Option<PathBuf> {
    let save_path = request.save_path.as_deref()?;
    let output = PathBuf::from(save_path);
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    Some(parent.join(".geod-work").join(task_id))
}

pub fn resolved_task_work_dir(task: &PersistedTask) -> Option<PathBuf> {
    if let Some(path) = task.work_dir.as_deref().filter(|path| !path.is_empty()) {
        return Some(PathBuf::from(path));
    }

    let legacy = std::env::temp_dir().join(format!("tif-dl-{}", task.task_id));
    if legacy.exists() {
        Some(legacy)
    } else {
        task_work_dir(&task.task_id, &task.request)
    }
}

fn load_task_file(task_id: &str) -> Option<PersistedTask> {
    let path = tasks_dir().join(format!("{}.json", task_id));
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn is_safe_work_dir(path: &Path, task_id: &str) -> bool {
    let expected_name = std::ffi::OsStr::new(task_id);
    let is_geod_work = path.file_name() == Some(expected_name)
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == ".geod-work");
    let legacy = std::env::temp_dir().join(format!("tif-dl-{}", task_id));
    is_geod_work || path == legacy
}

/// 清理任务工作目录。路径必须符合应用生成的目录结构，避免误删用户文件。
pub fn cleanup_temp_dir(task_id: &str) {
    let work_dir = load_task_file(task_id)
        .as_ref()
        .and_then(resolved_task_work_dir)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("tif-dl-{}", task_id)));

    if !is_safe_work_dir(&work_dir, task_id) {
        log::error!(
            "[{}] 拒绝清理不安全的任务工作目录: {}",
            task_id,
            work_dir.display()
        );
        return;
    }

    // 调试模式下保留临时目录
    if let Ok(mgr) = crate::settings::SettingsManager::new() {
        if let Ok(settings) = mgr.get() {
            if settings.debug_mode {
                log::info!("[{}] 调试模式已启用，保留任务工作目录: {}（瓦片为图片文件，可改后缀 .png/.jpg 查看）", task_id, work_dir.display());
                return;
            }
        }
    }
    if work_dir.exists() {
        log::info!("[{}] 清理任务工作目录: {}", task_id, work_dir.display());
    }
    let work_parent = work_dir.parent().map(Path::to_path_buf);
    let _ = std::fs::remove_dir_all(&work_dir);
    if let Some(parent) = work_parent.filter(|path| {
        path.file_name()
            .is_some_and(|name| name == ".geod-work")
    }) {
        let is_empty = std::fs::read_dir(&parent)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if is_empty {
            let _ = std::fs::remove_dir(parent);
        }
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use crate::tile::Bounds;

    fn request(format: &str, save_path: &Path) -> DownloadRequest {
        DownloadRequest {
            bounds: Bounds {
                north: 40.0,
                south: 39.0,
                east: 117.0,
                west: 116.0,
            },
            zoom: 10,
            zoom_max: None,
            zoom_levels: None,
            source: "arcgis".to_string(),
            format: format.to_string(),
            proxy: None,
            crop_to_shape: false,
            polygon: None,
            tianditu_token: None,
            save_path: Some(save_path.to_string_lossy().into_owned()),
            concurrency: 30,
            compression: "lzw".to_string(),
            build_pyramid: false,
            generate_sidecars: false,
            overlay_sources: None,
        }
    }

    #[test]
    fn old_task_json_without_work_dir_remains_compatible() {
        let json = r#"{
            "task_id": "legacy-task",
            "task_name": "legacy",
            "source_name": "ArcGIS",
            "request": {
                "bounds": {"north": 40.0, "south": 39.0, "east": 117.0, "west": 116.0},
                "zoom": 10,
                "source": "arcgis",
                "format": "geotiff",
                "save_path": "D:\\downloads\\legacy.tif",
                "concurrency": 30,
                "compression": "lzw"
            },
            "tile_count": 100,
            "created_at": "2026-07-28 10:00:00"
        }"#;

        let task: PersistedTask = serde_json::from_str(json).unwrap();
        assert!(task.work_dir.is_none());
    }

    #[test]
    fn loader_keeps_task_when_work_dir_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("output").join("map.tif");
        let task = PersistedTask {
            task_id: "recoverable-task".to_string(),
            task_name: "recoverable".to_string(),
            source_name: "ArcGIS".to_string(),
            request: request("geotiff", &output),
            tile_count: 100,
            created_at: "2026-07-28 10:00:00".to_string(),
            work_dir: Some(
                dir.path()
                    .join("missing")
                    .join(".geod-work")
                    .join("recoverable-task")
                    .to_string_lossy()
                    .into_owned(),
            ),
        };
        let task_file = dir.path().join("recoverable-task.json");
        std::fs::write(&task_file, serde_json::to_vec(&task).unwrap()).unwrap();

        let loaded = load_resumable_tasks_from(dir.path());

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].task_id, "recoverable-task");
        assert!(task_file.exists());
    }

    #[test]
    fn work_dir_is_next_to_output_for_all_formats() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("exports").join("map.tif");
        let image_request = request("geotiff", &output);
        let raw_request = request("tiles", &dir.path().join("tiles"));

        assert_eq!(
            task_work_dir("task-1", &image_request),
            Some(dir.path().join("exports").join(".geod-work").join("task-1"))
        );
        assert_eq!(
            task_work_dir("task-2", &raw_request),
            Some(dir.path().join(".geod-work").join("task-2"))
        );
    }
}
