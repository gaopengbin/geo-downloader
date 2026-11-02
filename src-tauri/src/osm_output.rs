//! OSM file commit and terminal history identity, without changing the task states.
use crate::{
    history::{DownloadRecord, DownloadStatus},
    task::{TaskInfo, TaskManager, TaskStatus},
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) fn absolute_output(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("请选择 OSM 文件保存位置".into());
    }
    let path = Path::new(path);
    if path.file_name().is_none() {
        return Err("OSM 保存位置必须是文件路径".into());
    }
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("无法确定保存目录: {e}"))?
            .join(path)
    })
}

pub(crate) fn write_geojson(
    path: &Path,
    data: &serde_json::Value,
    cancelled: impl Fn() -> bool,
) -> Result<u64, String> {
    if cancelled() {
        return Err("已取消".into());
    }
    if data.get("type").and_then(|v| v.as_str()) != Some("FeatureCollection")
        || !data
            .get("features")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err("OSM 返回内容不是有效的 GeoJSON 要素集合".into());
    }
    let bytes = serde_json::to_vec_pretty(data).map_err(|e| format!("序列化失败: {e}"))?;
    let temporary = path.with_file_name(format!(".osm-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<u64, String> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| format!("创建 OSM 临时文件失败: {e}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("保存 OSM 文件失败: {e}"))?;
        drop(file);
        if cancelled() {
            return Err("已取消".into());
        }
        fs::rename(&temporary, path).map_err(|e| format!("提交 OSM 文件失败: {e}"))?;
        let meta = fs::metadata(path).map_err(|e| format!("无法核验已保存文件: {e}"))?;
        if !meta.is_file() || meta.len() != bytes.len() as u64 {
            return Err("OSM 输出文件大小核验失败".into());
        }
        Ok(meta.len())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn settle_task(
    manager: &TaskManager,
    id: &str,
    result: Result<u64, String>,
    cancelled: bool,
) -> Option<TaskInfo> {
    if cancelled || manager.is_cancelled(id) {
        manager.mark_cancelled(id);
    } else {
        match result {
            Ok(size) => manager.complete_task(id, size),
            Err(error) => manager.fail_task(id, error),
        }
    }
    manager
        .get_all_tasks()
        .into_iter()
        .find(|task| task.id == id)
}

pub(crate) fn history_record(task: &TaskInfo) -> Option<DownloadRecord> {
    if task.source != "osm_vector" {
        return None;
    }
    let status = match task.status {
        TaskStatus::Completed => DownloadStatus::Completed,
        TaskStatus::Failed => DownloadStatus::Failed,
        _ => return None,
    };
    let mut record = DownloadRecord::new(
        task.name.clone(),
        task.source.clone(),
        task.source_name.clone(),
        task.zoom,
        task.format.clone(),
        task.save_path.clone(),
        task.file_size,
        task.total,
        task.failed_count,
        status,
    );
    // Same ID is the only deduplication key. Never merge unrelated jobs by path.
    record.id = task.id.clone();
    record.error = task.error.clone();
    Some(record)
}

pub(crate) fn require_output_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!(
            "输出文件不存在或已移动，请核对保存路径：{}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{history::HistoryStore, task::TaskManager};
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn data() -> serde_json::Value {
        serde_json::json!({"type":"FeatureCollection","features":[]})
    }
    #[test]
    fn writes_complete_unicode_geojson_and_replaces_existing_file() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("道路 输出.geojson");
        fs::write(&path, b"old output").unwrap();
        let size = write_geojson(&path, &data(), || false).unwrap();
        require_output_file(&path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), size);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(path).unwrap()).unwrap(),
            data()
        );
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    }
    #[test]
    fn cancelled_commit_preserves_old_output_and_cleans_the_temporary_file() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("out.geojson");
        fs::write(&path, b"existing").unwrap();
        let checks = AtomicUsize::new(0);
        assert!(
            write_geojson(&path, &data(), || checks.fetch_add(1, Ordering::Relaxed)
                > 0)
            .is_err()
        );
        assert_eq!(fs::read(path).unwrap(), b"existing");
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    }
    #[test]
    fn write_failure_and_invalid_payload_do_not_create_a_successful_output() {
        let d = tempfile::tempdir().unwrap();
        let blocked = d.path().join("file");
        fs::write(&blocked, b"keep").unwrap();
        assert!(write_geojson(&blocked.join("out.geojson"), &data(), || false).is_err());
        assert!(write_geojson(
            &d.path().join("error.geojson"),
            &serde_json::json!({"error":"server refused"}),
            || false
        )
        .is_err());
        assert_eq!(fs::read(blocked).unwrap(), b"keep");
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    }
    #[cfg(windows)]
    #[test]
    fn locked_destination_keeps_its_previous_contents() {
        use std::os::windows::fs::OpenOptionsExt;
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("locked.geojson");
        fs::write(&path, b"previous output").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(write_geojson(&path, &data(), || false).is_err());
        drop(lock);
        assert_eq!(fs::read(path).unwrap(), b"previous output");
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    }
    #[test]
    fn failure_history_survives_reopen_and_is_idempotent() {
        let d = tempfile::tempdir().unwrap();
        let manager = TaskManager::new_with_log_dir(d.path().join("logs"));
        let id = "12345678-1234-1234-1234-123456789abc";
        manager.create_task(
            id.into(),
            "OSM 道路".into(),
            "osm_vector".into(),
            "OSM Overpass".into(),
            0,
            "geojson".into(),
            "C:/data/osm.geojson".into(),
            0,
        );
        let task = settle_task(&manager, id, Err("Overpass 请求失败".into()), false).unwrap();
        let record = history_record(&task).unwrap();
        assert_eq!(record.status, DownloadStatus::Failed);
        let store = HistoryStore::open_at(&d.path().join("history")).unwrap();
        store.add(&record).unwrap();
        store.add(&record).unwrap();
        drop(store);
        let store = HistoryStore::open_at(&d.path().join("history")).unwrap();
        assert_eq!(store.page(1, 20).unwrap().total, 1);
        let saved = store.get(id).unwrap().unwrap();
        assert_eq!(saved.error.as_deref(), Some("Overpass 请求失败"));
        assert_eq!(saved.file_path, "C:/data/osm.geojson");
    }
    #[test]
    fn cancelled_jobs_are_not_recorded_as_failed_or_completed() {
        let d = tempfile::tempdir().unwrap();
        let m = TaskManager::new_with_log_dir(d.path().into());
        m.create_task(
            "cancel".into(),
            "OSM".into(),
            "osm_vector".into(),
            "OSM".into(),
            0,
            "geojson".into(),
            "out.geojson".into(),
            0,
        );
        m.cancel_task("cancel");
        let task = settle_task(&m, "cancel", Ok(100), false).unwrap();
        assert_eq!(task.status, TaskStatus::Cancelled);
        assert!(history_record(&task).is_none());
    }
    #[test]
    fn missing_geojson_is_reported_instead_of_opening_an_unrelated_ancestor() {
        let d = tempfile::tempdir().unwrap();
        assert!(require_output_file(&d.path().join("missing.geojson")).is_err());
        assert!(require_output_file(d.path()).is_err());
    }
    #[test]
    fn a_real_save_failure_is_settled_as_failed_without_false_completion() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("missing").join("out.geojson");
        let manager = TaskManager::new_with_log_dir(d.path().join("logs"));
        manager.create_task(
            "write-failed".into(),
            "OSM".into(),
            "osm_vector".into(),
            "OSM".into(),
            0,
            "geojson".into(),
            path.to_string_lossy().into_owned(),
            0,
        );
        let task = settle_task(
            &manager,
            "write-failed",
            write_geojson(&path, &data(), || false),
            false,
        )
        .unwrap();
        assert_eq!(task.status, TaskStatus::Failed);
        assert!(task.progress < 100.0);
        assert!(!path.exists());
        assert!(history_record(&task).unwrap().error.is_some());
    }
    #[test]
    fn completed_history_points_to_the_verified_file() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("roads.geojson");
        let manager = TaskManager::new_with_log_dir(d.path().join("logs"));
        manager.create_task(
            "done".into(),
            "OSM".into(),
            "osm_vector".into(),
            "OSM".into(),
            0,
            "geojson".into(),
            path.to_string_lossy().into_owned(),
            0,
        );
        let task = settle_task(
            &manager,
            "done",
            write_geojson(&path, &data(), || false),
            false,
        )
        .unwrap();
        let record = history_record(&task).unwrap();
        assert_eq!(record.id, "done");
        assert_eq!(record.status, DownloadStatus::Completed);
        assert_eq!(
            record.file_size,
            fs::metadata(&record.file_path).unwrap().len()
        );
        assert!(record.error.is_none());
    }
}
