//! 下载任务管理模块

use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
pub use crate::pause_control::PauseControl;
use tokio_util::sync::CancellationToken;

/// 任务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Preparing,
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
    pub created_at:String,
    pub name: String,
    pub source: String,
    pub source_name: String,
    pub zoom: u8,
    pub format: String,
    pub save_path: String,
    pub status: TaskStatus,
    pub can_retry: bool,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preparation: Option<PreparationProgress>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_diagnostics: Option<crate::tianditu_tokens::TokenDiagnostics>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreparationProgress { pub completed: u32, pub total: u32 }

/// 日志条目
#[derive(Debug, Clone, Serialize)]
pub struct TaskLog {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

/// 内部任务条目（包含取消令牌）
struct TaskEntry {
    info: TaskInfo,
    cancel_token: CancellationToken,
    pause_control: PauseControl,
    logs: Vec<TaskLog>,
    waiting_for_batch: bool,
    token_pool: Option<Arc<crate::tianditu_tokens::TiandituTokens>>,
    log_writer: Option<Arc<Mutex<crate::task_log::TaskLogWriter>>>,
}

impl TaskEntry {
    fn freeze_diagnostics(&mut self) {
        if let Some(pool) = self.token_pool.take() {
            self.info.download_diagnostics = Some(pool.diagnostics());
        }
    }
}

/// Shared by all tasks submitted from the same batch dialog and persisted for retry.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchOptions {
    pub id: String,
    pub limit: usize,
}

pub(crate) struct BatchSlots {
    limit: usize,
    permits: tokio::sync::Semaphore,
}

impl BatchSlots {
    pub(crate) async fn enter(
        &self,
        cancel: &CancellationToken,
        pause: &PauseControl,
    ) -> Result<tokio::sync::SemaphorePermit<'_>, String> {
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("任务已取消".into()),
                _ = pause.wait_if_paused() => {}
            }
            let permit = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("任务已取消".into()),
                result = self.permits.acquire() => result.map_err(|_| "批量队列已关闭")?,
            };
            if !pause.is_paused() {
                return Ok(permit);
            }
        }
    }
}

/// 全局任务管理器
pub struct TaskManager {
    tasks: Arc<Mutex<HashMap<String, TaskEntry>>>,
    task_operations: Mutex<HashSet<String>>,
    interrupted_cards: Mutex<HashMap<PathBuf, CachedCard>>,
    batch_slots: Mutex<HashMap<String, std::sync::Weak<BatchSlots>>>,
    log_dir: PathBuf,
    event_sink: Mutex<Option<Arc<dyn Fn(TaskInfo) + Send + Sync>>>,
    revision: std::sync::atomic::AtomicU64,
}

pub(crate) struct TaskOperation<'a> {
    operations: &'a Mutex<HashSet<String>>,
    task_id: String,
}

impl Drop for TaskOperation<'_> {
    fn drop(&mut self) {
        self.operations.lock().unwrap().remove(&self.task_id);
    }
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
            task_operations: Mutex::new(HashSet::new()),
            interrupted_cards: Mutex::new(HashMap::new()),
            batch_slots: Mutex::new(HashMap::new()),
            log_dir,
            event_sink: Mutex::new(None),
            revision: std::sync::atomic::AtomicU64::new(1),
        }
    }

    pub(crate) fn slots_for_batch(
        &self,
        batch: Option<&BatchOptions>,
    ) -> Result<Option<Arc<BatchSlots>>, String> {
        let Some(batch) = batch else { return Ok(None) };
        if uuid::Uuid::parse_str(&batch.id).is_err() || !(1..=8).contains(&batch.limit) {
            return Err("批量任务参数无效".into());
        }
        let mut batches = self.batch_slots.lock().unwrap();
        if let Some(slots) = batches.get(&batch.id).and_then(std::sync::Weak::upgrade) {
            if slots.limit != batch.limit {
                return Err("同一批任务的并发数不一致".into());
            }
            return Ok(Some(slots));
        }
        batches.retain(|_, slots| slots.strong_count() > 0);
        let slots = Arc::new(BatchSlots {
            limit: batch.limit,
            permits: tokio::sync::Semaphore::new(batch.limit),
        });
        batches.insert(batch.id.clone(), Arc::downgrade(&slots));
        Ok(Some(slots))
    }

    pub(crate) fn set_batch_waiting(&self, id: &str, waiting: bool) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            entry.waiting_for_batch = waiting;
            if entry.info.status == TaskStatus::Pending {
                entry.info.message = waiting.then(|| "BATCH_TASK_QUEUED".to_owned());
            }
        }
        self.notify_changed(id);
    }

    /// Reserve the task through status checks and disk changes.
    pub(crate) fn begin_task_operation(&self, id: &str) -> Result<TaskOperation<'_>, String> {
        if !self.task_operations.lock().unwrap().insert(id.to_owned()) {
            return Err("正在处理该任务，请稍后重试".into());
        }
        Ok(TaskOperation {
            operations: &self.task_operations,
            task_id: id.to_owned(),
        })
    }

    pub(crate) fn task_status(&self, id: &str) -> Option<TaskStatus> {
        self.tasks
            .lock()
            .unwrap()
            .get(id)
            .map(|entry| entry.info.status.clone())
    }

    pub fn set_event_sink(&self, sink: Arc<dyn Fn(TaskInfo) + Send + Sync>) {
        *self.event_sink.lock().unwrap() = Some(sink);
    }
    fn notify_changed(&self, id: &str) {
        let snapshot = {
            let mut tasks = self.tasks.lock().unwrap();
            let Some(entry) = tasks.get_mut(id) else { return };
            entry.info.revision = self.revision.fetch_add(1, Ordering::Relaxed);
            let mut snapshot=entry.info.clone();
            if let Some(pool)=entry.token_pool.as_ref(){snapshot.download_diagnostics=Some(pool.diagnostics());}
            snapshot
        };
        let sink = self.event_sink.lock().unwrap().clone();
        if matches!(snapshot.status,TaskStatus::Completed|TaskStatus::CompletedWithGaps|TaskStatus::Failed|TaskStatus::Cancelled){
            if let Some(value)=snapshot.download_diagnostics.as_ref(){
                if id.len()<=96&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'){
                    let folder=self.log_dir.join("diagnostics");
                    if std::fs::create_dir_all(&folder).is_ok(){if let Ok(bytes)=serde_json::to_vec_pretty(&value.acquisition){let _=crate::fs_util::atomic_write(&folder.join(format!("{id}.json")),&bytes);}}
                    if let Some(execution)=value.execution.as_ref() {
                        if let Ok(bytes)=serde_json::to_vec_pretty(execution) {let _=crate::fs_util::atomic_write(&folder.join(format!("{id}.execution.json")),&bytes);}
                    }
                }
            }
        }
        if let Some(sink) = sink { sink(snapshot); }
    }
    pub fn update_preparation(&self, id: &str, completed: u32, total: u32) {
        {
            let mut tasks = self.tasks.lock().unwrap();
            let Some(entry) = tasks.get_mut(id) else { return };
            if matches!(entry.info.status, TaskStatus::Cancelled | TaskStatus::Completed | TaskStatus::CompletedWithGaps | TaskStatus::Failed) { return; }
            entry.info.status = if entry.pause_control.is_paused() { TaskStatus::Paused } else { TaskStatus::Preparing };
            entry.info.preparation = Some(PreparationProgress { completed, total });
            entry.info.progress = if total > 0 { completed as f64 / total as f64 * 10.0 } else { 0.0 };
            entry.info.message = Some(format!("准备历史影像索引 {completed}/{total}"));
        }
        self.notify_changed(id);
    }
    pub fn set_task_source(&self, id: &str, source: String) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) { entry.info.source = source; }
        self.notify_changed(id);
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
            created_at:chrono::Utc::now().to_rfc3339(),
            id: id.clone(),
            name,
            source,
            source_name,
            zoom,
            format,
            save_path,
            status: TaskStatus::Pending,
            can_retry: false,
            revision: 0,
            preparation: None,
            progress: 0.0,
            completed: 0,
            total,
            failed_count: 0,
            success_count: 0,
            file_size: 0,
            message: None,
            error: None,
            download_diagnostics: None,
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
            waiting_for_batch: false,
            token_pool: None,
            log_writer,
        };
        self.tasks.lock().unwrap().insert(id.clone(), entry);
        self.notify_changed(&id);
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
                && matches!(status, TaskStatus::Pending | TaskStatus::Preparing | TaskStatus::Downloading)
            {
                TaskStatus::Paused
            } else {
                status
            };
            entry.info.progress = progress;
            entry.info.preparation = None;
            entry.info.completed = completed;
            entry.info.failed_count = failed_count;
            // Issue #31：success_count 自动推算，避免调用方分散维护
            entry.info.success_count = completed.saturating_sub(failed_count);
            entry.info.message = message;
        }
        self.notify_changed(id);
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
            if let Some(pool)=entry.token_pool.as_ref(){pool.record_completed();}
            entry.freeze_diagnostics();
            entry.info.progress = 100.0;
            entry.info.file_size = file_size;
            entry.info.message = Some("完成".to_string());
        }
        self.notify_changed(id);
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
            entry.freeze_diagnostics();
            entry.info.progress = 100.0;
            entry.info.file_size = file_size;
            entry.info.failed_count = failed_count;
            entry.info.message = Some(format!("完成但有 {} 张缺块", failed_count));
        }
        self.notify_changed(id);
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
        self.notify_changed(id);
    }

    /// 标记任务失败
    pub fn fail_task(&self, id: &str, error: String) {
        let can_retry = load_task_file(id).is_some_and(|task| task.task_id == id);
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
            entry.info.can_retry = can_retry;
            if let Some(pool)=entry.token_pool.as_ref(){pool.record_failure(&error);}
            entry.freeze_diagnostics();
            entry.info.error = Some(error);
        }
        self.notify_changed(id);
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
            entry.freeze_diagnostics();
            entry.info.message = Some("已取消".to_string());
        }
        self.notify_changed(id);
    }

    /// 暂停/恢复任务，返回 (成功, 当前是否暂停)
    pub fn toggle_pause(&self, id: &str) -> (bool, bool) {
        let result = if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            if !matches!(
                entry.info.status,
                TaskStatus::Pending | TaskStatus::Preparing | TaskStatus::Downloading | TaskStatus::Paused
            ) {
                return (false, false);
            }
            let is_paused = entry.pause_control.is_paused();
            if is_paused {
                // 恢复
                entry.pause_control.flag.store(false, Ordering::Relaxed);
                entry.pause_control.notify.notify_waiters();
                entry.info.status = if entry.waiting_for_batch { TaskStatus::Pending }
                    else if entry.info.preparation.is_some() { TaskStatus::Preparing } else { TaskStatus::Downloading };
                entry.info.message = Some(if entry.waiting_for_batch { "BATCH_TASK_QUEUED" } else { "已恢复下载" }.into());
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
        };
        self.notify_changed(id);
        result
    }

    /// 获取所有任务信息
    pub fn attach_token_diagnostics(&self, id: &str, pool: Arc<crate::tianditu_tokens::TiandituTokens>) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            entry.info.download_diagnostics = None;
            entry.token_pool = Some(pool);
        }
    }

    pub fn set_execution_diagnostic(&self,id:&str,diagnostic:crate::execution_diagnostic::ExecutionDiagnostic) {
        if let Some(entry)=self.tasks.lock().unwrap().get_mut(id) {
            if !matches!(entry.info.status,TaskStatus::Completed|TaskStatus::CompletedWithGaps|TaskStatus::Failed|TaskStatus::Cancelled) {
                entry.info.download_diagnostics=Some(crate::tianditu_tokens::TokenDiagnostics::execution_only(diagnostic));
            }
        }
    }

    pub fn resumable_tasks(&self) -> Vec<ResumableSummary> {
        let registered_ids = self.tasks.lock().unwrap().keys().cloned().collect();
        self.interrupted_cards_in(&tasks_dir(), &registered_ids)
    }

    fn interrupted_cards_in(
        &self,
        dir: &Path,
        registered: &HashSet<String>,
    ) -> Vec<ResumableSummary> {
        // A slow volume can delay another list operation without holding the live task lock.
        let mut cache = self.interrupted_cards.lock().unwrap();
        let mut previous = std::mem::take(&mut *cache);
        let mut cards = Vec::new();
        for path in persisted_paths(dir, registered) {
            let stamp = std::fs::metadata(&path)
                .ok()
                .and_then(|m| Some((m.modified().ok()?, m.len())));
            let cached = previous
                .remove(&path)
                .filter(|c| stamp.is_some() && c.stamp == stamp);
            let card = cached.or_else(|| {
                let file = std::fs::File::open(&path).ok()?;
                let info = serde_json::from_reader(std::io::BufReader::new(file)).ok()?;
                Some(CachedCard { stamp, info })
            });
            if let Some(card) = card {
                cards.push(card.info.clone());
                cache.insert(path, card);
            }
        }
        cards
    }

    pub fn get_all_tasks(&self) -> Vec<TaskInfo> {
        self.tasks
            .lock()
            .unwrap()
            .values()
            .map(|e| {
                let mut info = e.info.clone();
                if let Some(pool) = e.token_pool.as_ref() { info.download_diagnostics = Some(pool.diagnostics()); }
                info
            })
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
    pub fn remove_finished(&self, id: &str) -> bool {
        let mut tasks = self.tasks.lock().unwrap();
        if tasks.get(id).is_some_and(|entry| {
            matches!(
                entry.info.status,
                TaskStatus::Completed
                    | TaskStatus::CompletedWithGaps
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
            )
        }) {
            tasks.remove(id);
            true
        } else {
            false
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

#[cfg(test)]
mod execution_snapshot_tests {
    use super::*;
    #[test]
    fn osm_terminal_snapshot_and_sidecar_keep_execution_without_claiming_token_exhaustion() {
        let dir=tempfile::tempdir().unwrap();let manager=TaskManager::new_with_log_dir(dir.path().into());
        manager.create_task("exec-task".into(),"OSM".into(),"osm_vector".into(),"OSM".into(),0,"geojson".into(),"out.geojson".into(),0);
        let value=crate::execution_diagnostic::ExecutionDiagnostic {version:1,scheduler:None,overpass:Some(crate::execution_diagnostic::OverpassDiagnostic {queue_wait_ms:Some(30),..Default::default()})};
        manager.set_execution_diagnostic("exec-task",value.clone());
        manager.fail_task("exec-task","OSM_SERVICE_UNAVAILABLE: network".into());
        let d=manager.get_all_tasks().remove(0).download_diagnostics.unwrap();
        assert!(!d.tokens_exhausted);assert_eq!(d.configured_tokens,0);
        assert_eq!(d.execution.unwrap().overpass.unwrap().queue_wait_ms,Some(30));
        assert!(dir.path().join("diagnostics/exec-task.execution.json").is_file());
        let mut late=value;late.overpass.as_mut().unwrap().queue_wait_ms=Some(99);
        manager.set_execution_diagnostic("exec-task",late);
        assert_eq!(manager.get_all_tasks().remove(0).download_diagnostics.unwrap().execution.unwrap().overpass.unwrap().queue_wait_ms,Some(30));
    }
}

fn task_id_prefix(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn queued_batch_tasks_can_pause_and_cancel_without_blocking_others() {
        let dir = tempfile::tempdir().unwrap();
        let manager = TaskManager::new_with_log_dir(dir.path().into());
        let batch = BatchOptions { id: uuid::Uuid::new_v4().to_string(), limit: 1 };
        let slots = manager.slots_for_batch(Some(&batch)).unwrap().unwrap();
        let incompatible = BatchOptions { limit: 2, ..batch.clone() };
        assert!(manager.slots_for_batch(Some(&incompatible)).is_err());
        let cancel = CancellationToken::new();
        let running = slots.enter(&cancel, &PauseControl::new()).await.unwrap();
        let (queued_cancel, queued_pause) = manager.create_task(
            "queued".into(), "Queued".into(), "test".into(), "Test".into(), 1,
            "geotiff".into(), "output".into(), 1,
        );
        manager.set_batch_waiting("queued", true);
        let waiting = slots.enter(&queued_cancel, &queued_pause);
        tokio::pin!(waiting);
        assert!(futures::poll!(&mut waiting).is_pending());
        assert_eq!(manager.toggle_pause("queued"), (true, true));
        drop(running);
        assert!(futures::poll!(&mut waiting).is_pending());
        let other = slots.permits.try_acquire().expect("paused worker must release its slot");
        assert_eq!(manager.toggle_pause("queued"), (true, false));
        assert_eq!(manager.task_status("queued"), Some(TaskStatus::Pending));
        assert!(futures::poll!(&mut waiting).is_pending());
        manager.cancel_task("queued");
        assert!(waiting.await.is_err());
        drop(other);
        assert_eq!(slots.permits.available_permits(), 1);
    }

    #[test]
    fn running_retry_cannot_be_removed_and_blocks_other_task_operations() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TaskManager::new_with_log_dir(directory.path().into());
        let id = uuid::Uuid::new_v4().to_string();
        let create = || {
            manager.create_task(
                id.clone(), "Test".into(), "tiles".into(), "Tiles".into(),
                1, "tiles".into(), "output".into(), 1,
            );
        };
        create();
        manager.fail_task(&id, "test failure".into());
        assert_eq!(manager.task_status(&id), Some(TaskStatus::Failed));

        let retry = manager.begin_task_operation(&id).unwrap();
        assert!(manager.begin_task_operation(&id).is_err());
        assert!(manager.begin_task_operation("another-task").is_ok());
        create();
        drop(retry);

        let remove = manager.begin_task_operation(&id).unwrap();
        assert!(!manager.remove_finished(&id));
        assert_eq!(manager.task_status(&id), Some(TaskStatus::Pending));
        manager.complete_task(&id, 256);
        assert!(manager.remove_finished(&id));
        assert!(manager.task_status(&id).is_none());
        drop(remove);
        assert!(manager.begin_task_operation(&id).is_ok());
    }
    #[test]
    fn preparation_updates_are_visible_pauseable_and_revisioned_until_export_completion() {
        let directory=tempfile::tempdir().unwrap();
        let manager=TaskManager::new_with_log_dir(directory.path().to_owned());
        let frames=Arc::new(Mutex::new(Vec::new()));let captured=frames.clone();
        manager.set_event_sink(Arc::new(move|task|captured.lock().unwrap().push(task)));
        manager.create_task("progress".into(),"History".into(),"preview".into(),"Earth".into(),17,"geotiff".into(),"test.tif".into(),4);
        manager.update_preparation("progress",1,4);
        assert_eq!(manager.get_all_tasks()[0].progress,2.5);
        assert_eq!(manager.toggle_pause("progress"),(true,true));
        manager.update_preparation("progress",2,4);
        assert_eq!(manager.get_all_tasks()[0].status,TaskStatus::Paused);
        assert_eq!(manager.toggle_pause("progress"),(true,false));
        assert_eq!(manager.get_all_tasks()[0].status,TaskStatus::Preparing);
        manager.set_task_source("progress","frozen".into());
        manager.update_progress("progress",TaskStatus::Exporting,89.2,4,0,Some("Exporting".into()));
        assert!(manager.get_all_tasks()[0].preparation.is_none());
        manager.complete_task("progress",100);
        manager.update_preparation("progress",1,4);
        let frames=frames.lock().unwrap();
        assert!(frames.windows(2).all(|w|w[0].revision<w[1].revision));
        assert_eq!(frames.last().unwrap().status,TaskStatus::Completed);
        assert_eq!(frames.last().unwrap().source,"frozen");
        assert_eq!(frames.last().unwrap().progress,100.0);
    }
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
    fn task_polling_exposes_only_sanitized_token_counters() {
        let tmp = TempDir::new().unwrap();
        let manager = TaskManager::new_with_log_dir(tmp.path().to_path_buf());
        manager.create_task("task".into(), "name".into(), "source".into(), "source".into(), 1, "tiles".into(), "output".into(), 1);
        let pool = Arc::new(crate::tianditu_tokens::TiandituTokens::new(vec!["secret-token".into()], Arc::new(|_| {})));
        pool.set_stage("base_download", true);
        pool.record_request(&pool.current().unwrap());
        manager.attach_token_diagnostics("task", pool.clone());
        manager.fail_task("task", "failed".into());
        pool.set_stage("export", false); // Late work/settings updates cannot change a terminal receipt.
        let diagnostic = manager.get_all_tasks().remove(0).download_diagnostics.unwrap();
        assert_eq!(diagnostic.used_tokens, 1);
        assert_eq!(diagnostic.phase, "base_download");
        assert!(!serde_json::to_string(&diagnostic).unwrap().contains("secret-token"));
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

// Listing interrupted jobs only needs the card fields. Serde skips polygon
// coordinates and credentials without materializing or sending them to the UI.
#[derive(Clone, Deserialize, Serialize)]
pub struct ResumableSummary {
    task_id: String,
    task_name: String,
    source_name: String,
    request: ResumableZoom,
    tile_count: u32,
    created_at: String,
}

struct CachedCard {
    stamp: Option<(std::time::SystemTime, u64)>,
    info: ResumableSummary,
}

#[derive(Clone, Deserialize, Serialize)]
struct ResumableZoom { zoom: u8 }

/// 持久化的任务数据（用于崩溃后恢复）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedTask {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<BatchOptions>,
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

/// 加载所有已持久化的任务，包括当前进程内正在执行的任务。
pub fn load_resumable_tasks() -> Vec<PersistedTask> {
    load_resumable_tasks_from(&tasks_dir(), &HashSet::new())
}

fn load_resumable_tasks_from<T: serde::de::DeserializeOwned>(
    dir: &Path,
    registered_ids: &HashSet<String>,
) -> Vec<T> {
    persisted_paths(dir, registered_ids)
        .filter_map(|path| {
            let data = std::fs::read(path).ok()?;
            serde_json::from_slice(&data).ok()
        })
        .collect()
}

fn persisted_paths<'a>(
    dir: &Path,
    registered_ids: &'a HashSet<String>,
) -> impl Iterator<Item = PathBuf> + 'a {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(move |path| {
            path.extension().is_some_and(|e| e == "json")
                && path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|id| !registered_ids.contains(id))
        })
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

pub(crate) fn load_task_file(task_id: &str) -> Option<PersistedTask> {
    if task_id.is_empty() || !task_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
        return None;
    }
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
        assert!(task.batch.is_none());
    }

    #[test]
    fn interrupted_card_omits_large_boundaries_and_credentials() {
        let dir = tempfile::tempdir().unwrap();
        for (zoom, count) in [(15, 30_765_609), (14, 7_694_176)] {
            let input = serde_json::json!({"task_id":zoom.to_string(),"task_name":"region",
                "source_name":"Tianditu","request":{"zoom":zoom,"tianditu_token":"private",
                "polygon":[vec![[116.0,40.0];100_000]]},"tile_count":count,"created_at":"2026-11-11"});
            std::fs::write(dir.path().join(format!("{zoom}.json")), input.to_string()).unwrap();
        }
        let manager = TaskManager::new_with_log_dir(dir.path().join("logs"));
        let rows = manager.interrupted_cards_in(dir.path(), &HashSet::new());
        assert_eq!(rows.len(), 2);
        let json = serde_json::to_string(&rows).unwrap();
        assert!(json.len() < 500 && !json.contains("private") && !json.contains("polygon"));
        let started = std::time::Instant::now();
        assert_eq!(
            manager
                .interrupted_cards_in(dir.path(), &HashSet::new())
                .len(),
            2
        );
        eprintln!(
            "interrupted_rows=2 ipc_bytes={} cached_read_us={}",
            json.len(),
            started.elapsed().as_micros()
        );
        std::fs::remove_file(dir.path().join("15.json")).unwrap();
        assert_eq!(
            manager
                .interrupted_cards_in(dir.path(), &HashSet::new())
                .len(),
            1
        );
    }

    #[test]
    fn loader_keeps_task_when_work_dir_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("output").join("map.tif");
        let task = PersistedTask {
            batch: None,
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

        let loaded: Vec<PersistedTask> = load_resumable_tasks_from(dir.path(), &HashSet::new());
        assert!(load_resumable_tasks_from::<ResumableSummary>(dir.path(), &HashSet::from([task.task_id.clone()])).is_empty());

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
