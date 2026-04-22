//! Tauri commands 模块

use crate::budget::{self, FormatClass};
use crate::config::{self, TileSource};
use crate::tile::{self, Bounds};
use crate::downloader::TileDownloader;
use crate::merger;
use crate::exporter::{self, ExportFormat};
use crate::streaming_tiff;
use crate::streaming_raster;
use crate::pyramid;
use crate::admin::{self, AdminRegion, GeocodeResult};
use crate::history::{DownloadRecord, DownloadStatus, HistoryManager};
use crate::settings::{AppSettings, SettingsManager};
use crate::task::{TaskManager, TaskInfo, TaskLog, TaskStatus, PersistedTask, PauseControl};
use crate::tiles3d;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// 下载请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadRequest {
    pub bounds: Bounds,
    pub zoom: u8,
    pub source: String,
    pub format: String,
    #[serde(default)]
    pub proxy: Option<String>,
    #[serde(default)]
    pub crop_to_shape: bool,
    /// 多边形列表（支持 MultiPolygon：多个不连续的面）
    #[serde(default)]
    pub polygon: Option<Vec<Vec<PolygonCoord>>>,
    #[serde(default)]
    pub tianditu_token: Option<String>,
    /// 保存路径 (如果提供，直接保存到文件)
    #[serde(default)]
    pub save_path: Option<String>,
    /// 并发数 (10-100, 默认30)
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    /// TIFF 压缩方式: "none", "lzw", "deflate"（默认 "lzw"）
    #[serde(default = "default_compression")]
    pub compression: String,
    /// 导出 GeoTIFF 后是否构建内置金字塔（Overview Layers）
    #[serde(default)]
    pub build_pyramid: bool,
}

fn default_concurrency() -> usize {
    30
}

fn default_compression() -> String {
    "lzw".to_string()
}

/// 多边形坐标
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolygonCoord {
    pub lat: f64,
    pub lng: f64,
}

/// 下载估算结果
#[derive(Debug, Clone, Serialize)]
pub struct EstimateResult {
    pub tile_count: u32,
    pub cols: u32,
    pub rows: u32,
    pub estimated_size_mb: f64,
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    /// 内存预算检查结果（前端可据此展示提示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_check: Option<budget::BudgetCheckResult>,
    /// GeoTIFF 未压缩原始大小（MB），用于提示用户实际文件大小
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_size_mb: Option<f64>,
    /// 大小说明（如压缩效率提示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_note: Option<String>,
}


/// 将 CustomTileSource 转换为 TileSource
fn custom_to_tile_source(cs: &crate::settings::CustomTileSource, attribution: &str) -> TileSource {
    let subdomains: Vec<String> = if cs.subdomains.is_empty() {
        vec![]
    } else {
        cs.subdomains.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    TileSource {
        id: cs.id.clone(),
        name: cs.name.clone(),
        url: cs.url.clone(),
        subdomains,
        max_zoom: cs.max_zoom,
        attribution: attribution.to_string(),
    }
}

/// 获取瓦片图源列表（内置 + 覆盖 + 自定义）
#[tauri::command]
pub fn get_tile_sources(tianditu_token: Option<String>) -> HashMap<String, TileSource> {
    let mut sources = config::get_tile_sources(tianditu_token.as_deref());
    
    if let Ok(manager) = SettingsManager::new() {
        if let Ok(settings) = manager.get() {
            // 应用内置图源覆盖配置
            for ovr in &settings.source_overrides {
                let attr = sources.get(&ovr.id)
                    .map(|s| s.attribution.clone())
                    .unwrap_or_default();
                sources.insert(ovr.id.clone(), custom_to_tile_source(ovr, &attr));
            }
            
            // 合并自定义图源
            for cs in &settings.custom_sources {
                sources.insert(cs.id.clone(), custom_to_tile_source(cs, "自定义图源"));
            }
        }
    }
    
    sources
}

/// 获取内置图源原始默认配置（用于前端重置）
#[tauri::command]
pub fn get_builtin_sources(tianditu_token: Option<String>) -> HashMap<String, TileSource> {
    config::get_tile_sources(tianditu_token.as_deref())
}

/// 获取系统内存信息
#[tauri::command]
pub fn get_system_memory() -> Option<budget::SystemMemoryInfo> {
    budget::get_system_memory()
}

/// 估算下载大小
#[tauri::command]
pub fn estimate_download(bounds: Bounds, zoom: u8, format: Option<String>, crop_to_shape: Option<bool>) -> EstimateResult {
    let (_x_min, _y_min, _x_max, _y_max, cols, rows) = tile::get_tile_matrix_size(&bounds, zoom);
    let tile_count = cols * rows;
    let avg_tile_size_kb = 20.0;
    let estimated_size_mb = (tile_count as f64 * avg_tile_size_kb) / 1024.0;
    
    let max_tiles = 500_000u32;
    
    if tile_count > max_tiles {
        return EstimateResult {
            tile_count,
            cols,
            rows,
            estimated_size_mb,
            allowed: false,
            warning: Some(format!("区域过大（{} 个瓦片），超过 {} 个上限。请缩小区域或降低缩放级别。", tile_count, max_tiles)),
            budget_check: None,
            raw_size_mb: None,
            size_note: None,
        };
    }

    // 内存预算检查
    let fmt = format.as_deref().unwrap_or("geotiff");
    let has_crop = crop_to_shape.unwrap_or(false);
    let is_geotiff = ExportFormat::from_str(fmt) == ExportFormat::GeoTiff;

    // GeoTIFF 一律走流式路径（含裁剪），内存占用极低
    let format_class = if is_geotiff {
        FormatClass::StreamingTiff
    } else {
        FormatClass::RasterImage
    };

    let budget_mb = SettingsManager::new()
        .and_then(|m| m.get())
        .map(|s| s.memory_budget_mb)
        .unwrap_or(budget::DEFAULT_BUDGET_MB);

    let bc = budget::check_budget(cols, rows, format_class, has_crop, budget_mb);
    let budget_allowed = bc.allowed;
    let budget_check = Some(bc);

    if !budget_allowed {
        return EstimateResult {
            tile_count,
            cols,
            rows,
            estimated_size_mb,
            allowed: false,
            warning: Some("内存预算不足，请查看建议调整参数".to_string()),
            budget_check,
            raw_size_mb: None,
            size_note: None,
        };
    }

    // GeoTIFF 预估未压缩原始大小 + 说明
    let (raw_size_mb, size_note) = if is_geotiff {
        let raw = cols as f64 * rows as f64 * 256.0 * 256.0 * 3.0 / (1024.0 * 1024.0);
        let note = if raw > 100.0 {
            Some("卫星影像 LZW 压缩效率低，实际文件接近未压缩大小；矢量地图可压缩至 1/5~1/10".to_string())
        } else {
            None
        };
        (Some(raw), note)
    } else {
        (None, None)
    };

    EstimateResult {
        tile_count,
        cols,
        rows,
        estimated_size_mb,
        allowed: true,
        warning: None,
        budget_check,
        raw_size_mb,
        size_note,
    }
}

/// 创建下载任务的返回值
#[derive(Debug, Clone, Serialize)]
pub struct CreateTaskResult {
    pub task_id: String,
    pub tile_count: u32,
}

/// 创建下载任务（非阻塞，立即返回 task_id）
#[tauri::command]
pub async fn create_download_task(
    app: AppHandle,
    task_manager: State<'_, Arc<TaskManager>>,
    request: DownloadRequest,
    task_name: String,
    source_name: String,
) -> Result<CreateTaskResult, String> {
    let save_path = request.save_path.clone()
        .ok_or_else(|| "未指定保存路径".to_string())?;
    
    // 获取图源配置（包含覆盖 + 自定义图源）
    let sources = get_tile_sources(request.tianditu_token.clone());
    let source = sources.get(&request.source)
        .ok_or_else(|| format!("未知图源: {}", request.source))?.clone();
    
    // 估算瓦片数
    let tile_count = tile::estimate_tile_count(&request.bounds, request.zoom);
    
    // 生成任务 ID
    let task_id = uuid::Uuid::new_v4().to_string();
    
    // 持久化任务（用于断点续传）
    let persisted = PersistedTask {
        task_id: task_id.clone(),
        task_name: task_name.clone(),
        source_name: source_name.clone(),
        request: request.clone(),
        tile_count,
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    };
    crate::task::save_task_file(&persisted)?;
    
    // 注册任务
    let (cancel_token, pause_control) = task_manager.create_task(
        task_id.clone(),
        task_name.clone(),
        request.source.clone(),
        source_name.clone(),
        request.zoom,
        request.format.clone(),
        save_path.clone(),
        tile_count,
    );
    
    // spawn 后台任务
    let tm = Arc::clone(&task_manager);
    let tid = task_id.clone();
    // 保留用于失败时记录历史
    let req_source = request.source.clone();
    let req_zoom = request.zoom;
    let req_format = request.format.clone();
    
    tokio::spawn(async move {
        let result = execute_download_task(
            &app, &tm, &tid, &cancel_token, &pause_control,
            request, source, save_path.clone(),
            tile_count, &task_name, &source_name,
        ).await;
        
        match result {
            Ok(_) => {},
            Err(e) => {
                if tm.is_cancelled(&tid) {
                    task_log(&app, &tm, &tid, "WARN", "任务已取消");
                    crate::task::remove_task_file(&tid);
                    crate::task::cleanup_temp_dir(&tid);
                    tm.mark_cancelled(&tid);
                    let _ = app.emit(&format!("task-progress-{}", tid), TaskProgressPayload {
                        task_id: tid,
                        status: "cancelled".to_string(),
                        progress: 0.0,
                        completed: 0,
                        total: tile_count,
                        message: Some("已取消".to_string()),
                    });
                } else {
                    task_log(&app, &tm, &tid, "ERROR", &format!("任务失败: {}", e));
                    crate::task::remove_task_file(&tid);
                    crate::task::cleanup_temp_dir(&tid);
                    // 失败也记录到历史（failed_count=0 因为是整体失败而非逐瓦片失败）
                    let log_file_path = tm.get_log_file_path(&tid);
                    let record = DownloadRecord::new(
                        task_name.to_string(),
                        req_source.clone(),
                        source_name.to_string(),
                        req_zoom,
                        req_format.clone(),
                        save_path.clone(),
                        0,
                        tile_count,
                        0,
                        DownloadStatus::Failed,
                    ).with_log_file(log_file_path);
                    if let Ok(manager) = HistoryManager::new() {
                        let _ = manager.add(record);
                    }
                    tm.fail_task(&tid, e.clone());
                    let _ = app.emit(&format!("task-progress-{}", tid), TaskProgressPayload {
                        task_id: tid,
                        status: "failed".to_string(),
                        progress: 0.0,
                        completed: 0,
                        total: tile_count,
                        message: Some(format!("失败: {}", e)),
                    });
                }
            }
        }
    });
    
    Ok(CreateTaskResult { task_id, tile_count })
}

/// 任务进度事件负载
#[derive(Debug, Clone, Serialize)]
pub struct TaskProgressPayload {
    pub task_id: String,
    pub status: String,
    pub progress: f64,
    pub completed: u32,
    pub total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 任务日志辅助函数：追加日志 + emit 事件到前端
fn task_log(app: &AppHandle, tm: &Arc<TaskManager>, task_id: &str, level: &str, msg: &str) {
    if let Some(log) = tm.append_log(task_id, level, msg) {
        let _ = app.emit(&format!("task-log-{}", task_id), &log);
    }
}

/// 执行下载任务的核心逻辑
async fn execute_download_task(
    app: &AppHandle,
    tm: &Arc<TaskManager>,
    task_id: &str,
    cancel_token: &tokio_util::sync::CancellationToken,
    pause_control: &PauseControl,
    mut request: DownloadRequest,
    source: TileSource,
    save_path: String,
    _tile_count: u32,
    task_name: &str,
    source_name: &str,
) -> Result<(), String> {
    let event_name = format!("task-progress-{}", task_id);
    let start_time = std::time::Instant::now();

    // 矩形裁剪：用户画矩形时 polygon 为空，自动从 bounds 生成矩形多边形
    if request.crop_to_shape && request.polygon.is_none() {
        let b = &request.bounds;
        request.polygon = Some(vec![vec![
            PolygonCoord { lat: b.north, lng: b.west },
            PolygonCoord { lat: b.north, lng: b.east },
            PolygonCoord { lat: b.south, lng: b.east },
            PolygonCoord { lat: b.south, lng: b.west },
        ]]);
    }
    
    // 记录任务参数
    task_log(app, tm, task_id, "INFO", &format!("=== 任务开始: {} ===", task_name));
    task_log(app, tm, task_id, "INFO", &format!("图源: {} ({})", source_name, request.source));
    task_log(app, tm, task_id, "INFO", &format!("缩放级别: z{}", request.zoom));
    task_log(app, tm, task_id, "INFO", &format!("输出格式: {}", request.format));
    task_log(app, tm, task_id, "INFO", &format!("保存路径: {}", save_path));
    task_log(app, tm, task_id, "INFO", &format!("并发数: {}", request.concurrency));
    if request.crop_to_shape {
        task_log(app, tm, task_id, "INFO", "启用边界裁剪");
    }
    if request.compression != "none" {
        task_log(app, tm, task_id, "INFO", &format!("启用 {} 压缩", request.compression.to_uppercase()));
    }
    
    // 记录原始 bounds 坐标（便于问题诊断）
    let b = &request.bounds;
    task_log(app, tm, task_id, "INFO", &format!(
        "选区坐标: 北={:.8} 南={:.8} 东={:.8} 西={:.8}",
        b.north, b.south, b.east, b.west
    ));
    
    // bounds 有效性校验
    if b.north < b.south {
        task_log(app, tm, task_id, "WARN", &format!(
            "异常: 北纬({:.6}) < 南纬({:.6})，bounds 可能翻转", b.north, b.south
        ));
    }
    if b.east < b.west {
        task_log(app, tm, task_id, "WARN", &format!(
            "异常: 东经({:.6}) < 西经({:.6})，bounds 可能翻转", b.east, b.west
        ));
    }
    if b.north.abs() > 85.06 || b.south.abs() > 85.06 {
        task_log(app, tm, task_id, "WARN", &format!(
            "异常: 纬度超出 Web Mercator 范围 (±85.06°): N={:.6} S={:.6}", b.north, b.south
        ));
    }
    if b.east.abs() > 180.0 || b.west.abs() > 180.0 {
        task_log(app, tm, task_id, "WARN", &format!(
            "异常: 经度超出有效范围 (±180°): E={:.6} W={:.6}", b.east, b.west
        ));
    }
    
    // 获取瓦片列表
    let tiles = tile::get_tiles_in_bounds(&request.bounds, request.zoom);
    let actual_count = tiles.len() as u32;
    let (x_min, y_min, x_max, y_max, cols, rows) = tile::get_tile_matrix_size(&request.bounds, request.zoom);
    task_log(app, tm, task_id, "INFO", &format!(
        "瓦片数量: {}，矩阵: {}列×{}行，范围: x[{}-{}] y[{}-{}]",
        actual_count, cols, rows, x_min, x_max, y_min, y_max
    ));
    
    // 宽高比异常警告
    if cols > 0 && rows > 0 {
        let ratio = if cols > rows { cols as f64 / rows as f64 } else { rows as f64 / cols as f64 };
        if ratio > 50.0 {
            task_log(app, tm, task_id, "WARN", &format!(
                "异常: 瓦片矩阵宽高比 {:.1}:1 极不平衡，可能是坐标错误", ratio
            ));
        }
    }
    
    // 创建临时目录
    let temp_dir = std::env::temp_dir().join(format!("tif-dl-{}", task_id));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("创建临时目录失败: {}", e))?;
    task_log(app, tm, task_id, "INFO", &format!("瓦片临时目录: {}", temp_dir.display()));
    
    // 创建下载器
    let downloader = TileDownloader::new(source, request.proxy.as_deref())?;
    
    // 更新状态: 下载中
    task_log(app, tm, task_id, "INFO", "开始下载瓦片...");
    tm.update_progress(task_id, TaskStatus::Downloading, 0.0, 0, 0, Some("开始下载...".to_string()));
    
    let app_c = app.clone();
    let en = event_name.clone();
    let tid = task_id.to_string();
    let tm_c = Arc::clone(tm);
    let concurrency = request.concurrency;
    let mut last_log_pct: f64 = 0.0;
    
    let mut last_status = String::new();
    let no_data_tracker = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let no_data_tracker_c = no_data_tracker.clone();
    
    let tile_files = downloader.download_tiles(tiles, concurrency, &temp_dir, Some(cancel_token), Some(pause_control), move |progress| {
        no_data_tracker_c.store(progress.no_data, std::sync::atomic::Ordering::Relaxed);
        let p = progress.percent();
        // 映射到 0-85% 范围
        let mapped = p * 0.85;
        
        // 检测重试状态变化，记录日志
        let is_terminal = progress.status == "completed" || progress.status == "completed_with_errors" || progress.status == "completed_with_no_data";
        let is_normal = progress.status == "downloading" || is_terminal;
        if progress.status != last_status {
            last_status = progress.status.clone();
            if let Some(log) = tm_c.append_log(&tid, if is_normal { "INFO" } else { "WARN" }, &progress.status) {
                let _ = app_c.emit(&format!("task-log-{}", tid), &log);
            }
        }
        
        let display_msg = if is_terminal {
            if progress.status == "completed_with_no_data" {
                format!("全部 {} 张瓦片均无数据", progress.total)
            } else {
                format!("下载完成 {}/{}", progress.completed, progress.total)
            }
        } else if progress.status == "downloading" {
            format!("下载中 {}/{}", progress.completed, progress.total)
        } else {
            format!("{} ({}/{})", progress.status, progress.completed, progress.total)
        };
        
        tm_c.update_progress(&tid, TaskStatus::Downloading, mapped, progress.completed, progress.failed, Some(display_msg.clone()));
        let _ = app_c.emit(&en, TaskProgressPayload {
            task_id: tid.clone(),
            status: "downloading".to_string(),
            progress: mapped,
            completed: progress.completed,
            total: progress.total,
            message: Some(display_msg),
        });
        // 每10%记录一次日志
        if p - last_log_pct >= 10.0 {
            last_log_pct = (p / 10.0).floor() * 10.0;
            if let Some(log) = tm_c.append_log(&tid, "INFO", &format!("下载进度 {:.0}% ({}/{})", p, progress.completed, progress.total)) {
                let _ = app_c.emit(&format!("task-log-{}", tid), &log);
            }
        }
    }).await?;
    
    // 检查取消
    if cancel_token.is_cancelled() {
        return Err("任务已取消".to_string());
    }
    
    let failed_count = actual_count - tile_files.len() as u32;
    let no_data_final = no_data_tracker.load(std::sync::atomic::Ordering::Relaxed);
    let real_failed = if failed_count > no_data_final { failed_count - no_data_final } else { 0 };
    let download_elapsed = start_time.elapsed();
    
    let mut summary_parts = vec![format!("成功 {} 张", tile_files.len())];
    if no_data_final > 0 {
        summary_parts.push(format!("无数据 {} 张", no_data_final));
    }
    if real_failed > 0 {
        summary_parts.push(format!("失败 {} 张", real_failed));
    }
    task_log(app, tm, task_id, "INFO", &format!(
        "下载完成，{}，耗时 {:.1}s",
        summary_parts.join("，"),
        download_elapsed.as_secs_f64()
    ));
    
    if no_data_final > 0 {
        let pct = (no_data_final as f64 / actual_count as f64 * 100.0).round();
        if pct > 50.0 {
            task_log(app, tm, task_id, "WARN", &format!(
                "有 {:.0}% 的瓦片返回无数据（404），该区域在此缩放级别可能不完整",
                pct
            ));
        }
    }
    
    // 判断是否使用流式写入路径
    // GeoTIFF: 流式 BigTIFF（streaming_tiff）
    // PNG: 流式 PNG（streaming_raster）
    // JPEG: 全量内存路径（需全图编码，但已优化为直写文件）
    // DEM (Terrarium): 强制流式 BigTIFF Float32
    let format = ExportFormat::from_str(&request.format);
    let is_dem = crate::dem::is_dem_source(&request.source);
    let is_geotiff = format == ExportFormat::GeoTiff || is_dem;
    let is_png = format == ExportFormat::Png;
    let use_streaming = is_geotiff || is_png;
    
    let file_size;
    
    if use_streaming {
        // ===== 流式路径：逐行写入，内存极低 =====
        let has_crop = request.crop_to_shape && request.polygon.is_some();
        let format_label = if is_geotiff { "BigTIFF" } else { "PNG" };
        task_log(app, tm, task_id, "INFO", &format!(
            "使用流式 {} 导出（{} 张瓦片{}）",
            format_label,
            actual_count,
            if has_crop { "，含多边形裁剪" } else { "" }
        ));
        tm.update_progress(task_id, TaskStatus::Exporting, 88.0, actual_count - failed_count, failed_count, Some(format!("流式导出 {}...", format_label)));
        let _ = app.emit(&event_name, TaskProgressPayload {
            task_id: task_id.to_string(),
            status: "exporting".to_string(),
            progress: 88.0,
            completed: actual_count - failed_count,
            total: actual_count,
            message: Some(format!("流式导出 {}...", format_label)),
        });
        
        let merged_bounds = tile::get_merged_bounds(x_min, y_min, x_max, y_max, request.zoom);
        let sp = save_path.clone();
        let compression = request.compression.clone();

        // 构造多边形掩码数据（裁剪模式时传入）
        let polygon_data: Option<Vec<Vec<merger::PolygonPoint>>> = if has_crop {
            request.polygon.as_ref().map(|polys| {
                polys.iter()
                    .map(|ring| ring.iter().map(|p| merger::PolygonPoint { lat: p.lat, lng: p.lng }).collect())
                    .collect()
            })
        } else {
            None
        };
        
        file_size = tokio::task::spawn_blocking(move || {
            let poly_slices: Option<&[Vec<merger::PolygonPoint>]> = polygon_data.as_deref();
            if is_dem {
                streaming_tiff::merge_and_export_dem_streaming(
                    &tile_files, x_min, y_min, x_max, y_max,
                    &merged_bounds, Path::new(&sp), &compression,
                    poly_slices,
                )
            } else if is_geotiff {
                streaming_tiff::merge_and_export_streaming(
                    &tile_files, x_min, y_min, x_max, y_max,
                    &merged_bounds, Path::new(&sp), &compression,
                    poly_slices,
                )
            } else {
                streaming_raster::merge_and_export_streaming_png(
                    &tile_files, x_min, y_min, x_max, y_max,
                    &merged_bounds, Path::new(&sp),
                    poly_slices,
                )
            }
        }).await.map_err(|e| format!("流式导出失败: {}", e))??;
    } else {
        // ===== 常规路径：内存拼接 + 导出（仅 JPEG）=====
        // 内存预算守卫：常规路径会全量加载画布，需检查预算
        let has_crop = request.crop_to_shape && request.polygon.is_some();
        let format_class = FormatClass::RasterImage;
        let budget_mb = SettingsManager::new()
            .and_then(|m| m.get())
            .map(|s| s.memory_budget_mb)
            .unwrap_or(budget::DEFAULT_BUDGET_MB);
        let bc = budget::check_budget(cols, rows, format_class, has_crop, budget_mb);
        if !bc.allowed {
            let err_msg = budget::format_budget_error(&bc);
            task_log(app, tm, task_id, "ERROR", &err_msg);
            return Err(err_msg);
        }

        task_log(app, tm, task_id, "INFO", "使用常规内存拼接路径");
        task_log(app, tm, task_id, "INFO", "开始拼接瓦片...");
        tm.update_progress(task_id, TaskStatus::Merging, 88.0, actual_count - failed_count, failed_count, Some("拼接中...".to_string()));
        let _ = app.emit(&event_name, TaskProgressPayload {
            task_id: task_id.to_string(),
            status: "merging".to_string(),
            progress: 88.0,
            completed: actual_count - failed_count,
            total: actual_count,
            message: Some("拼接瓦片...".to_string()),
        });
        
        let merged = tokio::task::spawn_blocking(move || {
            merger::merge_tiles(&tile_files, x_min, y_min, x_max, y_max)
        }).await.map_err(|e| format!("拼接失败: {}", e))?;
        
        if cancel_token.is_cancelled() {
            return Err("任务已取消".to_string());
        }
        
        task_log(app, tm, task_id, "INFO", &format!("拼接完成，开始导出 {}...", request.format.to_uppercase()));
        tm.update_progress(task_id, TaskStatus::Exporting, 93.0, actual_count - failed_count, failed_count, Some("导出中...".to_string()));
        let _ = app.emit(&event_name, TaskProgressPayload {
            task_id: task_id.to_string(),
            status: "exporting".to_string(),
            progress: 93.0,
            completed: actual_count - failed_count,
            total: actual_count,
            message: Some(format!("导出 {}...", request.format.to_uppercase())),
        });
        
        let merged_bounds = tile::get_merged_bounds(x_min, y_min, x_max, y_max, request.zoom);
        let format = ExportFormat::from_str(&request.format);
        let crop_to_shape = request.crop_to_shape;
        let polygon_opt = request.polygon.clone();
        // 使用瓦片网格边界（而非用户选区）做多边形裁剪的坐标参考
        let grid_bounds_tuple = (merged_bounds.north, merged_bounds.south, merged_bounds.east, merged_bounds.west);
        let compression = request.compression.clone();
        let sp = save_path.clone();
        
        file_size = tokio::task::spawn_blocking(move || {
            if crop_to_shape && polygon_opt.is_some() {
                let polygons: Vec<Vec<merger::PolygonPoint>> = polygon_opt.unwrap()
                    .iter()
                    .map(|ring| ring.iter().map(|p| merger::PolygonPoint { lat: p.lat, lng: p.lng }).collect())
                    .collect();
                let masked = merger::mask_image_by_polygons(merged, &polygons, grid_bounds_tuple);
                exporter::export_rgba_image_to_file(masked, format, Path::new(&sp), Some(&merged_bounds), &compression)
            } else {
                exporter::export_image_to_file(merged, format, Path::new(&sp), Some(&merged_bounds), &compression)
            }
        }).await.map_err(|e| format!("导出失败: {}", e))??;
    }
    
    // 金字塔构建（仅 BigTIFF + 用户勾选时）
    let mut file_size = file_size;
    let mut pyramid_built = false;
    if request.build_pyramid && is_geotiff {
        task_log(app, tm, task_id, "INFO", "开始构建影像金字塔...");
        tm.update_progress(task_id, TaskStatus::Exporting, 95.0, actual_count - failed_count, failed_count, Some("构建金字塔...".to_string()));
        let _ = app.emit(&event_name, TaskProgressPayload {
            task_id: task_id.to_string(),
            status: "building_pyramid".to_string(),
            progress: 95.0,
            completed: actual_count - failed_count,
            total: actual_count,
            message: Some("构建金字塔...".to_string()),
        });

        let pyramid_path = save_path.clone();
        let pyramid_compression = request.compression.clone();
        let app_clone = app.clone();
        let event_clone = event_name.clone();
        let total_tiles = actual_count;
        let failed_tiles = failed_count;

        let pyramid_result = tokio::task::spawn_blocking(move || {
            pyramid::build_pyramid(
                &pyramid_path,
                pyramid::PyramidOptions {
                    compression: pyramid_compression,
                    progress_cb: Some(Box::new(move |current, total| {
                        let _ = app_clone.emit(&event_clone, TaskProgressPayload {
                            task_id: String::new(),
                            status: "building_pyramid".to_string(),
                            progress: 95.0 + (current as f64 / total as f64) * 4.0,
                            completed: total_tiles - failed_tiles,
                            total: total_tiles,
                            message: Some(format!("构建金字塔 {}/{}...", current + 1, total)),
                        });
                    })),
                    ..Default::default()
                },
            )
        }).await;

        match pyramid_result {
            Ok(Ok(stats)) => {
                task_log(app, tm, task_id, "INFO", &format!(
                    "金字塔构建完成：{} 层，增加 {:.1} MB，耗时 {:.1}s",
                    stats.levels_generated,
                    stats.size_added_bytes as f64 / 1024.0 / 1024.0,
                    stats.elapsed_ms as f64 / 1000.0,
                ));
                file_size += stats.size_added_bytes;
                pyramid_built = true;
            }
            Ok(Err(e)) => {
                task_log(app, tm, task_id, "WARN", &format!("金字塔构建失败（不影响导出文件）: {}", e));
            }
            Err(e) => {
                task_log(app, tm, task_id, "WARN", &format!("金字塔构建线程异常: {}", e));
            }
        }
    }

    // 标记完成，清理临时文件和持久化任务
    let total_elapsed = start_time.elapsed();
    let size_mb = file_size as f64 / 1024.0 / 1024.0;
    task_log(app, tm, task_id, "INFO", &format!("=== 任务完成 === 文件大小: {:.1} MB，总耗时: {:.1}s", size_mb, total_elapsed.as_secs_f64()));
    crate::task::remove_task_file(task_id);
    crate::task::cleanup_temp_dir(task_id);
    tm.complete_task(task_id, file_size);
    let _ = app.emit(&event_name, TaskProgressPayload {
        task_id: task_id.to_string(),
        status: "completed".to_string(),
        progress: 100.0,
        completed: actual_count - failed_count,
        total: actual_count,
        message: Some("完成!".to_string()),
    });
    
    // 自动添加历史记录
    let log_file_path = tm.get_log_file_path(task_id);
    let record = DownloadRecord::new(
        task_name.to_string(),
        request.source.clone(),
        source_name.to_string(),
        request.zoom,
        request.format.clone(),
        save_path,
        file_size,
        actual_count,
        failed_count,
        if failed_count == 0 { DownloadStatus::Completed } else { DownloadStatus::Completed },
    ).with_log_file(log_file_path)
     .with_duration(total_elapsed.as_secs())
     .with_pyramid(pyramid_built);
    if let Ok(manager) = HistoryManager::new() {
        let _ = manager.add(record);
    }
    
    Ok(())
}

/// 获取所有活动任务
#[tauri::command]
pub fn get_active_tasks(task_manager: State<'_, Arc<TaskManager>>) -> Vec<TaskInfo> {
    task_manager.get_all_tasks()
}

/// 获取任务日志
#[tauri::command]
pub fn get_task_logs(task_manager: State<'_, Arc<TaskManager>>, task_id: String) -> Vec<TaskLog> {
    task_manager.get_logs(&task_id)
}

/// 按日志文件路径读取日志（用于历史任务日志回看）
#[tauri::command]
pub fn read_log_file(task_manager: State<'_, Arc<TaskManager>>, file_path: String) -> Vec<TaskLog> {
    // 安全校验：仅允许读取日志目录下的文件
    let log_dir_str = task_manager.get_log_dir();
    let log_dir = std::path::Path::new(&log_dir_str);
    let target = std::path::Path::new(&file_path);
    match (target.canonicalize(), log_dir.canonicalize()) {
        (Ok(abs_target), Ok(abs_dir)) if abs_target.starts_with(&abs_dir) => {
            TaskManager::read_log_file_by_path(&file_path)
        }
        _ => Vec::new(),
    }
}

/// 获取日志目录路径
#[tauri::command]
pub fn get_log_dir(task_manager: State<'_, Arc<TaskManager>>) -> String {
    task_manager.get_log_dir()
}

/// 探测指定位置和层级的瓦片是否有数据
#[derive(Debug, Serialize)]
pub struct ProbeResult {
    pub has_data: bool,
    pub status_code: u16,
    pub content_length: usize,
    pub message: String,
}

#[tauri::command]
pub async fn probe_tile(
    source_key: String,
    zoom: u8,
    lat: f64,
    lng: f64,
    tianditu_token: Option<String>,
    proxy: Option<String>,
) -> Result<ProbeResult, String> {
    let sources = config::get_tile_sources(tianditu_token.as_deref());
    let source = sources
        .get(&source_key)
        .ok_or_else(|| format!("未知图源: {}", source_key))?
        .clone();

    // 构造 tile 坐标
    let (tx, ty) = tile::latlng_to_tile(lat, lng, zoom);
    let tile_coord = tile::TileCoord { x: tx, y: ty, z: zoom };

    // 复用 TileDownloader 的 URL 构造与请求头
    let downloader = TileDownloader::new(source, proxy.as_deref())?;
    let url = downloader.get_tile_url_public(&tile_coord);
    let headers = downloader.get_headers_public();
    let client = downloader.client();

    let resp = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status_code = resp.status().as_u16();

    if !resp.status().is_success() {
        return Ok(ProbeResult {
            has_data: false,
            status_code,
            content_length: 0,
            message: format!("HTTP {}", status_code),
        });
    }

    let bytes = resp.bytes().await.map_err(|e| format!("读取失败: {}", e))?;
    let content_length = bytes.len();

    // 启发式判断：卫星/影像 tile 通常 > 5KB，空白/占位 tile 通常 < 1KB
    let has_data = content_length > 1000;
    let message = if has_data {
        format!("瓦片有效 ({}B)", content_length)
    } else {
        format!("瓦片可能为空 ({}B)，该区域在此层级可能无数据", content_length)
    };

    Ok(ProbeResult {
        has_data,
        status_code,
        content_length,
        message,
    })
}

/// 取消任务
#[tauri::command]
pub fn cancel_task(task_manager: State<'_, Arc<TaskManager>>, task_id: String) -> bool {
    task_manager.cancel_task(&task_id)
}

/// 暂停/恢复任务
#[tauri::command]
pub fn toggle_pause_task(
    app: AppHandle,
    task_manager: State<'_, Arc<TaskManager>>,
    task_id: String,
) -> bool {
    let (ok, paused) = task_manager.toggle_pause(&task_id);
    if ok {
        let status = if paused { "paused" } else { "downloading" };
        let msg = if paused { "已暂停" } else { "已恢复下载" };
        task_log(&app, &task_manager, &task_id, "INFO", msg);
        let _ = app.emit(&format!("task-progress-{}", task_id), TaskProgressPayload {
            task_id: task_id.clone(),
            status: status.to_string(),
            progress: 0.0, // 前端会保留当前进度
            completed: 0,
            total: 0,
            message: Some(msg.to_string()),
        });
    }
    ok
}

/// 移除已完成的任务
#[tauri::command]
pub fn remove_task(task_manager: State<'_, Arc<TaskManager>>, task_id: String) {
    task_manager.remove_finished(&task_id);
}

// ============ 断点续传相关命令 ============

/// 获取可恢复的任务列表（排除当前活动任务）
#[tauri::command]
pub fn get_resumable_tasks(task_manager: State<'_, Arc<TaskManager>>) -> Vec<PersistedTask> {
    let active_ids: std::collections::HashSet<String> = task_manager
        .get_all_tasks()
        .into_iter()
        .map(|t| t.id)
        .collect();
    crate::task::load_resumable_tasks()
        .into_iter()
        .filter(|t| !active_ids.contains(&t.task_id))
        .collect()
}

/// 恢复下载任务
#[tauri::command]
pub async fn resume_task(
    app: AppHandle,
    task_manager: State<'_, Arc<TaskManager>>,
    task_id: String,
) -> Result<CreateTaskResult, String> {
    // 读取持久化任务
    let tasks = crate::task::load_resumable_tasks();
    let persisted = tasks.into_iter()
        .find(|t| t.task_id == task_id)
        .ok_or_else(|| "未找到可恢复的任务".to_string())?;
    
    let request = persisted.request.clone();
    let task_name = persisted.task_name.clone();
    let source_name = persisted.source_name.clone();
    let tile_count = persisted.tile_count;
    let save_path = request.save_path.clone()
        .ok_or_else(|| "未指定保存路径".to_string())?;
    
    let sources = get_tile_sources(request.tianditu_token.clone());
    let source = sources.get(&request.source)
        .ok_or_else(|| format!("未知图源: {}", request.source))?.clone();
    
    // 注册任务（复用原 task_id）
    let (cancel_token, pause_control) = task_manager.create_task(
        task_id.clone(),
        task_name.clone(),
        request.source.clone(),
        source_name.clone(),
        request.zoom,
        request.format.clone(),
        save_path.clone(),
        tile_count,
    );
    
    let tm = Arc::clone(&task_manager);
    let tid = task_id.clone();
    let req_source_r = request.source.clone();
    let req_zoom_r = request.zoom;
    let req_format_r = request.format.clone();
    let task_name_r = task_name.clone();
    let source_name_r = source_name.clone();
    
    tokio::spawn(async move {
        let result = execute_download_task(
            &app, &tm, &tid, &cancel_token, &pause_control,
            request, source, save_path.clone(),
            tile_count, &task_name, &source_name,
        ).await;
        
        match result {
            Ok(_) => {},
            Err(e) => {
                if tm.is_cancelled(&tid) {
                    task_log(&app, &tm, &tid, "WARN", "任务已取消");
                    crate::task::remove_task_file(&tid);
                    crate::task::cleanup_temp_dir(&tid);
                    tm.mark_cancelled(&tid);
                    let _ = app.emit(&format!("task-progress-{}", tid), TaskProgressPayload {
                        task_id: tid,
                        status: "cancelled".to_string(),
                        progress: 0.0, completed: 0, total: tile_count,
                        message: Some("已取消".to_string()),
                    });
                } else {
                    task_log(&app, &tm, &tid, "ERROR", &format!("任务失败: {}", e));
                    crate::task::remove_task_file(&tid);
                    crate::task::cleanup_temp_dir(&tid);
                    // 失败也记录到历史
                    let log_file_path = tm.get_log_file_path(&tid);
                    let record = DownloadRecord::new(
                        task_name_r,
                        req_source_r,
                        source_name_r,
                        req_zoom_r,
                        req_format_r,
                        save_path.clone(),
                        0,
                        tile_count,
                        0,
                        DownloadStatus::Failed,
                    ).with_log_file(log_file_path);
                    if let Ok(manager) = HistoryManager::new() {
                        let _ = manager.add(record);
                    }
                    tm.fail_task(&tid, e.clone());
                    let _ = app.emit(&format!("task-progress-{}", tid), TaskProgressPayload {
                        task_id: tid,
                        status: "failed".to_string(),
                        progress: 0.0, completed: 0, total: tile_count,
                        message: Some(format!("失败: {}", e)),
                    });
                }
            }
        }
    });
    
    Ok(CreateTaskResult { task_id, tile_count })
}

/// 丢弃可恢复的任务
#[tauri::command]
pub fn discard_resumable_task(task_id: String) {
    crate::task::remove_task_file(&task_id);
    crate::task::cleanup_temp_dir(&task_id);
}

/// 获取省份列表
#[tauri::command]
pub fn get_provinces() -> Vec<AdminRegion> {
    admin::get_provinces()
}

/// 获取城市列表
#[tauri::command]
pub async fn get_cities(province_code: String) -> Result<Vec<AdminRegion>, String> {
    admin::get_cities(&province_code).await
}

/// 获取区县列表
#[tauri::command]
pub async fn get_districts(city_code: String) -> Result<Vec<AdminRegion>, String> {
    admin::get_districts(&city_code).await
}

/// 获取行政区边界 GeoJSON
/// to_wgs84: 是否转换为 WGS-84 坐标系（默认 true，Google 地图等 GCJ-02 图源应传 false）
#[tauri::command]
pub async fn get_admin_boundary(code: String, to_wgs84: Option<bool>) -> Result<serde_json::Value, String> {
    admin::get_admin_boundary(&code, to_wgs84.unwrap_or(true)).await
}

/// 地名搜索
#[tauri::command]
pub async fn geocode_search(
    query: String,
    tianditu_token: Option<String>,
) -> Result<Vec<GeocodeResult>, String> {
    admin::geocode_search(&query, tianditu_token.as_deref()).await
}

// ============ 历史记录相关命令 ============

/// 获取下载历史记录
#[tauri::command]
pub fn get_download_history() -> Result<Vec<DownloadRecord>, String> {
    let manager = HistoryManager::new()?;
    manager.get_all()
}

/// 添加下载记录
#[tauri::command]
pub fn add_download_record(
    name: String,
    source: String,
    source_name: String,
    zoom: u8,
    format: String,
    file_path: String,
    file_size: u64,
    tile_count: u32,
    failed_count: u32,
    success: bool,
) -> Result<DownloadRecord, String> {
    let status = if success { DownloadStatus::Completed } else { DownloadStatus::Failed };
    let record = DownloadRecord::new(
        name, source, source_name, zoom, format, file_path, file_size, tile_count, failed_count, status
    );
    
    let manager = HistoryManager::new()?;
    manager.add(record.clone())?;
    Ok(record)
}

/// 删除下载记录
#[tauri::command]
pub fn delete_download_record(id: String) -> Result<(), String> {
    let manager = HistoryManager::new()?;
    manager.delete(&id)
}

/// 清空所有下载记录
#[tauri::command]
pub fn clear_download_history() -> Result<(), String> {
    let manager = HistoryManager::new()?;
    manager.clear()
}

/// 为已有 TIFF 文件补建金字塔
#[tauri::command]
pub async fn build_pyramid_for_file(
    app: tauri::AppHandle,
    record_id: String,
    file_path: String,
) -> Result<(), String> {
    use std::path::Path;
    let p = file_path.clone();
    if !Path::new(&p).exists() {
        return Err(format!("文件不存在: {}", p));
    }

    let app_clone = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        pyramid::build_pyramid(
            &p,
            pyramid::PyramidOptions {
                progress_cb: Some(Box::new(move |current, total| {
                    let _ = app_clone.emit("pyramid-progress", serde_json::json!({
                        "record_id": &record_id,
                        "current": current,
                        "total": total,
                    }));
                })),
                ..Default::default()
            },
        )
    }).await.map_err(|e| format!("线程异常: {}", e))?;

    let stats = result?;

    // 更新历史记录
    let manager = HistoryManager::new()?;
    let mut records = manager.get_all()?;
    // record_id 在闭包里被 move 了，重新从 event payload 解析不可行
    // 用 file_path 匹配
    if let Some(r) = records.iter_mut().find(|r| r.file_path == file_path) {
        r.has_pyramid = true;
        r.file_size += stats.size_added_bytes;
    }
    manager.save_all(&records)?;

    Ok(())
}

/// 打开文件所在目录
#[tauri::command]
pub fn open_file_location(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    
    // 获取父目录
    let dir = if path.is_file() {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    
    open::that(dir)
        .map_err(|e| format!("打开文件夹失败: {}", e))
}

/// 打开文件
#[tauri::command]
pub fn open_file(file_path: String) -> Result<(), String> {
    open::that(&file_path)
        .map_err(|e| format!("打开文件失败: {}", e))
}

// ============ 设置相关命令 ============

/// 获取应用设置
#[tauri::command]
pub fn get_settings() -> Result<AppSettings, String> {
    let manager = SettingsManager::new()?;
    manager.get()
}

/// 保存应用设置
#[tauri::command]
pub fn save_settings(settings: AppSettings) -> Result<(), String> {
    let manager = SettingsManager::new()?;
    manager.save(&settings)?;
    // 同步全局 TLS 严格性开关，避免用户变更后仍需重启才生效
    crate::config::set_allow_invalid_certs(settings.allow_invalid_certs);
    Ok(())
}

// ============ 矢量数据下载命令 ============

/// 创建 OSM 矢量数据下载任务（非阻塞）
#[tauri::command]
pub async fn create_osm_download_task(
    app: AppHandle,
    task_manager: State<'_, Arc<TaskManager>>,
    bounds: Bounds,
    feature_type: String,
    save_path: String,
    proxy: Option<String>,
    polygon: Option<Vec<PolygonCoord>>,
    task_name: String,
) -> Result<CreateTaskResult, String> {
    use crate::admin::download_osm_features;

    let task_id = uuid::Uuid::new_v4().to_string();

    let (cancel_token, _pause_control) = task_manager.create_task(
        task_id.clone(),
        task_name.clone(),
        "osm_vector".to_string(),
        "OSM Overpass".to_string(),
        0,
        "geojson".to_string(),
        save_path.clone(),
        0,
    );

    let tm = Arc::clone(&task_manager);
    let tid = task_id.clone();

    tokio::spawn(async move {
        let event_name = format!("task-progress-{}", tid);

        // 请求中
        tm.update_progress(&tid, TaskStatus::Downloading, 20.0, 0, 0, Some("正在请求 Overpass API...".to_string()));
        let _ = app.emit(&event_name, TaskProgressPayload {
            task_id: tid.clone(), status: "downloading".to_string(),
            progress: 20.0, completed: 0, total: 0,
            message: Some("正在请求 Overpass API...".to_string()),
        });

        let poly_coords: Option<Vec<(f64, f64)>> = polygon.map(|p| p.iter().map(|c| (c.lat, c.lng)).collect());

        let geojson = match download_osm_features(
            bounds.south, bounds.west, bounds.north, bounds.east,
            &feature_type, proxy.as_deref(), poly_coords.as_deref(),
        ).await {
            Ok(g) => g,
            Err(e) => {
                if tm.is_cancelled(&tid) {
                    tm.mark_cancelled(&tid);
                    let _ = app.emit(&event_name, TaskProgressPayload {
                        task_id: tid, status: "cancelled".to_string(),
                        progress: 0.0, completed: 0, total: 0, message: Some("已取消".to_string()),
                    });
                } else {
                    tm.fail_task(&tid, e.clone());
                    let _ = app.emit(&event_name, TaskProgressPayload {
                        task_id: tid, status: "failed".to_string(),
                        progress: 0.0, completed: 0, total: 0, message: Some(format!("失败: {}", e)),
                    });
                }
                return;
            }
        };

        if cancel_token.is_cancelled() {
            tm.mark_cancelled(&tid);
            let _ = app.emit(&event_name, TaskProgressPayload {
                task_id: tid, status: "cancelled".to_string(),
                progress: 0.0, completed: 0, total: 0, message: Some("已取消".to_string()),
            });
            return;
        }

        // 保存文件
        tm.update_progress(&tid, TaskStatus::Exporting, 80.0, 0, 0, Some("保存文件...".to_string()));
        let _ = app.emit(&event_name, TaskProgressPayload {
            task_id: tid.clone(), status: "exporting".to_string(),
            progress: 80.0, completed: 0, total: 0, message: Some("保存文件...".to_string()),
        });

        let content = match serde_json::to_string_pretty(&geojson) {
            Ok(c) => c,
            Err(e) => {
                let err = format!("序列化失败: {}", e);
                tm.fail_task(&tid, err.clone());
                let _ = app.emit(&event_name, TaskProgressPayload {
                    task_id: tid, status: "failed".to_string(),
                    progress: 0.0, completed: 0, total: 0, message: Some(err),
                });
                return;
            }
        };

        let file_size = content.len() as u64;
        if let Err(e) = std::fs::write(&save_path, &content) {
            let err = format!("保存文件失败: {}", e);
            tm.fail_task(&tid, err.clone());
            let _ = app.emit(&event_name, TaskProgressPayload {
                task_id: tid, status: "failed".to_string(),
                progress: 0.0, completed: 0, total: 0, message: Some(err),
            });
            return;
        }

        // 完成
        tm.complete_task(&tid, file_size);
        let _ = app.emit(&event_name, TaskProgressPayload {
            task_id: tid.clone(), status: "completed".to_string(),
            progress: 100.0, completed: 0, total: 0, message: Some("完成!".to_string()),
        });

        // 自动添加历史记录
        let log_file_path = tm.get_log_file_path(&tid);
        let record = DownloadRecord::new(
            task_name, "osm_vector".to_string(), "OSM Overpass".to_string(),
            0, "geojson".to_string(), save_path, file_size, 0, 0, DownloadStatus::Completed,
        ).with_log_file(log_file_path);
        if let Ok(manager) = HistoryManager::new() {
            let _ = manager.add(record);
        }
    });

    Ok(CreateTaskResult { task_id, tile_count: 0 })
}

/// 下载 OSM 数据
#[tauri::command]
pub async fn download_osm_data(
    bounds: Bounds,
    feature_type: String,
    save_path: String,
    proxy: Option<String>,
    polygon: Option<Vec<PolygonCoord>>,
) -> Result<String, String> {
    use crate::admin::download_osm_features;
    
    // 将多边形坐标转换为 (lat, lng) 元组列表
    let poly_coords: Option<Vec<(f64, f64)>> = polygon.map(|p| {
        p.iter().map(|c| (c.lat, c.lng)).collect()
    });
    
    let geojson = download_osm_features(
        bounds.south, bounds.west, bounds.north, bounds.east,
        &feature_type,
        proxy.as_deref(),
        poly_coords.as_deref()
    ).await?;
    
    // 保存到文件
    let content = serde_json::to_string_pretty(&geojson)
        .map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(&save_path, &content)
        .map_err(|e| format!("保存文件失败: {}", e))?;
    
    Ok(save_path)
}

/// 下载行政边界并保存到文件
#[tauri::command]
pub async fn download_admin_boundary_file(
    code: String,
    save_path: String,
) -> Result<String, String> {
    let geojson = admin::get_admin_boundary(&code, true).await?;
    
    let content = serde_json::to_string_pretty(&geojson)
        .map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(&save_path, &content)
        .map_err(|e| format!("保存文件失败: {}", e))?;
    
    Ok(save_path)
}

/// 下载并安装更新
#[tauri::command]
pub async fn download_and_install_update(
    app: AppHandle,
    url: String,
    version: String,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let setup_filename = format!("GeoDownloader_{}_setup.exe", version);
    let setup_path = temp_dir.join(&setup_filename);
    
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "GeoDownloader")
        .send()
        .await
        .map_err(|e| format!("下载失败: {}", e))?;
    
    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    
    let mut file = std::fs::File::create(&setup_path)
        .map_err(|e| format!("创建文件失败: {}", e))?;
    
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    use std::io::Write;
    
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载失败: {}", e))?;
        file.write_all(&chunk).map_err(|e| format!("写入失败: {}", e))?;
        
        downloaded += chunk.len() as u64;
        if total_size > 0 {
            let progress = ((downloaded as f64 / total_size as f64) * 100.0) as u32;
            let _ = app.emit("update-download-progress", progress);
        }
    }
    
    drop(file);
    let _ = app.emit("update-download-progress", 100u32);
    
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    
    // 启动安装程序
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(&setup_path)
            .creation_flags(0x00000008) // DETACHED_PROCESS
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }
    
    app.exit(0);
    Ok(())
}

// ============================================================
// 3D Tiles 下载命令
// ============================================================

/// 解析 3D Tiles 数据源，返回 tileset 概要信息
#[tauri::command]
pub async fn analyze_3dtiles(
    source: tiles3d::tileset::Tiles3dSource,
    proxy: Option<String>,
) -> Result<tiles3d::tileset::TilesetSummary, String> {
    let mut fetcher = tiles3d::fetcher::Tiles3dFetcher::new(proxy.as_deref())?;
    let (_endpoint, summary) = fetcher.analyze(&source).await?;
    Ok(summary)
}

/// 预估 3D Tiles 过滤后的下载量
#[tauri::command]
pub async fn estimate_3dtiles(
    source: tiles3d::tileset::Tiles3dSource,
    polygon: Vec<Vec<f64>>,
    proxy: Option<String>,
) -> Result<Tiles3dEstimate, String> {
    let mut fetcher = tiles3d::fetcher::Tiles3dFetcher::new(proxy.as_deref())?;
    let endpoint = fetcher.resolve_source(&source).await?;
    let tileset = fetcher.fetch_tileset(&endpoint.tileset_url).await?;

    let region = tiles3d::filter::SelectionRegion::new(&polygon);
    let result = tiles3d::filter::filter_tileset(&tileset, &region);

    Ok(Tiles3dEstimate {
        total_tiles: result.original_count as u32,
        filtered_tiles: result.filtered_count as u32,
        content_tiles: result.content_count as u32,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct Tiles3dEstimate {
    pub total_tiles: u32,
    pub filtered_tiles: u32,
    pub content_tiles: u32,
}

/// 创建 3D Tiles 下载任务
#[tauri::command]
pub async fn create_3dtiles_task(
    app: AppHandle,
    task_manager: State<'_, Arc<TaskManager>>,
    request: tiles3d::tileset::Tiles3dRequest,
    task_name: String,
) -> Result<CreateTaskResult, String> {
    let save_path = request.save_path.clone();
    let task_id = uuid::Uuid::new_v4().to_string();

    // 先解析数据源获取估算信息
    let mut fetcher = tiles3d::fetcher::Tiles3dFetcher::new(request.proxy.as_deref())?;
    let endpoint = fetcher.resolve_source(&request.source).await?;
    let tileset = fetcher.fetch_tileset(&endpoint.tileset_url).await?;

    let tile_count;
    if let Some(ref polygon) = request.polygon {
        let region = tiles3d::filter::SelectionRegion::new(polygon);
        let filter_result = tiles3d::filter::filter_tileset(&tileset, &region);
        tile_count = filter_result.content_count as u32;
        if tile_count == 0 {
            return Err("选区内无可下载的 3D Tiles 数据".to_string());
        }
    } else {
        let summary = tileset.summary();
        tile_count = summary.content_tiles as u32;
    }

    // 注册任务
    let source_name = match &request.source {
        tiles3d::tileset::Tiles3dSource::CesiumIon { asset_id, .. } => {
            format!("Cesium Ion #{}", asset_id)
        }
        tiles3d::tileset::Tiles3dSource::DirectUrl { tileset_url, .. } => {
            tileset_url.clone()
        }
    };

    let (cancel_token, pause_control) = task_manager.create_task(
        task_id.clone(),
        task_name.clone(),
        "3dtiles".to_string(),
        source_name.clone(),
        0, // zoom 对 3D Tiles 无意义
        "tileset".to_string(),
        save_path.clone(),
        tile_count,
    );

    // spawn 后台下载任务
    let tm = Arc::clone(&task_manager);
    let tid = task_id.clone();
    let sn = source_name.clone();
    let tn = task_name.clone();

    tokio::spawn(async move {
        let result = execute_3dtiles_task(
            &app, &tm, &tid, cancel_token.clone(), pause_control,
            &endpoint.tileset_url, &request, tile_count, &sn, &tn,
        )
        .await;

        match result {
            Ok(_) => {}
            Err(e) => {
                if tm.is_cancelled(&tid) {
                    task_log(&app, &tm, &tid, "WARN", "任务已取消");
                    tm.mark_cancelled(&tid);
                    let _ = app.emit(
                        &format!("task-progress-{}", tid),
                        TaskProgressPayload {
                            task_id: tid,
                            status: "cancelled".to_string(),
                            progress: 0.0,
                            completed: 0,
                            total: tile_count,
                            message: Some("已取消".to_string()),
                        },
                    );
                } else {
                    task_log(&app, &tm, &tid, "ERROR", &format!("任务失败: {}", e));
                    crate::task::remove_task_file(&tid);
                    tm.fail_task(&tid, e.clone());
                    let _ = app.emit(
                        &format!("task-progress-{}", tid),
                        TaskProgressPayload {
                            task_id: tid,
                            status: "failed".to_string(),
                            progress: 0.0,
                            completed: 0,
                            total: tile_count,
                            message: Some(format!("失败: {}", e)),
                        },
                    );
                }
            }
        }
    });

    Ok(CreateTaskResult { task_id, tile_count })
}

/// 执行 3D Tiles 下载任务
async fn execute_3dtiles_task(
    app: &AppHandle,
    tm: &Arc<TaskManager>,
    task_id: &str,
    cancel_token: tokio_util::sync::CancellationToken,
    pause_control: PauseControl,
    tileset_url: &str,
    request: &tiles3d::tileset::Tiles3dRequest,
    tile_count: u32,
    source_name: &str,
    task_name: &str,
) -> Result<(), String> {
    task_log(app, tm, task_id, "INFO", "开始 3D Tiles 下载任务");
    task_log(app, tm, task_id, "INFO", &format!("数据源: {}", tileset_url));

    tm.update_progress(
        task_id,
        TaskStatus::Processing,
        5.0,
        0,
        0,
        Some("正在解析 tileset...".to_string()),
    );

    let mut fetcher = tiles3d::fetcher::Tiles3dFetcher::new(request.proxy.as_deref())?;
    // 解析数据源以设置 auth_headers（含 Referer 等）
    let _ = fetcher.resolve_source(&request.source).await?;
    let output_dir = std::path::Path::new(&request.save_path);

    let tid = task_id.to_string();
    let app_clone = app.clone();
    let tm_clone = Arc::clone(tm);

    let output_path = fetcher
        .download(
            tileset_url,
            request.polygon.as_deref(),
            output_dir,
            request.concurrency,
            cancel_token,
            pause_control,
            move |progress| {
                let p = if progress.total > 0 {
                    (progress.completed as f64 / progress.total as f64) * 95.0 + 5.0
                } else {
                    5.0
                };
                tm_clone.update_progress(
                    &tid,
                    TaskStatus::Downloading,
                    p,
                    progress.completed,
                    progress.failed,
                    Some(progress.status.clone()),
                );
                let _ = app_clone.emit(
                    &format!("task-progress-{}", tid),
                    TaskProgressPayload {
                        task_id: tid.clone(),
                        status: "downloading".to_string(),
                        progress: p,
                        completed: progress.completed,
                        total: progress.total,
                        message: Some(progress.status),
                    },
                );
            },
        )
        .await?;

    // 计算输出目录大小
    let dir_size = dir_size_bytes(output_dir);

    task_log(
        app,
        tm,
        task_id,
        "INFO",
        &format!("下载完成，输出: {}", output_path.display()),
    );

    tm.complete_task(task_id, dir_size);

    // 写入下载历史记录
    let log_file_path = tm.get_log_file_path(task_id);
    let record = DownloadRecord::new(
        task_name.to_string(),
        "3dtiles".to_string(),
        source_name.to_string(),
        0,
        "tileset".to_string(),
        request.save_path.clone(),
        dir_size,
        tile_count,
        0,
        DownloadStatus::Completed,
    ).with_log_file(log_file_path);
    if let Ok(manager) = HistoryManager::new() {
        let _ = manager.add(record);
    }

    let _ = app.emit(
        &format!("task-progress-{}", task_id),
        TaskProgressPayload {
            task_id: task_id.to_string(),
            status: "completed".to_string(),
            progress: 100.0,
            completed: tile_count,
            total: tile_count,
            message: Some("下载完成".to_string()),
        },
    );

    Ok(())
}

/// 递归计算目录大小
fn dir_size_bytes(path: &std::path::Path) -> u64 {
    let mut size = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let meta = entry.metadata();
            if let Ok(m) = meta {
                if m.is_file() {
                    size += m.len();
                } else if m.is_dir() {
                    size += dir_size_bytes(&entry.path());
                }
            }
        }
    }
    size
}

// ============================================================
// 本地 3D Tiles 预览文件服务器
// ============================================================

use std::sync::atomic::{AtomicU16, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 当前活跃的预览服务器端口（0 表示无）
static PREVIEW_SERVER_PORT: AtomicU16 = AtomicU16::new(0);

/// 启动本地文件服务器以预览 3D Tiles
#[tauri::command]
pub async fn serve_local_tiles(dir_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(&dir_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!("目录不存在: {}", dir_path));
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("绑定端口失败: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("获取端口失败: {}", e))?
        .port();

    PREVIEW_SERVER_PORT.store(port, Ordering::Relaxed);

    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let dir = path.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = match stream.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let request = String::from_utf8_lossy(&buf[..n]);
                let req_path = match request.lines().next() {
                    Some(line) => {
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        if parts.len() >= 2 { parts[1].to_string() } else { return }
                    }
                    None => return,
                };

                // URL 解码
                let decoded = urlencoding::decode(&req_path).unwrap_or_default();
                let rel = decoded.trim_start_matches('/');
                let file_path = dir.join(rel);

                // 安全检查：防止路径穿越
                let canonical = match file_path.canonicalize() {
                    Ok(p) => p,
                    Err(_) => {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n").await;
                        return;
                    }
                };
                let dir_canonical = dir.canonicalize().unwrap_or_default();
                if !canonical.starts_with(&dir_canonical) {
                    let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n").await;
                    return;
                }

                match tokio::fs::read(&canonical).await {
                    Ok(data) => {
                        let mime = match canonical.extension().and_then(|e| e.to_str()) {
                            Some("json") => "application/json",
                            Some("glb") => "model/gltf-binary",
                            Some("gltf") => "model/gltf+json",
                            Some("b3dm") => "application/octet-stream",
                            Some("i3dm") => "application/octet-stream",
                            Some("pnts") => "application/octet-stream",
                            Some("cmpt") => "application/octet-stream",
                            Some("png") => "image/png",
                            Some("jpg" | "jpeg") => "image/jpeg",
                            Some("ktx2") => "image/ktx2",
                            _ => "application/octet-stream",
                        };
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: {}\r\nContent-Length: {}\r\n\r\n",
                            mime,
                            data.len()
                        );
                        let _ = stream.write_all(header.as_bytes()).await;
                        let _ = stream.write_all(&data).await;
                    }
                    Err(_) => {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n").await;
                    }
                }
            });
        }
    });

    log::info!("本地预览服务器启动: http://127.0.0.1:{} -> {}", port, dir_path);
    Ok(format!("http://127.0.0.1:{}", port))
}

/// 启动反向代理服务器，为 CesiumJS 预览带 Referer 保护的远端 3D Tiles
#[tauri::command]
pub async fn start_tile_proxy(
    base_url: String,
    headers: HashMap<String, String>,
) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("绑定端口失败: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("获取端口失败: {}", e))?
        .port();

    // 分离 base_url 中的 query 参数（如 ?token=mars3d），代理时附加到每个请求
    let (base_clean, query_suffix) = if let Some(pos) = base_url.find('?') {
        (base_url[..pos].trim_end_matches('/').to_string(), base_url[pos..].to_string())
    } else {
        (base_url.trim_end_matches('/').to_string(), String::new())
    };
    let base_url_log = base_clean.clone();

    // 构建一个带自定义 header 的 reqwest client
    let mut default_headers = reqwest::header::HeaderMap::new();
    for (k, v) in &headers {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            default_headers.insert(name, val);
        }
    }
    let client = reqwest::Client::builder()
        .default_headers(default_headers)
        .danger_accept_invalid_certs(crate::config::allow_invalid_certs())
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let client = client.clone();
            let base = base_clean.clone();
            let qs = query_suffix.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = match stream.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let request = String::from_utf8_lossy(&buf[..n]);
                let req_path = match request.lines().next() {
                    Some(line) => {
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        if parts.len() >= 2 { parts[1].to_string() } else { return }
                    }
                    None => return,
                };

                // 构造远端 URL：base + 请求路径 + 原始 query 参数
                let decoded = urlencoding::decode(&req_path).unwrap_or_default();
                let rel = decoded.trim_start_matches('/');
                let path_part = if rel.is_empty() {
                    format!("{}/", base)
                } else {
                    format!("{}/{}", base, rel)
                };
                // 合并 query：代理固有 query + 请求自带 query
                let remote_url = if qs.is_empty() {
                    path_part
                } else if path_part.contains('?') {
                    format!("{}&{}", path_part, qs.trim_start_matches('?'))
                } else {
                    format!("{}{}", path_part, qs)
                };

                match client.get(&remote_url).send().await {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let content_type = resp
                            .headers()
                            .get("content-type")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("application/octet-stream")
                            .to_string();
                        match resp.bytes().await {
                            Ok(body) => {
                                let header = format!(
                                    "HTTP/1.1 {} OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: {}\r\nContent-Length: {}\r\n\r\n",
                                    status, content_type, body.len()
                                );
                                let _ = stream.write_all(header.as_bytes()).await;
                                let _ = stream.write_all(&body).await;
                            }
                            Err(_) => {
                                let _ = stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n").await;
                            }
                        }
                    }
                    Err(_) => {
                        let _ = stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n").await;
                    }
                }
            });
        }
    });

    log::info!("反向代理服务器启动: http://127.0.0.1:{} -> {}", port, base_url_log);
    Ok(format!("http://127.0.0.1:{}", port))
}

// ============================================================
// 历史影像（Esri Wayback）
// ============================================================

/// 获取 Esri Wayback 所有可用版本
#[tauri::command]
pub async fn get_wayback_versions(
    proxy: Option<String>,
) -> Result<Vec<crate::wayback::WaybackVersion>, String> {
    crate::wayback::fetch_versions(proxy.as_deref()).await
}

/// 探测某个 Wayback 版本在指定位置的最大可用缩放级别
#[tauri::command]
pub async fn probe_wayback_max_zoom(
    version_id: String,
    lat: f64,
    lng: f64,
    proxy: Option<String>,
) -> Result<u32, String> {
    crate::wayback::probe_max_zoom(&version_id, lat, lng, proxy.as_deref()).await
}

/// 创建历史影像下载任务
///
/// 复用现有 TIF 瓦片下载流水线，仅图源来自 Wayback。
#[tauri::command]
pub async fn create_wayback_task(
    app: AppHandle,
    task_manager: State<'_, Arc<TaskManager>>,
    request: DownloadRequest,
    version_id: String,
    version_date: String,
    task_name: String,
) -> Result<CreateTaskResult, String> {
    let source = crate::wayback::make_tile_source(&version_id, &version_date);
    let source_name = source.name.clone();

    // 将 DownloadRequest 中的 source 字段重写为 wayback source id
    let mut request = request;
    request.source = source.id.clone();

    let save_path = request.save_path.clone()
        .ok_or_else(|| "未指定保存路径".to_string())?;

    let tile_count = tile::estimate_tile_count(&request.bounds, request.zoom);
    let task_id = uuid::Uuid::new_v4().to_string();

    // 持久化任务
    let persisted = PersistedTask {
        task_id: task_id.clone(),
        task_name: task_name.clone(),
        source_name: source_name.clone(),
        request: request.clone(),
        tile_count,
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    };
    crate::task::save_task_file(&persisted)?;

    let (cancel_token, pause_control) = task_manager.create_task(
        task_id.clone(),
        task_name.clone(),
        request.source.clone(),
        source_name.clone(),
        request.zoom,
        request.format.clone(),
        save_path.clone(),
        tile_count,
    );

    let tm = Arc::clone(&task_manager);
    let tid = task_id.clone();

    tokio::spawn(async move {
        let result = execute_download_task(
            &app, &tm, &tid, &cancel_token, &pause_control,
            request, source, save_path,
            tile_count, &task_name, &source_name,
        ).await;

        match result {
            Ok(_) => {},
            Err(e) => {
                if tm.is_cancelled(&tid) {
                    task_log(&app, &tm, &tid, "WARN", "任务已取消");
                    crate::task::remove_task_file(&tid);
                    crate::task::cleanup_temp_dir(&tid);
                    tm.mark_cancelled(&tid);
                    let _ = app.emit(&format!("task-progress-{}", tid), TaskProgressPayload {
                        task_id: tid,
                        status: "cancelled".to_string(),
                        progress: 0.0,
                        completed: 0,
                        total: tile_count,
                        message: Some("已取消".to_string()),
                    });
                } else {
                    task_log(&app, &tm, &tid, "ERROR", &format!("任务失败: {}", e));
                    crate::task::remove_task_file(&tid);
                    crate::task::cleanup_temp_dir(&tid);
                    tm.fail_task(&tid, e.clone());
                    let _ = app.emit(&format!("task-progress-{}", tid), TaskProgressPayload {
                        task_id: tid,
                        status: "failed".to_string(),
                        progress: 0.0,
                        completed: 0,
                        total: tile_count,
                        message: Some(format!("失败: {}", e)),
                    });
                }
            }
        }
    });

    Ok(CreateTaskResult { task_id, tile_count })
}

// ============================================================
// Wayback 增量元数据扫描（按拍摄日期去重）
// ============================================================

/// 触发或读取 Wayback 元数据扫描结果
///
/// - 命中缓存（且未过期、未强制刷新）→ 同步返回
/// - 否则启动后台扫描，返回 scan_id 用于轮询进度，扫完后再次调用此命令拿结果
#[derive(Debug, Deserialize)]
pub struct ScanWaybackRequest {
    pub bbox: [f64; 4],     // [minLon, minLat, maxLon, maxLat]
    pub zoom_min: u32,
    pub zoom_max: u32,
    #[serde(default)]
    pub force_refresh: bool,
    #[serde(default)]
    pub proxy: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScanWaybackResponse {
    /// 直接返回结果（缓存命中或同步完成）
    Result(crate::wayback_metadata::WaybackScanResult),
    /// 后台扫描中
    Scanning { scan_id: String, total: u32 },
}

#[tauri::command]
pub async fn scan_wayback_metadata(
    req: ScanWaybackRequest,
    progress: State<'_, crate::wayback_metadata::ScanProgressMap>,
) -> Result<ScanWaybackResponse, String> {
    // 1. 缓存优先（除非强制刷新）
    if !req.force_refresh {
        if let Some(cached) = crate::wayback_metadata::try_load_cache(&req.bbox, req.zoom_min, req.zoom_max) {
            return Ok(ScanWaybackResponse::Result(cached));
        }
    }

    // 2. 启动后台扫描，返回 scan_id
    let scan_id = uuid::Uuid::new_v4().to_string();
    let progress_map = progress.inner().clone();
    let total_estimate = (192u32) * (crate::wayback_metadata::select_layers(req.zoom_min, req.zoom_max).len() as u32);

    let sid = scan_id.clone();
    tokio::spawn(async move {
        let _ = crate::wayback_metadata::scan_metadata(
            req.bbox,
            req.zoom_min,
            req.zoom_max,
            true,
            req.proxy,
            progress_map,
            sid,
        )
        .await;
    });

    Ok(ScanWaybackResponse::Scanning {
        scan_id,
        total: total_estimate,
    })
}

#[tauri::command]
pub async fn get_wayback_scan_progress(
    scan_id: String,
    progress: State<'_, crate::wayback_metadata::ScanProgressMap>,
) -> Result<Option<crate::wayback_metadata::WaybackScanProgress>, String> {
    Ok(crate::wayback_metadata::get_progress(progress.inner(), &scan_id).await)
}

/// 按勾选的拍摄日期批量发起下载
///
/// 每个 footprint 对应一个 release_id，复用现有 `create_wayback_task` 流水线。
#[derive(Debug, Deserialize)]
pub struct WaybackIncrementalRequest {
    pub bounds: Bounds,
    pub zoom: u8,
    pub format: String,
    pub save_path: String,
    pub footprints: Vec<WaybackFootprintSelect>,
    #[serde(default)]
    pub crop_to_shape: bool,
    #[serde(default)]
    pub polygon: Option<Vec<PolygonCoord>>,
    #[serde(default = "default_compression")]
    pub compression: String,
    #[serde(default)]
    pub build_pyramid: bool,
    #[serde(default)]
    pub proxy: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WaybackFootprintSelect {
    pub release_id: String,
    pub release_date: String,
    pub capture_date_str: String,
    pub source_name: String,
    pub resolution_m: f64,
}

#[derive(Debug, Serialize)]
pub struct WaybackIncrementalResult {
    pub task_ids: Vec<String>,
}

#[tauri::command]
pub async fn download_wayback_incremental(
    app: AppHandle,
    task_manager: State<'_, Arc<TaskManager>>,
    req: WaybackIncrementalRequest,
) -> Result<WaybackIncrementalResult, String> {
    let mut task_ids = Vec::new();
    for fp in req.footprints {
        let safe_source = fp.source_name.replace([' ', '/', '\\'], "_");
        let task_name = format!(
            "Wayback {} · {} · {:.2}m",
            fp.capture_date_str, safe_source, fp.resolution_m
        );
        // 输出文件按拍摄日期命名，避免多个任务覆盖同一文件
        let safe_date = fp.capture_date_str.replace('-', "");
        let task_save_path = format!(
            "{}_{}_{}m.{}",
            strip_ext(&req.save_path),
            safe_date,
            (fp.resolution_m * 100.0).round() as i64,
            ext_of(&req.save_path).unwrap_or_else(|| req.format.clone()),
        );
        let polygon = req.polygon.as_ref().map(|p| vec![p.clone()]);
        let download_request = DownloadRequest {
            bounds: req.bounds.clone(),
            zoom: req.zoom,
            source: format!("wayback_{}", fp.release_id),
            format: req.format.clone(),
            proxy: req.proxy.clone(),
            crop_to_shape: req.crop_to_shape,
            polygon,
            tianditu_token: None,
            save_path: Some(task_save_path),
            concurrency: default_concurrency(),
            compression: req.compression.clone(),
            build_pyramid: req.build_pyramid,
        };
        let result = create_wayback_task(
            app.clone(),
            task_manager.clone(),
            download_request,
            fp.release_id.clone(),
            fp.release_date.clone(),
            task_name,
        )
        .await?;
        task_ids.push(result.task_id);
    }
    Ok(WaybackIncrementalResult { task_ids })
}

fn strip_ext(path: &str) -> String {
    match path.rfind('.') {
        Some(idx) => path[..idx].to_string(),
        None => path.to_string(),
    }
}

fn ext_of(path: &str) -> Option<String> {
    path.rfind('.').map(|i| path[i + 1..].to_string())
}


