use crate::settings::SettingsManager;
use crate::task::TaskManager;
pub use crate::cache_access::is_migrating;
use crate::cache_access::{lock_cache_exclusive, set_migrating};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

const COPY_BUFFER_SIZE: usize = 8 * 1024 * 1024;
const SPACE_RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
const PROGRESS_EVENT: &str = "cache-migration-progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMigrationPreflight {
    pub source_dir: String,
    pub target_dir: String,
    pub total_bytes: u64,
    pub file_count: usize,
    pub available_bytes: u64,
    pub required_bytes: u64,
    pub can_start: bool,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMigrationStatus {
    pub migration_id: String,
    pub status: String,
    pub source_dir: String,
    pub target_dir: String,
    pub staging_dir: String,
    pub current_file: Option<String>,
    pub file_index: usize,
    pub file_count: usize,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
    pub message: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMigrationStarted {
    pub migration_id: String,
}

#[derive(Clone)]
struct ActiveMigration {
    id: String,
    cancel: CancellationToken,
}

pub struct CacheMigrationManager {
    active: Mutex<Option<ActiveMigration>>,
    active_changed: Condvar,
    status: Mutex<Option<CacheMigrationStatus>>,
}

impl CacheMigrationManager {
    pub fn new() -> Self {
        let status = load_record().ok().flatten().map(recover_interrupted_record);
        Self {
            active: Mutex::new(None),
            active_changed: Condvar::new(),
            status: Mutex::new(status),
        }
    }

    fn status(&self) -> Option<CacheMigrationStatus> {
        self.status.lock().ok().and_then(|s| s.clone())
    }

    fn set_status(&self, status: CacheMigrationStatus) {
        if let Ok(mut current) = self.status.lock() {
            *current = Some(status.clone());
        }
        let _ = save_record(&status);
    }

    fn update_runtime_status(&self, status: CacheMigrationStatus) {
        if let Ok(mut current) = self.status.lock() {
            *current = Some(status);
        }
    }

    fn finish(&self, status: CacheMigrationStatus) {
        self.set_status(status);
        if let Ok(mut active) = self.active.lock() {
            *active = None;
            self.active_changed.notify_all();
        }
    }

    pub fn has_active_migration(&self) -> bool {
        self.active
            .lock()
            .map(|active| active.is_some())
            .unwrap_or(false)
    }

    pub fn cancel_and_wait(&self) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        if let Some(migration) = active.as_ref() {
            migration.cancel.cancel();
        }
        while active.is_some() {
            active = match self.active_changed.wait(active) {
                Ok(active) => active,
                Err(_) => return,
            };
        }
    }

    fn clear_status(&self) -> Result<(), String> {
        let path = record_path()?;
        if path.exists() {
            fs::remove_file(path).map_err(|e| format!("清理迁移记录失败: {}", e))?;
        }
        if let Ok(mut status) = self.status.lock() {
            *status = None;
        }
        Ok(())
    }
}

#[tauri::command]
pub fn cache_migration_preflight(
    target_dir: String,
    manager: State<'_, Arc<CacheMigrationManager>>,
    tasks: State<'_, Arc<TaskManager>>,
) -> Result<CacheMigrationPreflight, String> {
    if manager
        .active
        .lock()
        .map_err(|_| "迁移状态锁异常")?
        .is_some()
    {
        return Err("已有缓存迁移正在进行".to_string());
    }
    preflight(Path::new(target_dir.trim()), tasks.has_active_tasks())
}

#[tauri::command]
pub fn cache_migration_start(
    target_dir: String,
    app: AppHandle,
    manager: State<'_, Arc<CacheMigrationManager>>,
    tasks: State<'_, Arc<TaskManager>>,
) -> Result<CacheMigrationStarted, String> {
    let selected_target = PathBuf::from(target_dir.trim());
    let check = preflight(&selected_target, tasks.has_active_tasks())?;
    if !check.can_start {
        return Err(check.blockers.join("；"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let source = PathBuf::from(&check.source_dir);
    let target = PathBuf::from(&check.target_dir);
    let staging = staging_path(&target, &id)?;
    let cancel = CancellationToken::new();
    {
        let mut active = manager.active.lock().map_err(|_| "迁移状态锁异常")?;
        if active.is_some() {
            return Err("已有缓存迁移正在进行".to_string());
        }
        *active = Some(ActiveMigration {
            id: id.clone(),
            cancel: cancel.clone(),
        });
    }
    set_migrating(true);

    let initial = make_status(
        &id,
        "preflight",
        &source,
        &target,
        &staging,
        check.file_count,
        check.total_bytes,
        "正在准备迁移",
    );
    manager.set_status(initial.clone());
    let _ = app.emit(PROGRESS_EVENT, &initial);

    let manager = manager.inner().clone();
    let id_for_task = id.clone();
    tauri::async_runtime::spawn(async move {
        let app_for_task = app.clone();
        let manager_for_task = manager.clone();
        let result = tokio::task::spawn_blocking(move || {
            run_migration(
                &app_for_task,
                &manager_for_task,
                &id_for_task,
                &source,
                &target,
                &staging,
                cancel,
            )
        })
        .await;

        if let Err(e) = result {
            set_migrating(false);
            if let Some(mut status) = manager.status() {
                status.status = "failed".to_string();
                status.message = "迁移任务异常结束".to_string();
                status.error = Some(e.to_string());
                manager.finish(status.clone());
                let _ = app.emit(PROGRESS_EVENT, status);
            }
        }
    });

    Ok(CacheMigrationStarted { migration_id: id })
}

#[tauri::command]
pub fn cache_migration_status(
    manager: State<'_, Arc<CacheMigrationManager>>,
) -> Option<CacheMigrationStatus> {
    manager.status()
}

#[tauri::command]
pub fn cache_migration_cancel(
    migration_id: String,
    manager: State<'_, Arc<CacheMigrationManager>>,
) -> Result<(), String> {
    if manager
        .status()
        .is_some_and(|status| status.status == "committing")
    {
        return Err("缓存目录正在完成切换，此阶段不能取消".to_string());
    }
    let active = manager.active.lock().map_err(|_| "迁移状态锁异常")?;
    match active.as_ref() {
        Some(active) if active.id == migration_id => {
            active.cancel.cancel();
            Ok(())
        }
        Some(_) => Err("迁移任务 ID 不匹配".to_string()),
        None => Err("当前没有进行中的缓存迁移".to_string()),
    }
}

#[tauri::command]
pub fn cache_migration_cleanup_staging(
    migration_id: String,
    manager: State<'_, Arc<CacheMigrationManager>>,
) -> Result<u64, String> {
    let status = manager.status().ok_or("没有迁移记录")?;
    if status.migration_id != migration_id {
        return Err("迁移任务 ID 不匹配".to_string());
    }
    if manager
        .active
        .lock()
        .map_err(|_| "迁移状态锁异常")?
        .is_some()
    {
        return Err("迁移仍在进行，不能清理临时目录".to_string());
    }
    let path = validated_staging_path(&status)?;
    let size = directory_size(&path)?;
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|e| format!("清理迁移临时目录失败: {}", e))?;
    }
    manager.clear_status()?;
    Ok(size)
}

#[tauri::command]
pub fn cache_migration_delete_source(
    migration_id: String,
    manager: State<'_, Arc<CacheMigrationManager>>,
) -> Result<u64, String> {
    let status = manager.status().ok_or("没有迁移记录")?;
    if status.migration_id != migration_id || status.status != "completed" {
        return Err("只有已完成的迁移才能删除旧缓存".to_string());
    }
    let source = PathBuf::from(&status.source_dir);
    let target = PathBuf::from(&status.target_dir);
    let current = crate::tile_cache::get_config().root_dir;
    if paths_equivalent(&source, &current) {
        return Err("不能删除当前正在使用的缓存目录".to_string());
    }
    if !paths_equivalent(&target, &current) {
        return Err("当前缓存目录与迁移目标不一致，不能删除旧缓存".to_string());
    }
    crate::tile_cache::Store::global()
        .stats()
        .map_err(|e| format!("新缓存目录读取失败，未删除旧缓存: {}", e))?;
    let size = delete_recognized_cache_files(&source)?;
    manager.clear_status()?;
    Ok(size)
}

fn run_migration(
    app: &AppHandle,
    manager: &Arc<CacheMigrationManager>,
    id: &str,
    source: &Path,
    target: &Path,
    staging: &Path,
    cancel: CancellationToken,
) {
    let access_guard = match lock_cache_exclusive() {
        Ok(guard) => guard,
        Err(error) => {
            let mut status = manager.status().unwrap_or_else(|| {
                make_status(id, "failed", source, target, staging, 0, 0, "迁移失败")
            });
            status.status = "failed".to_string();
            status.message = "迁移失败，仍在使用原缓存目录".to_string();
            status.error = Some(error);
            manager.finish(status.clone());
            let _ = app.emit(PROGRESS_EVENT, status);
            set_migrating(false);
            return;
        }
    };
    crate::tile_cache::Store::global().shutdown();

    let result = run_migration_inner(app, manager, id, source, target, staging, &cancel);

    match result {
        Ok(status) => {
            manager.finish(status.clone());
            let _ = app.emit(PROGRESS_EVENT, status);
        }
        Err(MigrationFailure::Cancelled) => {
            let _ = fs::remove_dir_all(staging);
            crate::tile_cache::set_root_dir(source.to_path_buf());
            let mut status = manager.status().unwrap_or_else(|| {
                make_status(id, "cancelled", source, target, staging, 0, 0, "迁移已取消")
            });
            status.status = "cancelled".to_string();
            status.message = "迁移已取消，原缓存未受影响".to_string();
            status.error = None;
            manager.finish(status.clone());
            let _ = app.emit(PROGRESS_EVENT, status);
        }
        Err(MigrationFailure::Error(error)) => {
            let _ = fs::remove_dir_all(staging);
            crate::tile_cache::set_root_dir(source.to_path_buf());
            let mut status = manager.status().unwrap_or_else(|| {
                make_status(id, "failed", source, target, staging, 0, 0, "迁移失败")
            });
            status.status = "failed".to_string();
            status.message = "迁移失败，仍在使用原缓存目录".to_string();
            status.error = Some(error);
            manager.finish(status.clone());
            let _ = app.emit(PROGRESS_EVENT, status);
        }
    }
    drop(access_guard);
    set_migrating(false);
}

fn run_migration_inner(
    app: &AppHandle,
    manager: &Arc<CacheMigrationManager>,
    id: &str,
    source: &Path,
    target: &Path,
    staging: &Path,
    cancel: &CancellationToken,
) -> Result<CacheMigrationStatus, MigrationFailure> {
    if staging.exists() {
        fs::remove_dir_all(staging).map_err(failure("清理旧迁移临时目录失败"))?;
    }
    fs::create_dir_all(staging).map_err(failure("创建迁移临时目录失败"))?;

    let files = collect_cache_files(source).map_err(MigrationFailure::Error)?;
    let total_bytes = files.iter().map(|f| f.size).sum();
    let file_count = files.len();
    let mut copied_bytes = 0u64;
    let mut last_progress_emit = Instant::now()
        .checked_sub(Duration::from_millis(100))
        .unwrap_or_else(Instant::now);

    for (index, entry) in files.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(MigrationFailure::Cancelled);
        }
        let destination = staging.join(&entry.name);
        copy_file_with_progress(&entry.path, &destination, cancel, |file_copied| {
            let current = copied_bytes.saturating_add(file_copied);
            if file_copied < entry.size && last_progress_emit.elapsed() < Duration::from_millis(100)
            {
                return;
            }
            last_progress_emit = Instant::now();
            let status = CacheMigrationStatus {
                migration_id: id.to_string(),
                status: "copying".to_string(),
                source_dir: source.to_string_lossy().to_string(),
                target_dir: target.to_string_lossy().to_string(),
                staging_dir: staging.to_string_lossy().to_string(),
                current_file: Some(entry.name.clone()),
                file_index: index + 1,
                file_count,
                copied_bytes: current,
                total_bytes,
                percent: percent(current, total_bytes),
                message: format!("正在复制 {}", entry.name),
                error: None,
            };
            manager.update_runtime_status(status.clone());
            let _ = app.emit(PROGRESS_EVENT, status);
        })?;
        copied_bytes = copied_bytes.saturating_add(entry.size);
    }

    let mut status = make_status(
        id,
        "verifying",
        source,
        target,
        staging,
        file_count,
        total_bytes,
        "正在校验缓存",
    );
    status.copied_bytes = copied_bytes;
    status.percent = if file_count == 0 { 100.0 } else { 0.0 };
    manager.set_status(status.clone());
    let _ = app.emit(PROGRESS_EVENT, &status);
    verify_migration_with_progress(source, staging, &files, Some(cancel), |verified, entry| {
        let verify_status = CacheMigrationStatus {
            migration_id: id.to_string(),
            status: "verifying".to_string(),
            source_dir: source.to_string_lossy().to_string(),
            target_dir: target.to_string_lossy().to_string(),
            staging_dir: staging.to_string_lossy().to_string(),
            current_file: Some(entry.name.clone()),
            file_index: verified,
            file_count,
            copied_bytes,
            total_bytes,
            percent: percent(verified as u64, file_count as u64),
            message: format!("正在校验 {}", entry.name),
            error: None,
        };
        manager.update_runtime_status(verify_status.clone());
        let _ = app.emit(PROGRESS_EVENT, verify_status);
    })?;

    if cancel.is_cancelled() {
        return Err(MigrationFailure::Cancelled);
    }

    status.file_index = file_count;
    status.current_file = None;
    status.percent = 100.0;
    status.status = "committing".to_string();
    status.message = "正在切换缓存目录".to_string();
    manager.set_status(status.clone());
    let _ = app.emit(PROGRESS_EVENT, &status);

    if cancel.is_cancelled() {
        return Err(MigrationFailure::Cancelled);
    }

    let settings_manager = SettingsManager::new().map_err(MigrationFailure::Error)?;
    commit_migration(
        source,
        target,
        staging,
        &settings_manager,
        crate::tile_cache::set_root_dir,
        || {
            crate::tile_cache::Store::global()
                .stats_during_migration()
                .map(|_| ())
        },
    )?;

    status.status = "completed".to_string();
    status.current_file = None;
    status.message = "缓存迁移完成，旧缓存仍保留".to_string();
    status.error = None;
    Ok(status)
}

fn commit_migration<S, V>(
    source: &Path,
    target: &Path,
    staging: &Path,
    settings_manager: &SettingsManager,
    mut set_root: S,
    mut verify_new_root: V,
) -> Result<(), MigrationFailure>
where
    S: FnMut(PathBuf),
    V: FnMut() -> Result<(), String>,
{
    let old_settings = settings_manager.get().map_err(MigrationFailure::Error)?;
    if target.exists() {
        fs::remove_dir(target).map_err(failure("移除空目标目录失败"))?;
    }
    fs::rename(staging, target).map_err(failure("提交目标缓存目录失败"))?;

    let mut new_settings = old_settings.clone();
    new_settings.tile_cache_dir = Some(target.to_string_lossy().to_string());
    if let Err(error) = settings_manager.save(&new_settings) {
        let rename_error = fs::rename(target, staging).err();
        return Err(MigrationFailure::Error(match rename_error {
            Some(rename_error) => format!(
                "保存新缓存目录失败: {}；恢复迁移目录失败: {}",
                error, rename_error
            ),
            None => format!("保存新缓存目录失败: {}", error),
        }));
    }

    set_root(target.to_path_buf());
    if let Err(error) = verify_new_root() {
        let settings_error = settings_manager.save(&old_settings).err();
        set_root(source.to_path_buf());
        let rename_error = fs::rename(target, staging).err();
        let mut details = vec![format!("新缓存目录验证失败: {}", error)];
        if let Some(error) = settings_error {
            details.push(format!("恢复原设置失败: {}", error));
        }
        if let Some(error) = rename_error {
            details.push(format!("恢复迁移目录失败: {}", error));
        }
        return Err(MigrationFailure::Error(details.join("；")));
    }
    Ok(())
}

#[derive(Debug)]
enum MigrationFailure {
    Cancelled,
    Error(String),
}

fn copy_file_with_progress<F>(
    source: &Path,
    target: &Path,
    cancel: &CancellationToken,
    mut progress: F,
) -> Result<(), MigrationFailure>
where
    F: FnMut(u64),
{
    let part = target.with_extension(format!(
        "{}.part",
        target.extension().and_then(|s| s.to_str()).unwrap_or("")
    ));
    let mut input = File::open(source).map_err(failure("打开源缓存文件失败"))?;
    let mut output = File::create(&part).map_err(failure("创建目标缓存文件失败"))?;
    let mut buffer = vec![0u8; COPY_BUFFER_SIZE];
    let mut copied = 0u64;
    loop {
        if cancel.is_cancelled() {
            drop(output);
            let _ = fs::remove_file(&part);
            return Err(MigrationFailure::Cancelled);
        }
        let count = input
            .read(&mut buffer)
            .map_err(failure("读取源缓存文件失败"))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(failure("写入目标缓存文件失败"))?;
        copied = copied.saturating_add(count as u64);
        progress(copied);
    }
    output.flush().map_err(failure("刷新目标缓存文件失败"))?;
    output.sync_all().map_err(failure("同步目标缓存文件失败"))?;
    drop(output);
    fs::rename(&part, target).map_err(failure("完成目标缓存文件失败"))?;
    Ok(())
}

fn verify_migration(
    source: &Path,
    staging: &Path,
    files: &[CacheFile],
) -> Result<(), MigrationFailure> {
    verify_migration_with_progress(source, staging, files, None, |_, _| {})
}

fn verify_migration_with_progress<F>(
    source: &Path,
    staging: &Path,
    files: &[CacheFile],
    cancel: Option<&CancellationToken>,
    mut progress: F,
) -> Result<(), MigrationFailure>
where
    F: FnMut(usize, &CacheFile),
{
    for (index, entry) in files.iter().enumerate() {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(MigrationFailure::Cancelled);
        }
        progress(index, entry);
        let target = staging.join(&entry.name);
        let target_size = target
            .metadata()
            .map_err(failure("读取目标缓存文件信息失败"))?
            .len();
        if target_size != entry.size {
            return Err(MigrationFailure::Error(format!(
                "文件大小校验失败: {}",
                entry.name
            )));
        }
        if entry.path.extension().and_then(|s| s.to_str()) == Some("mbtiles") {
            verify_mbtiles(&entry.path, &target)?;
        }
        progress(index + 1, entry);
    }
    if !source.exists() {
        return Err(MigrationFailure::Error(
            "迁移期间源缓存目录消失，已停止提交".to_string(),
        ));
    }
    Ok(())
}

fn verify_mbtiles(source: &Path, target: &Path) -> Result<(), MigrationFailure> {
    let source_conn = Connection::open(source).map_err(failure("打开源 MBTiles 校验失败"))?;
    let target_conn = Connection::open(target).map_err(failure("打开目标 MBTiles 校验失败"))?;
    let quick: String = target_conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(failure("执行 MBTiles quick_check 失败"))?;
    if quick != "ok" {
        return Err(MigrationFailure::Error(format!(
            "目标 MBTiles 校验失败: {}",
            quick
        )));
    }
    let source_count: u64 = source_conn
        .query_row("SELECT COUNT(*) FROM tiles", [], |row| row.get(0))
        .map_err(failure("读取源 MBTiles 瓦片数失败"))?;
    let target_count: u64 = target_conn
        .query_row("SELECT COUNT(*) FROM tiles", [], |row| row.get(0))
        .map_err(failure("读取目标 MBTiles 瓦片数失败"))?;
    if source_count != target_count {
        return Err(MigrationFailure::Error(format!(
            "MBTiles 瓦片数不一致: {} != {}",
            source_count, target_count
        )));
    }
    Ok(())
}

fn preflight(
    selected_target: &Path,
    has_active_tasks: bool,
) -> Result<CacheMigrationPreflight, String> {
    let source = crate::tile_cache::get_config().root_dir;
    let target = resolve_target_dir(selected_target)?;
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    if has_active_tasks {
        blockers.push("当前有下载任务正在使用缓存，请等待任务结束后再迁移".to_string());
    }
    if is_migrating() {
        blockers.push("已有缓存迁移正在进行".to_string());
    }
    if selected_target.as_os_str().is_empty() {
        blockers.push("请选择目标目录".to_string());
    }
    if paths_equivalent(&source, &target) {
        blockers.push("目标目录不能与当前缓存目录相同".to_string());
    }
    if is_nested(&source, &target) || is_nested(&target, &source) {
        blockers.push("源目录和目标目录不能互相包含".to_string());
    }
    if !source.exists() {
        blockers.push("当前缓存目录不存在".to_string());
    }

    let files = collect_cache_files(&source)?;
    let total_bytes = files.iter().map(|f| f.size).sum::<u64>();
    let required_bytes = total_bytes.saturating_add(SPACE_RESERVE_BYTES);
    if files.is_empty() {
        warnings.push("当前缓存目录为空，迁移后只会切换存储位置".to_string());
    }
    if target != selected_target {
        warnings.push(format!(
            "所选目录非空，将迁移到 {}",
            target.to_string_lossy()
        ));
    }

    if target.exists() {
        if !target.is_dir() {
            blockers.push("目标路径不是目录".to_string());
        } else if fs::read_dir(&target)
            .map_err(|e| format!("读取目标目录失败: {}", e))?
            .next()
            .is_some()
        {
            blockers.push("目标目录必须为空".to_string());
        }
    }

    let probe_parent = nearest_existing_parent(&target).ok_or("无法确定目标磁盘")?;
    let available_bytes = available_space_for_path(&probe_parent)?;
    if available_bytes < required_bytes {
        blockers.push(format!(
            "目标磁盘空间不足，需要至少 {} 字节，当前可用 {} 字节",
            required_bytes, available_bytes
        ));
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标父目录失败: {}", e))?;
    }
    let probe_dir = if target.exists() {
        target.as_path()
    } else {
        target.parent().ok_or("目标目录必须有父目录")?
    };
    let probe_path = probe_dir.join(format!(
        ".geo-downloader-write-test-{}",
        uuid::Uuid::new_v4()
    ));
    match File::create(&probe_path) {
        Ok(mut file) => {
            file.write_all(b"ok")
                .map_err(|e| format!("目标目录不可写: {}", e))?;
            drop(file);
            let _ = fs::remove_file(&probe_path);
        }
        Err(e) => blockers.push(format!("目标目录不可写: {}", e)),
    }

    Ok(CacheMigrationPreflight {
        source_dir: source.to_string_lossy().to_string(),
        target_dir: target.to_string_lossy().to_string(),
        total_bytes,
        file_count: files.len(),
        available_bytes,
        required_bytes,
        can_start: blockers.is_empty(),
        blockers,
        warnings,
    })
}

fn resolve_target_dir(selected: &Path) -> Result<PathBuf, String> {
    if !selected.exists() || !selected.is_dir() {
        return Ok(selected.to_path_buf());
    }
    let mut entries = fs::read_dir(selected).map_err(|e| format!("读取所选目录失败: {}", e))?;
    if entries.next().is_none() || !collect_cache_files(selected)?.is_empty() {
        return Ok(selected.to_path_buf());
    }
    Ok(selected.join("GeoDownloader").join("cache"))
}

#[derive(Debug)]
struct CacheFile {
    path: PathBuf,
    name: String,
    size: u64,
}

fn collect_cache_files(dir: &Path) -> Result<Vec<CacheFile>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("读取缓存目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取缓存文件失败: {}", e))?;
        let path = entry.path();
        if !path.is_file() || !is_cache_file(&path) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("缓存文件名不是有效 UTF-8")?
            .to_string();
        let size = entry
            .metadata()
            .map_err(|e| format!("读取缓存文件大小失败: {}", e))?
            .len();
        files.push(CacheFile { path, name, size });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

fn delete_recognized_cache_files(dir: &Path) -> Result<u64, String> {
    let files = collect_cache_files(dir)?;
    let size = files.iter().map(|file| file.size).sum();
    for file in files {
        fs::remove_file(&file.path)
            .map_err(|e| format!("删除旧缓存文件失败 {}: {}", file.path.display(), e))?;
    }
    if dir.exists()
        && fs::read_dir(dir)
            .map_err(|e| format!("读取旧缓存目录失败: {}", e))?
            .next()
            .is_none()
    {
        fs::remove_dir(dir).map_err(|e| format!("删除空旧缓存目录失败: {}", e))?;
    }
    Ok(size)
}

fn is_cache_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    name.ends_with(".mbtiles") || name.ends_with(".mbtiles-wal") || name.ends_with(".mbtiles-shm")
}

fn staging_path(target: &Path, id: &str) -> Result<PathBuf, String> {
    let parent = target.parent().ok_or("目标目录必须有父目录")?;
    Ok(parent.join(format!(".geo-downloader-migration-{}", id)))
}

fn validated_staging_path(status: &CacheMigrationStatus) -> Result<PathBuf, String> {
    let target = PathBuf::from(&status.target_dir);
    let expected = staging_path(&target, &status.migration_id)?;
    let actual = PathBuf::from(&status.staging_dir);
    if !paths_equivalent(&actual, &expected) {
        return Err("迁移临时目录与迁移记录不匹配，拒绝清理".to_string());
    }
    Ok(actual)
}

fn nearest_existing_parent(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.exists() {
            return Some(candidate.to_path_buf());
        }
        current = candidate.parent();
    }
    None
}

#[cfg(windows)]
fn available_space_for_path(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory_name: *const u16,
            free_bytes_available: *mut u64,
            total_number_of_bytes: *mut u64,
            total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(format!(
            "读取目标磁盘空间失败: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(available)
    }
}

#[cfg(not(windows))]
fn available_space_for_path(path: &Path) -> Result<u64, String> {
    let output = std::process::Command::new("df")
        .args(["-Pk"])
        .arg(path)
        .output()
        .map_err(|e| format!("执行 df 失败: {}", e))?;
    if !output.status.success() {
        return Err("读取目标磁盘空间失败".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .last()
        .ok_or("df 未返回磁盘信息")?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    let available_kb = fields
        .get(fields.len().saturating_sub(3))
        .ok_or("无法解析 df 可用空间")?
        .parse::<u64>()
        .map_err(|e| format!("无法解析 df 可用空间: {}", e))?;
    Ok(available_kb.saturating_mul(1024))
}

fn paths_equivalent(a: &Path, b: &Path) -> bool {
    normalize_path(a) == normalize_path(b)
}

fn is_nested(parent: &Path, child: &Path) -> bool {
    let parent = normalize_path(parent);
    let child = normalize_path(child);
    child != parent && child.starts_with(parent)
}

fn normalize_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn directory_size(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

fn make_status(
    id: &str,
    status: &str,
    source: &Path,
    target: &Path,
    staging: &Path,
    file_count: usize,
    total_bytes: u64,
    message: &str,
) -> CacheMigrationStatus {
    CacheMigrationStatus {
        migration_id: id.to_string(),
        status: status.to_string(),
        source_dir: source.to_string_lossy().to_string(),
        target_dir: target.to_string_lossy().to_string(),
        staging_dir: staging.to_string_lossy().to_string(),
        current_file: None,
        file_index: 0,
        file_count,
        copied_bytes: 0,
        total_bytes,
        percent: 0.0,
        message: message.to_string(),
        error: None,
    }
}

fn percent(current: u64, total: u64) -> f64 {
    if total == 0 {
        100.0
    } else {
        (current as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
    }
}

fn record_path() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|p| p.join("geo-downloader").join("cache-migration.json"))
        .ok_or_else(|| "无法获取应用数据目录".to_string())
}

fn save_record(status: &CacheMigrationStatus) -> Result<(), String> {
    let path = record_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(status).map_err(|e| e.to_string())?;
    crate::fs_util::atomic_write(&path, &bytes).map_err(|e| e.to_string())
}

fn load_record() -> Result<Option<CacheMigrationStatus>, String> {
    let path = record_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let status = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Some(status))
}

fn recover_interrupted_record(mut status: CacheMigrationStatus) -> CacheMigrationStatus {
    let settings_manager = match SettingsManager::new() {
        Ok(manager) => manager,
        Err(error) => {
            status.status = "failed".to_string();
            status.message = "检测到上次迁移未完成".to_string();
            status.error = Some(format!("读取设置失败，未自动处理迁移目录: {}", error));
            let _ = save_record(&status);
            return status;
        }
    };
    recover_interrupted_record_with_settings(status, &settings_manager, &|status| {
        let _ = save_record(status);
    })
}

fn recover_interrupted_record_with_settings<F>(
    mut status: CacheMigrationStatus,
    settings_manager: &SettingsManager,
    persist: &F,
) -> CacheMigrationStatus
where
    F: Fn(&CacheMigrationStatus),
{
    if !matches!(
        status.status.as_str(),
        "preflight" | "copying" | "verifying" | "committing"
    ) {
        return status;
    }

    let source = PathBuf::from(&status.source_dir);
    let target = PathBuf::from(&status.target_dir);
    let staging = PathBuf::from(&status.staging_dir);
    let mut settings = match settings_manager.get() {
        Ok(settings) => settings,
        Err(error) => {
            status.status = "failed".to_string();
            status.message = "检测到上次迁移未完成".to_string();
            status.error = Some(format!("读取设置失败，未自动处理迁移目录: {}", error));
            persist(&status);
            return status;
        }
    };
    let configured = settings
        .tile_cache_dir
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(crate::tile_cache::CacheConfig::default_root);

    if status.status == "committing" && paths_equivalent(&configured, &target) && target.exists() {
        let verification = collect_cache_files(&source).and_then(|files| {
            verify_migration(&source, &target, &files).map_err(|error| match error {
                MigrationFailure::Cancelled => "校验被取消".to_string(),
                MigrationFailure::Error(error) => error,
            })
        });
        if verification.is_ok() {
            status.status = "completed".to_string();
            status.current_file = None;
            status.copied_bytes = status.total_bytes;
            status.percent = 100.0;
            status.message = "缓存迁移已在上次退出前完成，旧缓存仍保留".to_string();
            status.error = None;
            persist(&status);
            return status;
        }
    }

    let mut recovery_errors = Vec::new();
    if paths_equivalent(&configured, &target) {
        settings.tile_cache_dir = Some(source.to_string_lossy().to_string());
        if let Err(error) = settings_manager.save(&settings) {
            recovery_errors.push(format!("恢复原缓存设置失败: {}", error));
        }
    }

    if status.status == "committing"
        && target.exists()
        && !staging.exists()
        && recovery_errors.is_empty()
    {
        if let Err(error) = fs::rename(&target, &staging) {
            recovery_errors.push(format!("恢复未提交目标目录失败: {}", error));
        }
    }

    status.status = "failed".to_string();
    status.message = "检测到上次迁移未完成，仍在使用原缓存目录".to_string();
    status.error = Some(if recovery_errors.is_empty() {
        "可安全清理迁移临时文件后重新开始".to_string()
    } else {
        recovery_errors.join("；")
    });
    persist(&status);
    status
}

fn failure<E: std::fmt::Display>(
    context: &'static str,
) -> impl FnOnce(E) -> MigrationFailure + Copy {
    move |e| MigrationFailure::Error(format!("{}: {}", context, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;
    use std::thread;
    use tempfile::tempdir;

    fn create_test_mbtiles(path: &Path, tile_count: u32) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE tiles (
                zoom_level INTEGER NOT NULL,
                tile_column INTEGER NOT NULL,
                tile_row INTEGER NOT NULL,
                tile_data BLOB NOT NULL,
                PRIMARY KEY (zoom_level, tile_column, tile_row)
            );",
        )
        .unwrap();
        for x in 0..tile_count {
            conn.execute("INSERT INTO tiles VALUES (1, ?1, 0, X'010203')", [x])
                .unwrap();
        }
    }

    fn interrupted_status(
        state: &str,
        source: &Path,
        target: &Path,
        staging: &Path,
    ) -> CacheMigrationStatus {
        CacheMigrationStatus {
            migration_id: "test-migration".to_string(),
            status: state.to_string(),
            source_dir: source.to_string_lossy().to_string(),
            target_dir: target.to_string_lossy().to_string(),
            staging_dir: staging.to_string_lossy().to_string(),
            current_file: None,
            file_index: 1,
            file_count: 1,
            copied_bytes: 1,
            total_bytes: 1,
            percent: 100.0,
            message: "test".to_string(),
            error: None,
        }
    }

    #[test]
    fn cache_file_filter_is_strict() {
        assert!(is_cache_file(Path::new("a.mbtiles")));
        assert!(is_cache_file(Path::new("a.mbtiles-wal")));
        assert!(is_cache_file(Path::new("a.mbtiles-shm")));
        assert!(!is_cache_file(Path::new("settings.json")));
        assert!(!is_cache_file(Path::new("a.tif")));
    }

    #[test]
    fn nested_paths_are_rejected() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let child = source.join("child");
        fs::create_dir_all(&child).unwrap();
        assert!(is_nested(&source, &child));
        assert!(!is_nested(&child, &source));
    }

    #[test]
    fn copy_can_be_cancelled_without_final_file() {
        let root = tempdir().unwrap();
        let source = root.path().join("source.mbtiles");
        let target = root.path().join("target.mbtiles");
        fs::write(&source, vec![7u8; 1024]).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = copy_file_with_progress(&source, &target, &cancel, |_| {});
        assert!(matches!(result, Err(MigrationFailure::Cancelled)));
        assert!(!target.exists());
    }

    #[test]
    fn copy_can_be_cancelled_mid_file_without_changing_source() {
        let root = tempdir().unwrap();
        let source = root.path().join("source.mbtiles");
        let target = root.path().join("target.mbtiles");
        let original = vec![7u8; COPY_BUFFER_SIZE * 3];
        fs::write(&source, &original).unwrap();
        let cancel = CancellationToken::new();
        let cancel_from_progress = cancel.clone();

        let result = copy_file_with_progress(&source, &target, &cancel, |copied| {
            if copied >= COPY_BUFFER_SIZE as u64 {
                cancel_from_progress.cancel();
            }
        });

        assert!(matches!(result, Err(MigrationFailure::Cancelled)));
        assert_eq!(fs::read(&source).unwrap(), original);
        assert!(!target.exists());
        assert!(!target.with_extension("mbtiles.part").exists());
    }

    #[test]
    fn copied_mbtiles_passes_integrity_verification() {
        let root = tempdir().unwrap();
        let source = root.path().join("source.mbtiles");
        let target = root.path().join("target.mbtiles");
        create_test_mbtiles(&source, 1);
        copy_file_with_progress(&source, &target, &CancellationToken::new(), |_| {}).unwrap();
        verify_mbtiles(&source, &target).unwrap();
    }

    #[test]
    fn multiple_real_mbtiles_copy_and_verify_without_source_changes() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let staging = root.path().join("staging");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&staging).unwrap();
        create_test_mbtiles(&source.join("a.mbtiles"), 3);
        create_test_mbtiles(&source.join("b.mbtiles"), 5);
        fs::write(source.join("notes.txt"), b"not cache").unwrap();
        let before_a = fs::read(source.join("a.mbtiles")).unwrap();
        let before_b = fs::read(source.join("b.mbtiles")).unwrap();

        let files = collect_cache_files(&source).unwrap();
        for file in &files {
            copy_file_with_progress(
                &file.path,
                &staging.join(&file.name),
                &CancellationToken::new(),
                |_| {},
            )
            .unwrap();
        }
        verify_migration(&source, &staging, &files).unwrap();

        assert_eq!(files.len(), 2);
        assert_eq!(fs::read(source.join("a.mbtiles")).unwrap(), before_a);
        assert_eq!(fs::read(source.join("b.mbtiles")).unwrap(), before_b);
        assert!(!staging.join("notes.txt").exists());
    }

    #[test]
    fn empty_cache_directory_verifies_as_empty_migration() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let staging = root.path().join("staging");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&staging).unwrap();
        let files = collect_cache_files(&source).unwrap();

        verify_migration(&source, &staging, &files).unwrap();

        assert!(files.is_empty());
    }

    #[test]
    fn copy_write_failure_keeps_source_unchanged() {
        let root = tempdir().unwrap();
        let source = root.path().join("source.mbtiles");
        fs::write(&source, b"source bytes").unwrap();
        let target = root.path().join("missing").join("target.mbtiles");

        let result = copy_file_with_progress(&source, &target, &CancellationToken::new(), |_| {});

        assert!(matches!(result, Err(MigrationFailure::Error(_))));
        assert_eq!(fs::read(source).unwrap(), b"source bytes");
    }

    #[test]
    fn ordinary_nonempty_selection_uses_dedicated_cache_subdirectory() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("existing.txt"), b"keep").unwrap();
        assert_eq!(
            resolve_target_dir(root.path()).unwrap(),
            root.path().join("GeoDownloader").join("cache")
        );
    }

    #[test]
    fn existing_cache_selection_is_not_silently_nested_or_overwritten() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("existing.mbtiles"), b"cache").unwrap();
        assert_eq!(resolve_target_dir(root.path()).unwrap(), root.path());
    }

    #[test]
    fn staging_cleanup_path_must_match_migration_id_and_target_parent() {
        let root = tempdir().unwrap();
        let target = root.path().join("cache");
        let expected = root.path().join(".geo-downloader-migration-test-migration");
        let valid = interrupted_status("failed", root.path(), &target, &expected);
        assert_eq!(validated_staging_path(&valid).unwrap(), expected);

        let invalid = interrupted_status(
            "failed",
            root.path(),
            &target,
            &root.path().join("unrelated"),
        );
        assert!(validated_staging_path(&invalid).is_err());
    }

    #[test]
    fn cancel_and_wait_does_not_return_before_worker_finishes() {
        let token = CancellationToken::new();
        let manager = Arc::new(CacheMigrationManager {
            active: Mutex::new(Some(ActiveMigration {
                id: "test".to_string(),
                cancel: token.clone(),
            })),
            active_changed: Condvar::new(),
            status: Mutex::new(None),
        });
        let waiter_manager = manager.clone();
        let waiter = thread::spawn(move || waiter_manager.cancel_and_wait());

        for _ in 0..100 {
            if token.is_cancelled() {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(token.is_cancelled());
        assert!(!waiter.is_finished());

        *manager.active.lock().unwrap() = None;
        manager.active_changed.notify_all();
        waiter.join().unwrap();
    }

    #[test]
    fn startup_recovery_finalizes_a_valid_committed_target() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let staging = root.path().join("staging");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        create_test_mbtiles(&source.join("source.mbtiles"), 4);
        fs::copy(source.join("source.mbtiles"), target.join("source.mbtiles")).unwrap();
        let settings_manager = SettingsManager::from_file_path(root.path().join("settings.json"));
        let mut settings = AppSettings::default();
        settings.tile_cache_dir = Some(target.to_string_lossy().to_string());
        settings_manager.save(&settings).unwrap();

        let recovered = recover_interrupted_record_with_settings(
            interrupted_status("committing", &source, &target, &staging),
            &settings_manager,
            &|_| {},
        );

        assert_eq!(recovered.status, "completed");
        assert!(target.exists());
        assert!(!staging.exists());
        assert_eq!(
            settings_manager.get().unwrap().tile_cache_dir,
            Some(target.to_string_lossy().to_string())
        );
    }

    #[test]
    fn startup_recovery_moves_an_uncommitted_target_back_to_staging() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let staging = root.path().join("staging");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        create_test_mbtiles(&source.join("source.mbtiles"), 2);
        fs::copy(source.join("source.mbtiles"), target.join("source.mbtiles")).unwrap();
        let settings_manager = SettingsManager::from_file_path(root.path().join("settings.json"));
        let mut settings = AppSettings::default();
        settings.tile_cache_dir = Some(source.to_string_lossy().to_string());
        settings_manager.save(&settings).unwrap();

        let recovered = recover_interrupted_record_with_settings(
            interrupted_status("committing", &source, &target, &staging),
            &settings_manager,
            &|_| {},
        );

        assert_eq!(recovered.status, "failed");
        assert!(!target.exists());
        assert!(staging.join("source.mbtiles").exists());
        assert_eq!(
            settings_manager.get().unwrap().tile_cache_dir,
            Some(source.to_string_lossy().to_string())
        );
    }

    #[test]
    fn commit_updates_settings_only_after_staging_is_ready() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let staging = root.path().join("staging");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&staging).unwrap();
        create_test_mbtiles(&staging.join("source.mbtiles"), 3);
        let settings_manager = SettingsManager::from_file_path(root.path().join("settings.json"));
        let mut settings = AppSettings::default();
        settings.tile_cache_dir = Some(source.to_string_lossy().to_string());
        settings_manager.save(&settings).unwrap();
        let current_root = Arc::new(Mutex::new(source.clone()));
        let root_for_set = current_root.clone();

        commit_migration(
            &source,
            &target,
            &staging,
            &settings_manager,
            move |path| *root_for_set.lock().unwrap() = path,
            || {
                verify_mbtiles(
                    &target.join("source.mbtiles"),
                    &target.join("source.mbtiles"),
                )
                .map_err(|error| format!("{:?}", error))
            },
        )
        .unwrap();

        assert!(!staging.exists());
        assert!(target.join("source.mbtiles").exists());
        assert_eq!(*current_root.lock().unwrap(), target);
        assert_eq!(
            settings_manager.get().unwrap().tile_cache_dir,
            Some(target.to_string_lossy().to_string())
        );
    }

    #[test]
    fn commit_verification_failure_restores_settings_root_and_staging() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let staging = root.path().join("staging");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&staging).unwrap();
        create_test_mbtiles(&staging.join("source.mbtiles"), 2);
        let settings_manager = SettingsManager::from_file_path(root.path().join("settings.json"));
        let mut settings = AppSettings::default();
        settings.tile_cache_dir = Some(source.to_string_lossy().to_string());
        settings_manager.save(&settings).unwrap();
        let current_root = Arc::new(Mutex::new(source.clone()));
        let root_for_set = current_root.clone();

        let result = commit_migration(
            &source,
            &target,
            &staging,
            &settings_manager,
            move |path| *root_for_set.lock().unwrap() = path,
            || Err("simulated verification failure".to_string()),
        );

        assert!(matches!(result, Err(MigrationFailure::Error(_))));
        assert!(!target.exists());
        assert!(staging.join("source.mbtiles").exists());
        assert_eq!(*current_root.lock().unwrap(), source);
        assert_eq!(
            settings_manager.get().unwrap().tile_cache_dir,
            Some(source.to_string_lossy().to_string())
        );
    }

    #[test]
    fn deleting_old_cache_preserves_unrecognized_files() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("source.mbtiles"), b"cache").unwrap();
        fs::write(root.path().join("keep-me.txt"), b"user data").unwrap();

        let deleted = delete_recognized_cache_files(root.path()).unwrap();

        assert_eq!(deleted, 5);
        assert!(!root.path().join("source.mbtiles").exists());
        assert_eq!(
            fs::read(root.path().join("keep-me.txt")).unwrap(),
            b"user data"
        );
    }
}
