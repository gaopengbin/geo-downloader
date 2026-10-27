#[cfg(debug_assertions)]
use app_lib::{earth_history_commands as earth, earth_history_qa as qa, task::TaskManager};
#[cfg(debug_assertions)]
use std::{path::PathBuf, sync::Arc};
#[cfg(debug_assertions)]
use tauri::Manager;
#[cfg(debug_assertions)]
fn main() {
    let output = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .expect("provide a new evidence directory");
    assert!(!output.exists(), "evidence directory must not exist");
    std::fs::create_dir_all(&output).unwrap();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows[0].visible = false;
    tauri::Builder::default()
        .manage(Arc::new(TaskManager::new()))
        .manage(qa::EvidenceRoot(output))
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.navigate("http://127.0.0.1:1426/tests/earth-native.html".parse()?)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            earth::earth_history_catalog,
            earth::earth_history_prepare,
            earth::earth_history_cancel,
            qa::qa_root,
            qa::qa_create_task,
            qa::qa_tasks,
            qa::qa_toggle,
            qa::qa_finish
        ])
        .run(context)
        .expect("native Earth acceptance failed");
}
#[cfg(not(debug_assertions))]
fn main() {
    panic!("Native acceptance is debug-only");
}
