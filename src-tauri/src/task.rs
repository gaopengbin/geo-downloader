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
            entry.info.status = status;
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
                // 同步删除持久化文件，防止应用退出时异步清理未完成导致下次启动变「已中断」
                remove_task_file(id);
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
            if !matches!(entry.info.status, TaskStatus::Downloading | TaskStatus::Paused) {
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
    let mut tasks = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "json") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(task) = serde_json::from_str::<PersistedTask>(&content) {
                        // 确认临时目录存在
                        let temp_dir = std::env::temp_dir().join(format!("tif-dl-{}", task.task_id));
                        if temp_dir.exists() {
                            tasks.push(task);
                        } else {
                            // 临时目录不存在，清理持久化文件
                            let _ = std::fs::remove_file(&path);
                        }
                    }
                }
            }
        }
    }
    tasks
}

/// 清理临时目录
pub fn cleanup_temp_dir(task_id: &str) {
    // 调试模式下保留临时目录
    if let Ok(mgr) = crate::settings::SettingsManager::new() {
        if let Ok(settings) = mgr.get() {
            if settings.debug_mode {
                let temp_dir = std::env::temp_dir().join(format!("tif-dl-{}", task_id));
                log::info!("[{}] 调试模式已启用，保留临时目录: {}（瓦片为图片文件，可改后缀 .png/.jpg 查看）", task_id, temp_dir.display());
                return;
            }
        }
    }
    let temp_dir = std::env::temp_dir().join(format!("tif-dl-{}", task_id));
    if temp_dir.exists() {
        log::info!("[{}] 清理临时目录: {}", task_id, temp_dir.display());
    }
    let _ = std::fs::remove_dir_all(temp_dir);
}
