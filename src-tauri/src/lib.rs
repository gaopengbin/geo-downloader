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

// Tauri commands
mod commands;

use std::sync::Arc;
use task::TaskManager;

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
        .invoke_handler(tauri::generate_handler![
            commands::get_tile_sources,
            commands::estimate_download,
            // 任务管理
            commands::create_download_task,
            commands::get_active_tasks,
            commands::cancel_task,
            commands::remove_task,
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
            // 更新
            commands::download_and_install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
