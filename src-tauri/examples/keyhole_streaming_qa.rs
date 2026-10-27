#[cfg(debug_assertions)]
fn main() {
    use app_lib::{
        commands, earth_history_commands as earth, earth_history_qa as qa, task::TaskManager,
    };
    use std::{path::PathBuf, sync::Arc};
    use tauri::{Manager,Emitter};
    let output = PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("new output directory required"),
    );
    assert!(!output.exists());
    std::fs::create_dir_all(&output).unwrap();
    let trace_path=output.join("task-progress.jsonl");
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows[0].visible = false;
    context.config_mut().identifier = "dev.geo-downloader.keyhole-release-3618-qa".into();
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("keyhole", |_ctx, request, responder| {
            let uri = request.uri().to_string();
            tauri::async_runtime::spawn(async move {
                responder.respond(earth::keyhole_response(&uri).await);
            });
        })
        .manage(Arc::new(TaskManager::new()))
        .manage(qa::EvidenceRoot(output))
        .manage(qa::ProgressEvidence::default())
        .setup(move|app| {
            let events=app.handle().clone();
            let manager=app.state::<Arc<TaskManager>>().inner().clone();
            let pause_manager=manager.clone();
            let hold=std::sync::atomic::AtomicBool::new(true);
            manager.set_event_sink(Arc::new(move|snapshot|{
                { use std::io::Write;
                  let evidence=events.state::<qa::ProgressEvidence>();let mut frames=evidence.0.lock().unwrap();frames.push(snapshot.clone());
                  if let Ok(mut f)=std::fs::OpenOptions::new().create(true).append(true).open(&trace_path){let mut bytes=serde_json::to_vec(&snapshot).unwrap();bytes.push(b'\n');let _=f.write_all(&bytes);}
                }
                if snapshot.status==app_lib::task::TaskStatus::Preparing && snapshot.preparation.as_ref().is_some_and(|p|p.completed==1) && hold.swap(false,std::sync::atomic::Ordering::Relaxed){pause_manager.toggle_pause(&snapshot.id);}
                let _=events.emit("task-updated",snapshot);
            }));
            app.get_webview_window("main")
                .unwrap()
                .navigate(format!("http://127.0.0.1:1428/tests/keyhole-native.html?run={}",uuid::Uuid::new_v4()).parse()?)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            earth::keyhole_history_dates,
            earth::keyhole_history_session,
            earth::keyhole_history_plan,
            earth::keyhole_history_status,
            earth::earth_history_cancel,
            commands::get_settings,
            commands::get_tile_sources,
            commands::get_provinces,
            commands::get_cities,
            commands::get_districts,
            commands::get_admin_boundary,
            commands::create_download_task,
            commands::get_active_tasks,
            qa::qa_progress,
            qa::qa_toggle,
            qa::qa_root,
            qa::qa_create_task,
            qa::qa_tasks,
            qa::qa_finish
        ])
        .run(context)
        .expect("hidden Keyhole acceptance failed");
}
#[cfg(not(debug_assertions))]
fn main() {
    panic!("debug-only native acceptance")
}
