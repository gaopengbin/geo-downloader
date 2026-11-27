pub mod tileset;
pub mod filter;
pub mod fetcher;

pub(crate) fn history_record(
    task_id: &str,
    name: &str,
    source_name: &str,
    save_path: &str,
    tile_count: u32,
    result: Result<u64, &str>,
) -> crate::history::DownloadRecord {
    use crate::history::{DownloadRecord, DownloadStatus};

    let (status, size, error) = match result {
        Ok(size) => (DownloadStatus::Completed, size, None),
        Err(error) => (DownloadStatus::Failed, 0, Some(error.to_owned())),
    };
    let mut record = DownloadRecord::new(
        name.to_owned(), "3dtiles".into(), source_name.to_owned(), 0, "tileset".into(),
        save_path.to_owned(), size, tile_count, 0, status,
    );
    record.id = task_id.to_owned();
    record.error = error;
    record
}

#[cfg(test)]
mod history_tests {
    use super::history_record;
    use crate::history::{DownloadStatus, HistoryStore};

    #[test]
    fn failed_3d_task_reopens_with_the_original_id_and_storage_error() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("blocked-output");
        std::fs::write(&target, b"existing file").unwrap();
        let error = std::fs::create_dir_all(target.join("tiles")).unwrap_err().to_string();
        let dest = target.to_str().unwrap();
        let failed_id = uuid::Uuid::new_v4().to_string();
        let completed_id = uuid::Uuid::new_v4().to_string();
        let db = HistoryStore::open_at(root.path()).unwrap();
        let failed = history_record(&failed_id, "3D test", "local tiles", dest, 2, Err(&error));
        db.add(&failed).unwrap();
        db.add(&failed).unwrap();
        db.add(&history_record(&completed_id, "second task", "local tiles", dest, 2, Ok(428))).unwrap();
        drop(db);

        let reopened = HistoryStore::open_at(root.path()).unwrap();
        let saved = reopened.get(&failed_id).unwrap().unwrap();
        assert_eq!(saved.status, DownloadStatus::Failed);
        assert_eq!(saved.error.as_deref(), Some(error.as_str()));
        assert_eq!((saved.source.as_str(), saved.format.as_str(), saved.tile_count), ("3dtiles", "tileset", 2));
        let success = reopened.get(&completed_id).unwrap().unwrap();
        assert_eq!((success.status, success.file_size, success.error), (DownloadStatus::Completed, 428, None));
        assert_eq!(reopened.page(1, 10).unwrap().total, 2);
    }
}
