// 核心模块
pub mod config;
pub mod tile;
pub mod downloader;
pub mod merger;
pub mod exporter;
pub mod admin;
pub mod history;
pub mod settings;
pub mod task;
pub mod streaming_tiff;
pub mod streaming_raster;
pub mod tiles3d;
pub mod wayback;
pub mod budget;

// Tauri commands
mod commands;

use std::sync::Arc;
use task::TaskManager;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(TaskManager::new()))
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Error)
                .level_for("wry", log::LevelFilter::Error)
                .build()
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_tile_sources,
            commands::get_builtin_sources,
            commands::estimate_download,
            commands::get_system_memory,
            // 任务管理
            commands::create_download_task,
            commands::get_active_tasks,
            commands::get_task_logs,
            commands::read_log_file,
            commands::get_log_dir,
            commands::probe_tile,
            commands::cancel_task,
            commands::toggle_pause_task,
            commands::remove_task,
            commands::get_resumable_tasks,
            commands::resume_task,
            commands::discard_resumable_task,
            // 行政区划
            commands::get_provinces,
            commands::get_cities,
            commands::get_districts,
            commands::get_admin_boundary,
            commands::geocode_search,
            // 历史记录
            commands::get_download_history,
            commands::add_download_record,
            commands::delete_download_record,
            commands::clear_download_history,
            commands::open_file_location,
            commands::open_file,
            // 设置
            commands::get_settings,
            commands::save_settings,
            // 矢量数据
            commands::create_osm_download_task,
            commands::download_osm_data,
            commands::download_admin_boundary_file,
            // 3D Tiles
            commands::analyze_3dtiles,
            commands::estimate_3dtiles,
            commands::create_3dtiles_task,
            commands::serve_local_tiles,
            commands::start_tile_proxy,
            // 历史影像
            commands::get_wayback_versions,
            commands::create_wayback_task,
            commands::probe_wayback_max_zoom,
            // 更新
            commands::download_and_install_update,
        ])
        .setup(|app| {
            // 启动时从用户设置同步 TLS 严格性开关（默认 false = 严格验证证书）
            if let Ok(sm) = settings::SettingsManager::new() {
                if let Ok(s) = sm.get() {
                    config::set_allow_invalid_certs(s.allow_invalid_certs);
                }
            }

            // 系统托盘右键菜单
            let show = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            // 创建托盘图标
            let tray_icon = app.default_window_icon().cloned().expect("no default icon");
            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("GeoDownloader")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // 窗口关闭时最小化到托盘而非退出
            let window = app.get_webview_window("main").unwrap();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(w) = tray.app_handle().get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
