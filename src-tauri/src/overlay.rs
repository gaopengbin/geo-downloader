//! Composite one tile at a time and retain only file paths for export.
use crate::merger::TileSource;
use crate::pause_control::PauseControl;
use image::{DynamicImage, ImageFormat};
use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub const OVERLAY_DOWNLOAD_END: f64 = 60.0;
pub const COMPOSITE_END: f64 = 88.0;

/// Report completed work, not elapsed-time estimates. Final updates bypass throttling.
pub struct TileStageReporter {
    start: f64,
    end: f64,
    label: String,
    last_emit: Option<Instant>,
    last_log: Option<Instant>,
    last_bucket: usize,
}

pub struct TileStageUpdate {
    pub percent: f64,
    pub message: String,
    pub log: bool,
}

impl TileStageReporter {
    pub fn new(start: f64, end: f64, label: &str) -> Self {
        Self { start, end, label: label.into(), last_emit: None, last_log: None, last_bucket: 0 }
    }

    pub fn update(&mut self, processed: usize, total: usize) -> Option<TileStageUpdate> {
        self.update_at(processed, total, Instant::now())
    }

    fn update_at(&mut self, processed: usize, total: usize, now: Instant) -> Option<TileStageUpdate> {
        let processed = processed.min(total);
        let terminal = processed == total;
        if !terminal && self.last_emit.is_some_and(|last| now.duration_since(last) < Duration::from_millis(500)) {
            return None;
        }
        let fraction = if total == 0 { 1.0 } else { processed as f64 / total as f64 };
        let bucket = (fraction * 10.0).floor() as usize;
        let log = terminal || self.last_log.is_none()
            || bucket > self.last_bucket
            || self.last_log.is_some_and(|last| now.duration_since(last) >= Duration::from_secs(30));
        self.last_emit = Some(now);
        if log { self.last_log = Some(now); }
        self.last_bucket = self.last_bucket.max(bucket);
        Some(TileStageUpdate {
            percent: self.start + (self.end - self.start) * fraction,
            message: format!("{}：{}/{}", self.label, processed, total),
            log,
        })
    }
}

pub struct LayerDownloadReporter {
    index: usize,
    count: usize,
    start: f64,
    name: String,
    last_emit: Option<Instant>,
    last_log: Option<Instant>,
    last_paused: Option<bool>,
    last_bucket: u32,
}

pub struct LayerDownloadUpdate {
    pub percent: f64,
    pub message: String,
    pub paused: bool,
    pub log: bool,
}

impl LayerDownloadReporter {
    pub fn new(index: usize, count: usize, name: &str) -> Self {
        Self {
            index,
            count: count.max(1),
            start: main_download_end(count),
            name: name.into(),
            last_emit: None,
            last_log: None,
            last_paused: None,
            last_bucket: 0,
        }
    }

    pub fn update(
        &mut self,
        progress: &crate::downloader::DownloadProgress,
    ) -> Option<LayerDownloadUpdate> {
        self.update_at(progress, Instant::now())
    }

    fn update_at(
        &mut self,
        progress: &crate::downloader::DownloadProgress,
        now: Instant,
    ) -> Option<LayerDownloadUpdate> {
        let paused = progress.status == "paused";
        let terminal = progress.status.starts_with("completed");
        if !terminal
            && self.last_paused == Some(paused)
            && self
                .last_emit
                .is_some_and(|last| now.duration_since(last) < Duration::from_millis(500))
        {
            return None;
        }
        let fraction = (progress.completed as f64 / progress.total.max(1) as f64).clamp(0.0, 1.0);
        let bucket = (fraction * 10.0).floor() as u32;
        let log = terminal
            || self.last_paused != Some(paused)
            || bucket > self.last_bucket
            || self
                .last_log
                .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(30));
        self.last_emit = Some(now);
        self.last_paused = Some(paused);
        self.last_bucket = self.last_bucket.max(bucket);
        if log {
            self.last_log = Some(now);
        }
        let state = match progress.status.as_str() {
            "downloading" => "下载中",
            "paused" => "已暂停",
            "completed" => "下载完成",
            "completed_with_errors" => "下载完成，有失败瓦片",
            "completed_with_no_data" => "下载完成，有无数据瓦片",
            state => state,
        };
        Some(LayerDownloadUpdate {
            // Allocate download progress across main imagery and annotation layers.
            percent: self.start
                + (OVERLAY_DOWNLOAD_END - self.start) * (self.index as f64 + fraction) / self.count as f64,
            message: format!(
                "注记 {}/{} [{}]：{}/{}，失败 {}，无数据 {}；{}",
                self.index + 1,
                self.count,
                self.name,
                progress.completed,
                progress.total,
                progress.failed,
                progress.no_data,
                state
            ),
            paused,
            log,
        })
    }
}

pub fn main_download_end(overlay_count: usize) -> f64 {
    if overlay_count == 0 { 85.0 } else { OVERLAY_DOWNLOAD_END / (overlay_count as f64 + 1.0) }
}

/// Only a bounded batch of paths crosses into the blocking image worker.
/// Each encoded PNG is written directly to disk, never retained in the map.
pub async fn composite_tiles_to_disk(
    tiles: &mut HashMap<(u32, u32), TileSource>,
    layers: &[HashMap<(u32, u32), TileSource>],
    directory: &Path,
    cancellation: &CancellationToken,
    pause: &PauseControl,
    mut progress: impl FnMut(usize, usize),
) -> Result<(usize, usize), String> {
    let coordinates: Vec<_> = tiles.keys().copied().collect();
    let mut successful = 0;
    let mut processed = 0;
    for chunk in coordinates.chunks(64) {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err("任务已取消".into()),
            _ = pause.wait_if_paused() => {},
        }
        crate::fs_util::ensure_minimum_free_space(directory)?;
        let batch: Vec<_> = chunk
            .iter()
            .map(|&coord| {
                let main = tiles[&coord].clone();
                let overlays = layers
                    .iter()
                    .filter_map(|layer| layer.get(&coord).cloned())
                    .collect::<Vec<_>>();
                (coord, main, overlays)
            })
            .collect();
        let output = directory.to_path_buf();
        let token = cancellation.clone();
        let results = tokio::task::spawn_blocking(move || {
            let mut results = Vec::with_capacity(batch.len());
            for (coord, main, overlays) in batch {
                if token.is_cancelled() {
                    return Err("任务已取消".to_string());
                }
                let path = output
                    .join(coord.0.to_string())
                    .join(format!("{}.png", coord.1));
                let composited = composite_tile_to_disk(&main, &overlays, &path)?;
                results.push((coord, composited.then_some(path)));
            }
            Ok(results)
        })
        .await
        .map_err(|e| format!("合成叠加瓦片失败: {e}"))??;
        if cancellation.is_cancelled() {
            return Err("任务已取消".into());
        }
        for (coord, path) in results {
            processed += 1;
            if let Some(path) = path {
                tiles.insert(coord, TileSource::from_path(path));
                successful += 1;
            }
        }
        progress(processed, coordinates.len());
    }
    Ok((successful, processed - successful))
}

/// Returns false when no usable overlay matches the main tile.
/// Main/overlay inputs remain intact so an interrupted task can safely restart.
pub fn composite_tile_to_disk(
    main: &TileSource,
    overlays: &[TileSource],
    destination: &Path,
) -> Result<bool, String> {
    if overlays.is_empty() {
        return Ok(false);
    }
    let bytes = main.bytes().map_err(|e| format!("读取主瓦片失败: {e}"))?;
    let mut base = match crate::tile_payload::decode_image(&bytes) {
        Ok(image) => image.to_rgba8(),
        Err(_) => return Ok(false),
    };
    drop(bytes);
    let mut layered = false;
    for overlay in overlays {
        let Ok(bytes) = overlay.bytes() else { continue };
        let Ok(image) = crate::tile_payload::decode_image(&bytes) else {
            continue;
        };
        let rgba = image.to_rgba8();
        if rgba.dimensions() == base.dimensions() {
            image::imageops::overlay(&mut base, &rgba, 0, 0);
            layered = true;
        }
    }
    if !layered {
        return Ok(false);
    }
    let parent = destination.parent().ok_or("合成瓦片路径无效")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建合成瓦片目录失败: {e}"))?;
    let partial = destination.with_extension("overlay-part");
    let result = (|| {
        let file = std::fs::File::create(&partial)?;
        let mut writer = BufWriter::with_capacity(64 * 1024, file);
        DynamicImage::ImageRgba8(base)
            .write_to(&mut writer, ImageFormat::Png)
            .map_err(std::io::Error::other)?;
        writer.flush()?;
        drop(writer);
        std::fs::rename(&partial, destination)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("写入合成瓦片失败: {error}"));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn download_progress(completed: u32, status: &str) -> crate::downloader::DownloadProgress {
        crate::downloader::DownloadProgress {
            total: 336_660,
            completed,
            failed: 0,
            no_data: 0,
            browse_filled: 0,
            status: status.into(),
        }
    }

    #[test]
    fn stage_updates_throttle_but_force_final_counts_and_keep_completion_below_100() {
        let now = Instant::now();
        let mut reporter = TileStageReporter::new(88.0, 99.0, "写出原始瓦片目录");
        let initial = reporter.update_at(0, 336_660, now).unwrap();
        assert_eq!(initial.percent, 88.0);
        assert!(initial.message.contains("0/336660"));
        assert!(initial.log);
        assert!(reporter.update_at(1, 336_660, now + Duration::from_millis(10)).is_none());
        let middle = reporter.update_at(168_330, 336_660, now + Duration::from_millis(500)).unwrap();
        assert_eq!(middle.percent, 93.5);
        assert!(middle.message.contains("168330/336660"));
        let end = reporter.update_at(336_660, 336_660, now + Duration::from_millis(501)).unwrap();
        assert_eq!(end.percent, 99.0);
        assert!(end.log && end.message.contains("336660/336660"));
        assert_eq!(TileStageReporter::new(88.0, 99.0, "空任务").update_at(0, 0, now).unwrap().percent, 99.0);
    }

    #[test]
    fn large_overlay_job_advances_through_download_composite_and_export_without_regression() {
        let now = Instant::now();
        for count in [1, 3] {
            let mut previous = main_download_end(count);
            for index in 0..count {
                let update = LayerDownloadReporter::new(index, count, "注记")
                    .update_at(&download_progress(336_660, "completed"), now).unwrap();
                assert!(update.percent >= previous);
                previous = update.percent;
            }
            assert_eq!(previous, 60.0);
            for (start, end, label) in [(60.0, 88.0, "合成叠加瓦片"), (88.0, 99.0, "写出原始瓦片目录")] {
                let mut reporter = TileStageReporter::new(start, end, label);
                for step in 0..=10 {
                    let update = reporter.update_at(step * 33_666, 336_660, now + Duration::from_secs(step as u64)).unwrap();
                    assert!(update.percent >= previous && update.percent <= end);
                    // Multi-zoom overall progress uses the same affine mapping.
                    assert!(25.0 + update.percent * 0.5 >= 25.0 + previous * 0.5);
                    previous = update.percent;
                }
            }
            assert_eq!(previous, 99.0);
        }
    }

    #[test]
    #[ignore = "requires the recorded 336660-tile stress trace"]
    fn replay_large_task_progress_trace() {
        let trace = std::fs::read_to_string(std::env::var("GEOD_PROGRESS_TRACE").expect("trace path")).unwrap();
        let now = Instant::now();
        let mut layers: Vec<_> = (0..3).map(|i| LayerDownloadReporter::new(i,3,"注记")).collect();
        let mut composite = TileStageReporter::new(OVERLAY_DOWNLOAD_END,COMPOSITE_END,"合成叠加瓦片");
        let mut previous = 0.0;
        let mut output = Vec::new();
        for line in trace.lines() {
            let event: serde_json::Value = serde_json::from_str(line).unwrap();
            let phase = event["phase"].as_str().unwrap();
            let done = event["done"].as_u64().unwrap() as usize;
            let total = event["total"].as_u64().unwrap() as usize;
            let elapsed = event["elapsed_seconds"].as_f64().unwrap();
            let instant = now + Duration::from_secs_f64(elapsed);
            let percent = match phase {
                "main" => Some(main_download_end(3)*done as f64/total as f64),
                "annotation-1" | "annotation-2" | "annotation-3" => {
                    let index = phase.chars().last().unwrap().to_digit(10).unwrap() as usize-1;
                    layers[index].update_at(&download_progress(done as u32,if done==total {"completed"} else {"downloading"}),instant).map(|u|u.percent)
                },
                "composite" => composite.update_at(done,total,instant).map(|u|u.percent),
                "raw-export" => Some(88.0),
                "completed" => Some(100.0),
                _ => None,
            };
            if let Some(percent) = percent {
                assert!(percent>=previous && percent<=100.0,"regression at {phase}: {previous} -> {percent}");
                previous=percent;
                output.push(serde_json::json!({"phase":phase,"done":done,"total":total,"elapsed_seconds":elapsed,"percent":percent}));
            }
        }
        assert_eq!(previous,100.0);
        let composite: Vec<_> = output.iter().filter(|e|e["phase"]=="composite").collect();
        assert_eq!(composite.first().unwrap()["percent"],60.0);
        assert_eq!(composite.last().unwrap()["percent"],88.0);
        assert!(composite.len()>1000);
        if let Ok(path) = std::env::var("GEOD_PROGRESS_REPLAY_OUTPUT") {
            std::fs::write(path,serde_json::to_vec_pretty(&output).unwrap()).unwrap();
        }
        println!("replayed_events={} composite_events={} composite_range=60..88 regressions=0",output.len(),composite.len());
    }

    #[test]
    fn annotation_progress_covers_each_layer_and_preserves_pause_retry_and_no_data() {
        let now = Instant::now();
        assert_eq!(main_download_end(0), 85.0);
        let mut previous = main_download_end(3);
        for index in 0..3 {
            let mut reporter = LayerDownloadReporter::new(index, 3, "测试注记");
            for step in 0..=10 {
                let mut progress = download_progress(
                    step * 33_666,
                    if step == 10 {
                        "completed_with_no_data"
                    } else {
                        "读取缓存瓦片"
                    },
                );
                progress.no_data = 12;
                let update = reporter
                    .update_at(&progress, now + Duration::from_secs(step as u64))
                    .unwrap();
                assert!(update.percent >= previous && update.percent <= OVERLAY_DOWNLOAD_END);
                assert!(update.message.contains(&format!("注记 {}/3", index + 1)));
                assert!(update.message.contains("无数据 12"));
                previous = update.percent;
            }
        }
        assert_eq!(previous, OVERLAY_DOWNLOAD_END);
        let mut reporter = LayerDownloadReporter::new(0, 1, "测试");
        assert!(
            reporter
                .update_at(&download_progress(0, "downloading"), now)
                .unwrap()
                .log
        );
        assert!(reporter
            .update_at(
                &download_progress(1, "downloading"),
                now + Duration::from_millis(1)
            )
            .is_none());
        assert!(
            reporter
                .update_at(
                    &download_progress(1, "paused"),
                    now + Duration::from_millis(2)
                )
                .unwrap()
                .paused
        );
        assert!(
            !reporter
                .update_at(
                    &download_progress(1, "downloading"),
                    now + Duration::from_millis(3)
                )
                .unwrap()
                .paused
        );
        let retry = reporter
            .update_at(
                &download_progress(1, "重试第1轮：等待"),
                now + Duration::from_secs(31),
            )
            .unwrap();
        assert!(retry.log && retry.message.contains("重试第1轮"));
        assert!(
            reporter
                .update_at(
                    &download_progress(336_660, "completed"),
                    now + Duration::from_secs(31)
                )
                .unwrap()
                .log
        );
    }

    #[tokio::test]
    async fn large_three_layer_task_cancels_after_a_bounded_batch() {
        let dir = tempfile::tempdir().unwrap();
        let (mut tiles, layers) = fixture_with_size(dir.path(), 336_660, 256);
        let token = CancellationToken::new();
        let output = dir.path().join("large-output");
        let result = composite_tiles_to_disk(
            &mut tiles,
            &layers,
            &output,
            &token,
            &PauseControl::default(),
            |processed, total| {
                assert_eq!(processed, 64);
                assert_eq!(total, 336_660);
                token.cancel();
            },
        )
        .await;
        assert!(result.unwrap_err().contains("取消"));
        assert_eq!(
            tiles
                .values()
                .filter(|tile| matches!(tile, TileSource::Path(path) if path.starts_with(&output)))
                .count(),
            64
        );
    }

    #[test]
    fn composite_decoder_rejects_oversized_annotation_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main.png");
        let oversized = dir.path().join("oversized.png");
        RgbaImage::new(4097, 1).save(&main).unwrap();
        RgbaImage::new(4097, 1).save(&oversized).unwrap();
        assert!(!composite_tile_to_disk(
            &TileSource::from_path(main),
            &[TileSource::from_path(oversized)],
            &dir.path().join("out.png")
        )
        .unwrap());
        assert!(!dir.path().join("out.png").exists());
    }

    fn fixture(
        directory: &Path,
        count: u32,
    ) -> (
        HashMap<(u32, u32), TileSource>,
        Vec<HashMap<(u32, u32), TileSource>>,
    ) {
        fixture_with_size(directory, count, 2)
    }

    fn fixture_with_size(
        directory: &Path,
        count: u32,
        side: u32,
    ) -> (
        HashMap<(u32, u32), TileSource>,
        Vec<HashMap<(u32, u32), TileSource>>,
    ) {
        let main_path = directory.join("main.png");
        RgbaImage::from_pixel(side, side, Rgba([10, 20, 30, 255]))
            .save(&main_path)
            .unwrap();
        let main = TileSource::from_path(main_path);
        let tiles = (0..count).map(|x| ((x, 0), main.clone())).collect();
        let mut layers = Vec::new();
        for (index, color) in [[255, 0, 0, 128], [0, 255, 0, 128], [0, 0, 255, 128]]
            .into_iter()
            .enumerate()
        {
            let path = directory.join(format!("layer-{index}.png"));
            RgbaImage::from_pixel(side, side, Rgba(color))
                .save(&path)
                .unwrap();
            let source = if index == 1 {
                TileSource::from_bytes(std::fs::read(path).unwrap())
            } else {
                TileSource::from_path(path)
            };
            layers.push((0..count).map(|x| ((x, 0), source.clone())).collect());
        }
        (tiles, layers)
    }

    #[tokio::test]
    async fn cancelled_batch_can_restart_from_originals_and_export_raw_tiles() {
        let dir = tempfile::tempdir().unwrap();
        let (originals, layers) = fixture(dir.path(), 150);
        let mut tiles = originals.clone();
        let cancellation = CancellationToken::new();
        let pause = PauseControl::default();
        let output = dir.path().join("__composited");
        let error = composite_tiles_to_disk(
            &mut tiles,
            &layers,
            &output,
            &cancellation,
            &pause,
            |done, _| {
                assert_eq!(done, 64);
                cancellation.cancel();
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("取消"));
        let first_coord = *tiles
            .iter()
            .find(
                |(_, source)| matches!(source, TileSource::Path(path) if path.starts_with(&output)),
            )
            .unwrap()
            .0;
        let before = tiles[&first_coord].bytes().unwrap().into_owned();
        tiles = originals.clone(); // A resumed download reconstructs its sources from originals.
        let mut checkpoints = Vec::new();
        let result = composite_tiles_to_disk(
            &mut tiles,
            &layers,
            &output,
            &CancellationToken::new(),
            &pause,
            |done, total| {
                checkpoints.push((done, total));
            },
        )
        .await
        .unwrap();
        assert_eq!(result, (150, 0));
        assert_eq!(checkpoints, [(64, 150), (128, 150), (150, 150)]);
        assert!(tiles
            .values()
            .all(|source| matches!(source, TileSource::Path(_))));
        assert_eq!(tiles[&first_coord].bytes().unwrap().as_ref(), before);
        let raw = dir.path().join("raw");
        assert!(crate::tile_pack::rename_raw_tiles_in_place(&raw, 15, &tiles, "png").unwrap() > 0);
        for x in 0..150 {
            assert_eq!(
                std::fs::read(raw.join(format!("15/{x}/0.png"))).unwrap(),
                before
            );
        }
        assert!(originals.values().all(|source| source.bytes().is_ok()));
    }

    #[tokio::test]
    async fn paused_composite_can_resume_and_can_be_cancelled_without_notification() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let (mut tiles, layers) = fixture(dir.path(), 1);
        let pause = PauseControl::default();
        pause.flag.store(true, Ordering::Relaxed);
        let resumed = std::sync::Arc::new(AtomicBool::new(false));
        let resume_control = pause.clone();
        let observed = resumed.clone();
        let worker = tokio::spawn(async move {
            tokio::task::yield_now().await;
            observed.store(true, Ordering::Relaxed);
            resume_control.flag.store(false, Ordering::Relaxed);
            resume_control.notify.notify_waiters();
        });
        composite_tiles_to_disk(
            &mut tiles,
            &layers,
            &dir.path().join("out"),
            &CancellationToken::new(),
            &pause,
            |_, _| {
                assert!(resumed.load(Ordering::Relaxed));
            },
        )
        .await
        .unwrap();
        worker.await.unwrap();

        pause.flag.store(true, Ordering::Relaxed);
        let cancellation = CancellationToken::new();
        let token = cancellation.clone();
        let worker = tokio::spawn(async move {
            tokio::task::yield_now().await;
            token.cancel();
        });
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            composite_tiles_to_disk(
                &mut tiles,
                &layers,
                &dir.path().join("cancelled"),
                &cancellation,
                &pause,
                |_, _| panic!("must stay paused"),
            ),
        )
        .await
        .unwrap()
        .unwrap_err();
        worker.await.unwrap();
        assert!(result.contains("取消"));
        assert!(!dir.path().join("cancelled").exists());
    }

    #[test]
    fn three_layers_preserve_order_transparency_and_original_for_resume() {
        let dir = tempfile::tempdir().unwrap();
        let main_path = dir.path().join("main.png");
        RgbaImage::from_pixel(2, 2, Rgba([10, 20, 30, 255]))
            .save(&main_path)
            .unwrap();
        let original = std::fs::read(&main_path).unwrap();
        let mut layers = Vec::new();
        for (index, color) in [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]
            .into_iter()
            .enumerate()
        {
            let mut layer = RgbaImage::new(2, 2);
            layer.put_pixel(0, 0, Rgba(color));
            let path = dir.path().join(format!("layer-{index}.png"));
            layer.save(&path).unwrap();
            layers.push(TileSource::from_path(path));
        }
        let output = dir.path().join("composite/0/0.png");
        for _ in 0..2 {
            assert!(composite_tile_to_disk(
                &TileSource::from_path(main_path.clone()),
                &layers,
                &output
            )
            .unwrap());
            let result = image::open(&output).unwrap().to_rgba8();
            assert_eq!(result.get_pixel(0, 0).0, [0, 0, 255, 255]);
            assert_eq!(result.get_pixel(1, 1).0, [10, 20, 30, 255]);
            assert_eq!(std::fs::read(&main_path).unwrap(), original);
        }
        assert!(!output.with_extension("overlay-part").exists());
    }

    #[test]
    fn missing_or_mismatched_layers_leave_main_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main.png");
        RgbaImage::new(2, 2).save(&main).unwrap();
        let mismatched = dir.path().join("overlay.png");
        RgbaImage::new(3, 3).save(&mismatched).unwrap();
        let output = dir.path().join("output.png");
        assert!(
            !composite_tile_to_disk(&TileSource::from_path(main.clone()), &[], &output).unwrap()
        );
        assert!(!composite_tile_to_disk(
            &TileSource::from_path(main),
            &[TileSource::from_path(mismatched)],
            &output
        )
        .unwrap());
        assert!(!output.exists());
    }

    #[test]
    fn write_failure_is_reported_instead_of_exporting_unannotated_data() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main.png");
        RgbaImage::new(2, 2).save(&main).unwrap();
        let obstruction = dir.path().join("not-a-directory");
        std::fs::write(&obstruction, b"occupied").unwrap();
        let source = TileSource::from_path(main);
        assert!(composite_tile_to_disk(
            &source,
            &[source.clone()],
            &obstruction.join("result.png")
        )
        .unwrap_err()
        .contains("目录失败"));
    }
}
