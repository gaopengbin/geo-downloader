//! Debug-only acceptance wiring. Not registered by the product's IPC handler.
pub use crate::commands::DownloadRequest as NativeDownloadRequest;
use crate::task::TaskManager;
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Manager, State};
pub struct EvidenceRoot(pub PathBuf);
#[derive(Default)]
pub struct ProgressEvidence(pub std::sync::Mutex<Vec<crate::task::TaskInfo>>);
#[tauri::command]
pub fn qa_progress(evidence:State<'_,ProgressEvidence>)->Vec<crate::task::TaskInfo>{evidence.0.lock().unwrap().clone()}
#[tauri::command]
pub fn qa_root(root: State<'_, EvidenceRoot>) -> String {
    root.0.to_string_lossy().into_owned()
}
#[tauri::command]
pub async fn qa_create_task(
    app: AppHandle,
    tasks: State<'_, Arc<TaskManager>>,
    request: NativeDownloadRequest,
    pause_immediately: bool,
) -> Result<serde_json::Value, String> {
    let name = format!("Earth 对接实测 {}", request.source);
    let result = crate::commands::create_download_task(
        app.clone(),
        tasks,
        request,
        name,
        "Google Earth historical imagery".into(),
    )
    .await?;
    let paused = if pause_immediately {
        crate::commands::toggle_pause_task(
            app.clone(),
            app.state::<Arc<TaskManager>>(),
            result.task_id.clone(),
        )
    } else {
        false
    };
    Ok(serde_json::json!({"taskId":result.task_id,"pauseRequested":paused}))
}
#[tauri::command]
pub fn qa_tasks(tasks: State<'_, Arc<TaskManager>>) -> serde_json::Value {
    serde_json::to_value(tasks.get_all_tasks()).unwrap()
}
#[tauri::command]
pub fn qa_toggle(app: AppHandle, tasks: State<'_, Arc<TaskManager>>, task_id: String) -> bool {
    crate::commands::toggle_pause_task(app, tasks, task_id)
}
#[tauri::command]
pub fn qa_finish(
    app: AppHandle,
    root: State<'_, EvidenceRoot>,
    report: serde_json::Value,
) -> Result<(), String> {
    std::fs::write(
        root.0.join("native-ipc.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}
