// 核心模块
pub mod config;
pub mod tile;
pub mod downloader;
pub mod merger;
pub mod exporter;
pub mod admin;
pub mod history;
pub mod history_maintenance;
pub mod settings;
pub mod task;
pub mod task_log;
pub mod streaming_tiff;
pub mod streaming_raster;
pub mod pyramid;
pub mod tiles3d;
pub mod wayback;
pub mod wayback_metadata;
pub mod budget;
pub mod fs_util;
pub mod dem;
pub mod tile_cache;
pub mod tile_pack;
pub mod cache_migration;

// Tauri commands
mod commands;

use std::sync::Arc;
use task::TaskManager;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager, RunEvent, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("gdcache", |_ctx, request| {
            // 解析 gdcache://localhost/<source>/<z>/<x>/<y>[.ext]
            let uri = request.uri().to_string();
            let make_resp = |status: u16, body: Vec<u8>, mime: &str| {
                tauri::http::Response::builder()
                    .status(status)
                    .header("Content-Type", mime)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(body)
                    .unwrap_or_else(|_| {
                        tauri::http::Response::builder()
                            .status(500)
                            .body(Vec::new())
                            .expect("response")
                    })
            };
            let parsed = match tile_cache::parse_gdcache_uri(&uri) {
                Some(v) => v,
                None => return make_resp(400, b"bad request".to_vec(), "text/plain"),
            };
            let (source, z, x, y) = parsed;
            let key = tile_cache::SourceKey::new(source);
            let coord = tile_cache::TileCoord { z, x, y };
            match tile_cache::Store::global().get(&key, coord) {
                Ok(Some(stored)) => {
                    let mime = if stored.content_type.is_empty() {
                        "image/png".to_string()
                    } else {
                        stored.content_type
                    };
                    make_resp(200, stored.bytes, &mime)
                }
                _ => make_resp(404, Vec::new(), "text/plain"),
            }
        })
        .manage(Arc::new(TaskManager::new()))
        .manage(Arc::new(cache_migration::CacheMigrationManager::new()))
        .manage(wayback_metadata::new_progress_map())
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
            commands::export_partial_task,
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
            commands::build_pyramid_for_file,
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
            commands::scan_wayback_metadata,
            commands::get_wayback_scan_progress,
            commands::download_wayback_incremental,
            // 更新
            commands::get_update_info,
            commands::download_and_install_update,
            // 瓦片缓存
            commands::cache_get_tile,
            commands::cache_put_tile,
            commands::fetch_and_cache_tile,
            commands::cache_stats,
            commands::cache_clear,
            commands::cache_set_max_size_mb,
            commands::cache_set_dir,
            commands::cache_set_enabled,
            cache_migration::cache_migration_preflight,
            cache_migration::cache_migration_start,
            cache_migration::cache_migration_status,
            cache_migration::cache_migration_cancel,
            cache_migration::cache_migration_cleanup_staging,
            cache_migration::cache_migration_delete_source,
        ])
        .setup(|app| {
            // 启动时从用户设置同步 TLS 严格性开关（默认 false = 严格验证证书）
            if let Ok(sm) = settings::SettingsManager::new() {
                if let Ok(s) = sm.get() {
                    config::set_allow_invalid_certs(s.allow_invalid_certs);
                    // 同步瓦片缓存配置
                    tile_cache::set_enabled(s.tile_cache_enabled);
                    if let Some(dir) = s.tile_cache_dir.as_ref().filter(|d| !d.trim().is_empty()) {
                        tile_cache::set_root_dir(std::path::PathBuf::from(dir));
                    }
                    tile_cache::set_max_total_bytes(
                        s.tile_cache_max_size_mb.saturating_mul(1024 * 1024),
                    );
                }
            }

            // 启动时异步清理上次运行残留的 tif-dl-* 临时目录（仅清 >24h 老的，
            // 避免误删用户当前还在用的"完成但有缺块（CompletedWithGaps）"任务的 temp）
            std::thread::spawn(|| {
                let temp_root = std::env::temp_dir();
                let rd = match std::fs::read_dir(&temp_root) {
                    Ok(rd) => rd,
                    Err(_) => return,
                };
                let now = std::time::SystemTime::now();
                let mut cleaned = 0u32;
                for entry in rd.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if !name_str.starts_with("tif-dl-") {
                        continue;
                    }
                    let md = match entry.metadata() {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    if !md.is_dir() {
                        continue;
                    }
                    let too_old = md.modified().ok().and_then(|mtime| {
                        now.duration_since(mtime).ok().map(|d| d.as_secs() > 86400)
                    }).unwrap_or(false);
                    if too_old {
                        if std::fs::remove_dir_all(entry.path()).is_ok() {
                            cleaned += 1;
                        }
                    }
                }
                if cleaned > 0 {
                    log::info!("[startup] 清理了 {} 个 >24h 的孤儿临时目录 (tif-dl-*)", cleaned);
                }
            });

            let task_manager = app.state::<Arc<TaskManager>>().inner().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(30));
                loop {
                    match history::HistoryStore::global() {
                        Ok(store) => {
                            let active = task_manager.active_log_paths();
                            let log_dir = task_manager.log_dir_path();
                            match history_maintenance::run_batch(
                                store,
                                &log_dir,
                                &active,
                                history_maintenance::DEFAULT_BATCH_SIZE,
                            ) {
                                Ok(report) if report.compressed > 0
                                    || report.expired > 0
                                    || report.orphans_removed > 0 =>
                                {
                                    log::info!(
                                        "日志维护完成: 压缩 {}, 过期 {}, 孤儿 {}",
                                        report.compressed,
                                        report.expired,
                                        report.orphans_removed
                                    );
                                }
                                Ok(_) => {}
                                Err(error) => log::warn!("日志维护失败: {error}"),
                            }
                        }
                        Err(error) => log::warn!("历史数据库不可用，跳过日志维护: {error}"),
                    }
                    std::thread::sleep(std::time::Duration::from_secs(30 * 60));
                }
            });

            // 系统托盘右键菜单
            let show = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
            let migration_manager = app
                .state::<Arc<cache_migration::CacheMigrationManager>>()
                .inner()
                .clone();

            // 创建托盘图标
            let tray_icon = app.default_window_icon().cloned().expect("no default icon");
            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("GeoDownloader")
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            if migration_manager.has_active_migration() {
                                let app = app.clone();
                                let manager = migration_manager.clone();
                                std::thread::spawn(move || {
                                    manager.cancel_and_wait();
                                    app.exit(0);
                                });
                            } else {
                                app.exit(0);
                            }
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 进程真正退出前 checkpoint 并关闭所有 mbtiles 连接，避免 -wal/-shm 残留
            if let RunEvent::Exit = event {
                tile_cache::Store::global().shutdown();
            }
        });
}
