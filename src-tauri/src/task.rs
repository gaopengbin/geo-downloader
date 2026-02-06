//! 下载任务管理模块

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// 任务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Downloading,
    Merging,
    Exporting,
    Completed,
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
    pub file_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 内部任务条目（包含取消令牌）
struct TaskEntry {
    info: TaskInfo,
    cancel_token: CancellationToken,
}

/// 全局任务管理器
pub struct TaskManager {
    tasks: Arc<Mutex<HashMap<String, TaskEntry>>>,
}

impl TaskManager {
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
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
    ) -> CancellationToken {
        let cancel_token = CancellationToken::new();
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
            file_size: 0,
            message: None,
            error: None,
        };
        let entry = TaskEntry {
            info,
            cancel_token: cancel_token.clone(),
        };
        self.tasks.lock().unwrap().insert(id, entry);
        cancel_token
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
            entry.info.status = status;
            entry.info.progress = progress;
            entry.info.completed = completed;
            entry.info.failed_count = failed_count;
            entry.info.message = message;
        }
    }

    /// 标记任务完成
    pub fn complete_task(&self, id: &str, file_size: u64) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            entry.info.status = TaskStatus::Completed;
            entry.info.progress = 100.0;
            entry.info.file_size = file_size;
            entry.info.message = Some("完成".to_string());
        }
    }

    /// 标记任务失败
    pub fn fail_task(&self, id: &str, error: String) {
        if let Some(entry) = self.tasks.lock().unwrap().get_mut(id) {
            entry.info.status = TaskStatus::Failed;
            entry.info.error = Some(error);
        }
    }

    /// 取消任务
    pub fn cancel_task(&self, id: &str) -> bool {
        if let Some(entry) = self.tasks.lock().unwrap().get(id) {
            if entry.info.status != TaskStatus::Completed
                && entry.info.status != TaskStatus::Failed
                && entry.info.status != TaskStatus::Cancelled
            {
                entry.cancel_token.cancel();
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

    /// 获取所有任务信息
    pub fn get_all_tasks(&self) -> Vec<TaskInfo> {
        self.tasks
            .lock()
            .unwrap()
            .values()
            .map(|e| e.info.clone())
            .collect()
    }

    /// 移除已完成/失败/取消的任务
    pub fn remove_finished(&self, id: &str) {
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(entry) = tasks.get(id) {
            if matches!(
                entry.info.status,
                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
            ) {
                tasks.remove(id);
            }
        }
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
