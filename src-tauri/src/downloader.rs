//! 异步瓦片下载器模块

use crate::config::{self, TileSource, USER_AGENTS};
use crate::merger::TileSource as MergerTileSource;
use crate::task::PauseControl;
use crate::tile::TileCoord;
use crate::tile_cache::{
    self as tcache, active_downloads, SourceInfo, SourceKey, StoredTile,
    TileCoord as CacheCoord,
};
use image::RgbImage;
use reqwest::Client;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use rand::seq::SliceRandom;
use futures::stream::{self, StreamExt};
use tokio_util::sync::CancellationToken;

/// 下载进度
#[derive(Debug, Clone)]
pub struct DownloadProgress {
    pub total: u32,
    pub completed: u32,
    pub failed: u32,
    pub no_data: u32,
    pub browse_filled: u32,
    pub status: String,
}

impl DownloadProgress {
    pub fn percent(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            (self.completed as f64 / self.total as f64 * 100.0).round()
        }
    }
}

/// 瓦片下载器
pub struct TileDownloader {
    source: TileSource,
    client: Client,
    retry_times: u32,
}

impl TileDownloader {
    /// 创建新的下载器
    pub fn new(source: TileSource, proxy: Option<&str>) -> Result<Self, String> {
        let mut builder = Client::builder()
            .timeout(Duration::from_secs(config::TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(20)
            .pool_idle_timeout(Duration::from_secs(30))
            .tcp_keepalive(Duration::from_secs(15))
            .danger_accept_invalid_certs(config::allow_invalid_certs());

        // 配置代理
        if let Some(proxy_url) = proxy {
            if !proxy_url.is_empty() && !source.url.contains("tianditu.gov.cn") {
                // 天地图不使用代理
                if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
                    builder = builder.proxy(proxy);
                }
            }
        }

        let client = builder.build().map_err(|e| e.to_string())?;

        Ok(Self {
            source,
            client,
            retry_times: config::RETRY_TIMES,
        })
    }

    /// 生成瓦片 URL
    fn get_tile_url(&self, tile: &TileCoord) -> String {
        let mut url = self.source.url.clone();

        // 替换子域名
        if !self.source.subdomains.is_empty() {
            let subdomain = self
                .source
                .subdomains
                .choose(&mut rand::thread_rng())
                .unwrap();
            url = url.replace("{s}", subdomain);
        }

        // 替换坐标
        url = url.replace("{x}", &tile.x.to_string());
        url = url.replace("{y}", &tile.y.to_string());
        url = url.replace("{z}", &tile.z.to_string());

        url
    }

    /// 生成瓦片 URL（公开接口，供探测等外部调用）
    pub fn get_tile_url_public(&self, tile: &TileCoord) -> String {
        self.get_tile_url(tile)
    }

    /// 获取请求头
    fn get_headers(&self) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();

        // 随机 User-Agent
        let ua = USER_AGENTS.choose(&mut rand::thread_rng()).unwrap();
        headers.insert(
            reqwest::header::USER_AGENT,
            ua.parse().unwrap(),
        );

        headers.insert(
            reqwest::header::ACCEPT,
            "image/webp,image/apng,image/*,*/*;q=0.8".parse().unwrap(),
        );

        // 设置 Referer
        let referer = if self.source.url.contains("tianditu") {
            "https://map.tianditu.gov.cn/"
        } else if self.source.url.contains("arcgis") || self.source.url.contains("maptiles.arcgis.com") {
            "https://livingatlas.arcgis.com/"
        } else {
            "https://www.google.com/maps"
        };
        headers.insert(reqwest::header::REFERER, referer.parse().unwrap());

        headers
    }

    /// 获取请求头（公开接口，供探测等外部调用）
    pub fn get_headers_public(&self) -> reqwest::header::HeaderMap {
        self.get_headers()
    }

    /// 获取 HTTP 客户端引用
    pub fn client(&self) -> &Client {
        &self.client
    }

    /// 推断瓦片格式（从 URL 或字节魔数）
    fn detect_format(bytes: &[u8]) -> &'static str {
        if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
            "jpg"
        } else if bytes.len() >= 4 && bytes[0] == 0x89 && bytes[1] == 0x50 {
            "png"
        } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            "webp"
        } else {
            "png"
        }
    }

    fn format_to_mime(fmt: &str) -> String {
        match fmt {
            "jpg" | "jpeg" => "image/jpeg".to_string(),
            "webp" => "image/webp".to_string(),
            "pbf" => "application/x-protobuf".to_string(),
            _ => "image/png".to_string(),
        }
    }

    /// 构造缓存图源元信息
    fn build_cache_source(&self) -> (SourceKey, SourceInfo) {
        let key = SourceKey::new(&self.source.id);
        let info = SourceInfo {
            display_name: self.source.name.clone(),
            url_template: self.source.url.clone(),
            format: "png".to_string(),
            min_zoom: None,
            max_zoom: Some(self.source.max_zoom),
            bounds: None,
            attribution: Some(self.source.attribution.clone()),
            capture_at: None,
        };
        (key, info)
    }

    /// 下载单个瓦片（带重试）
    async fn download_one_tile(
        client: &Client,
        url: &str,
        headers: &reqwest::header::HeaderMap,
        file_path: &Path,
        retry_times: u32,
        retrying_count: Option<&AtomicU32>,
    ) -> Result<(), String> {
        let mut last_error = String::new();

        for attempt in 0..=retry_times {
            let req_fut = async {
                match client.get(url).headers(headers.clone()).send().await {
                    Ok(resp) => {
                        let status = resp.status();
                        if status.is_success() {
                            match resp.bytes().await {
                                Ok(bytes) => match tokio::fs::write(file_path, &bytes).await {
                                    Ok(_) => Ok(()),
                                    Err(e) => Err((format!("写入失败: {}", e), false)),
                                },
                                Err(e) => Err((format!("读取失败: {}", e), false)),
                            }
                        } else if status.as_u16() == 404 {
                            // 瓦片不存在（该区域/缩放级别无数据），跳过不重试
                            // 清除可能残存的旧文件，避免断点续传误判
                            let _ = tokio::fs::remove_file(file_path).await;
                            Ok(())
                        } else if status.as_u16() == 429 || status.as_u16() == 503 {
                            Err((format!("HTTP {}", status), true))
                        } else {
                            Err((format!("HTTP {}", status), false))
                        }
                    }
                    Err(e) => Err((e.to_string(), false)),
                }
            };

            match tokio::time::timeout(Duration::from_secs(8), req_fut).await {
                Ok(Ok(())) => return Ok(()),
                Ok(Err((e, rate_limited))) => {
                    last_error = e;
                    if attempt < retry_times {
                        if let Some(counter) = retrying_count {
                            counter.fetch_add(1, Ordering::Relaxed);
                        }
                        let delay = if rate_limited { 2000 * (attempt as u64 + 1) } else { 300 * (attempt as u64 + 1) };
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        if let Some(counter) = retrying_count {
                            counter.fetch_sub(1, Ordering::Relaxed);
                        }
                    }
                }
                Err(_) => {
                    last_error = "请求超时".to_string();
                    if attempt < retry_times {
                        if let Some(counter) = retrying_count {
                            counter.fetch_add(1, Ordering::Relaxed);
                        }
                        tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
                        if let Some(counter) = retrying_count {
                            counter.fetch_sub(1, Ordering::Relaxed);
                        }
                    }
                }
            }
        }
        Err(last_error)
    }

    /// 批量下载瓦片到临时目录
    pub async fn download_tiles<F>(
        &self,
        tiles: Vec<TileCoord>,
        concurrency: usize,
        temp_dir: &Path,
        cancel_token: Option<&CancellationToken>,
        pause_control: Option<&PauseControl>,
        mut progress_callback: F,
    ) -> Result<HashMap<(u32, u32), MergerTileSource>, String>
    where
        F: FnMut(DownloadProgress),
    {
        let concurrency = concurrency.clamp(10, 100);
        let total = tiles.len() as u32;
        let mut completed = 0u32;
        let mut failed = 0u32;
        let mut tile_files: HashMap<(u32, u32), MergerTileSource> =
            HashMap::with_capacity(tiles.len());
        let temp_dir = temp_dir.to_path_buf();

        // 打乱瓦片顺序，避免限速时失败集中在同一列
        let mut tiles = tiles;
        tiles.shuffle(&mut rand::thread_rng());

        // 检查已存在的瓦片文件（断点续传）
        let mut need_download: Vec<TileCoord> = Vec::new();
        for tile in &tiles {
            let file_path = temp_dir.join(format!("{}_{}.png", tile.x, tile.y));
            if file_path.exists() && std::fs::metadata(&file_path).map_or(false, |m| m.len() > 0) {
                tile_files.insert((tile.x, tile.y), MergerTileSource::from_path(file_path));
                completed += 1;
            } else {
                need_download.push(tile.clone());
            }
        }
        let skipped = completed;

        // 报告初始进度
        progress_callback(DownloadProgress {
            total, completed, failed, no_data: 0, browse_filled: 0, status: if skipped > 0 {
                format!("已跳过 {} 个已下载瓦片", skipped)
            } else {
                "downloading".to_string()
            },
        });

        // ===== 第一轮：主下载 =====
        let mut failed_tiles: Vec<TileCoord> = Vec::new();
        let retrying_counter = std::sync::Arc::new(AtomicU32::new(0));

        // 缓存元信息（每任务一次构建）
        let (cache_src, cache_info) = self.build_cache_source();
        let cache_src = Arc::new(cache_src);
        let cache_info = Arc::new(cache_info);
        // 确保 metadata 表存在（仅在缓存启用且至少要写时；ensure_source 在禁用时也安全 no-op? 不安全：直接调用会创建文件）
        if tcache::get_config().enabled {
            let _ = tcache::Store::global().ensure_source(&cache_src, (*cache_info).clone());
        }

        // ===== 缓存命中批量预过滤（Issue #25 + #26）=====
        // 在并发循环之前，先用一条 SQL 批量识别已缓存的瓦片，单线程拉 bytes 直接装进
        // `tile_files`（TileSource::Bytes），由 merger 零拷贝读取。
        //
        // - #25 起：用 `contains_batch` 一条 SQL 批量识别，避免每张瓦片占用并发槽位
        //   + 一次 SQL prepare/query。实测：1258 张全命中 SQL 仅 3-5ms。
        // - #26 起：跳过 `temp_dir` 写盘 + merger 再 read 的双重 IO，命中瓦片 bytes
        //   直接装进 `MergerTileSource::Bytes`，由 `Arc<Vec<u8>>` 引用计数共享。
        let mut cache_hit_count = 0u32;
        if tcache::get_config().enabled && !need_download.is_empty() {
            let coords: Vec<CacheCoord> = need_download
                .iter()
                .map(|t| CacheCoord { z: t.z as u8, x: t.x, y: t.y })
                .collect();
            if let Ok(cached_set) = tcache::Store::global().contains_batch(&cache_src, &coords) {
                if !cached_set.is_empty() {
                    let (cached_tiles, real_need): (Vec<_>, Vec<_>) = need_download
                        .into_iter()
                        .partition(|t| {
                            cached_set.contains(&CacheCoord {
                                z: t.z as u8,
                                x: t.x,
                                y: t.y,
                            })
                        });

                    // #26：命中瓦片直接装进 tile_files（内存路径），跳过 temp_dir 写盘 IO
                    for tile in cached_tiles {
                        let coord = CacheCoord { z: tile.z as u8, x: tile.x, y: tile.y };
                        if let Ok(Some(stored)) = tcache::Store::global().get(&cache_src, coord) {
                            if !stored.bytes.is_empty() {
                                tile_files.insert(
                                    (tile.x, tile.y),
                                    MergerTileSource::from_bytes(stored.bytes),
                                );
                                completed += 1;
                                cache_hit_count += 1;
                            }
                        }
                    }
                    need_download = real_need;
                }
            }
        }
        if cache_hit_count > 0 {
            progress_callback(DownloadProgress {
                total,
                completed,
                failed,
                no_data: 0,
                browse_filled: 0,
                status: format!("缓存命中 {} 个瓦片，剩余 {} 个走网络", cache_hit_count, need_download.len()),
            });
        }

        // ===== Issue #28：注册待下载坐标，让浏览写缓存时能通知跳过 =====
        let active_src_key = cache_src.as_str().to_string();
        let active_coords: Vec<CacheCoord> = need_download
            .iter()
            .map(|t| CacheCoord { z: t.z as u8, x: t.x, y: t.y })
            .collect();
        let _download_guard = active_downloads::DownloadGuard::new(&active_src_key, &active_coords);

        let all_futures = need_download.into_iter().map(|tile| {
            let url = self.get_tile_url(&tile);
            let headers = self.get_headers();
            let client = self.client.clone();
            let retry_times = self.retry_times;
            let td = temp_dir.clone();
            let rc = retrying_counter.clone();
            let cs = cache_src.clone();
            let ci = cache_info.clone();
            let ask = active_src_key.clone();

            async move {
                let file_path = td.join(format!("{}_{}.png", tile.x, tile.y));
                let coord = CacheCoord { z: tile.z as u8, x: tile.x, y: tile.y };

                // 1) 检查是否已被浏览补齐（Issue #28）
                if !active_downloads::is_still_pending(&ask, coord) {
                    if let Ok(Some(stored)) = tcache::Store::global().get(&cs, coord) {
                        if !stored.bytes.is_empty() {
                            return (tile, Ok(MergerTileSource::from_bytes(stored.bytes)));
                        }
                    }
                }

                // 2) 优先查缓存（#26：直接返回 Bytes，不写 temp_dir）
                if tcache::get_config().enabled {
                    if let Ok(Some(stored)) = tcache::Store::global().get(&cs, coord) {
                        if !stored.bytes.is_empty() {
                            return (tile, Ok(MergerTileSource::from_bytes(stored.bytes)));
                        }
                    }
                }

                // 3) 网络下载
                let result = Self::download_one_tile(&client, &url, &headers, &file_path, retry_times, Some(&rc)).await;
                let final_result: Result<MergerTileSource, String> = result.and_then(|_| {
                    if file_path.exists() {
                        Ok(MergerTileSource::from_path(file_path.clone()))
                    } else {
                        Err("no_data".to_string())
                    }
                });

                // 4) 写回缓存（仅网络下载成功）
                if final_result.is_ok() && tcache::get_config().enabled {
                    if let Ok(bytes) = tokio::fs::read(&file_path).await {
                        if !bytes.is_empty() && bytes.len() <= 4 * 1024 * 1024 {
                            let fmt = Self::detect_format(&bytes);
                            let stored = StoredTile {
                                bytes,
                                content_type: Self::format_to_mime(fmt),
                            };
                            let _ = tcache::Store::global().put(&cs, coord, stored, Some((*ci).clone()));
                        }
                    }
                }

                (tile, final_result)
            }
        });

        let mut tile_stream = stream::iter(all_futures).buffer_unordered(concurrency);
        let mut stall_timer = tokio::time::interval(Duration::from_secs(3));
        stall_timer.tick().await; // 跳过第一个立即触发的 tick
        let mut no_data_count = 0u32;

        loop {
            // 暂停检查：如果已暂停，等待恢复后再继续拉取新瓦片
            if let Some(pc) = pause_control {
                if pc.is_paused() {
                    progress_callback(DownloadProgress {
                        total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32, status: "paused".to_string(),
                    });
                    pc.wait_if_paused().await;
                    progress_callback(DownloadProgress {
                        total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32, status: "downloading".to_string(),
                    });
                }
            }
            tokio::select! {
                result = tile_stream.next() => {
                    match result {
                        Some((tile, Ok(path))) => {
                            tile_files.insert((tile.x, tile.y), path);
                            completed += 1;
                        }
                        Some((_tile, Err(e))) => {
                            if e == "no_data" {
                                no_data_count += 1;
                                completed += 1;
                            } else {
                                failed_tiles.push(_tile);
                                failed += 1;
                            }
                        }
                        None => break,
                    }
                    if let Some(token) = cancel_token {
                        if token.is_cancelled() { return Err("任务已取消".to_string()); }
                    }
                    if (completed + failed) % 50 == 0 || (completed + failed) == total {
                        let retrying = retrying_counter.load(Ordering::Relaxed);
                        let status = if retrying > 0 {
                            format!("下载中，{} 个瓦片正在重试", retrying)
                        } else {
                            "downloading".to_string()
                        };
                        progress_callback(DownloadProgress {
                            total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32, status,
                        });
                    }
                }
                _ = stall_timer.tick() => {
                    // 定时报告进度，即使没有瓦片完成
                    if let Some(token) = cancel_token {
                        if token.is_cancelled() { return Err("任务已取消".to_string()); }
                    }
                    let retrying = retrying_counter.load(Ordering::Relaxed);
                    if retrying > 0 {
                        progress_callback(DownloadProgress {
                            total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32,
                            status: format!("下载中，{} 个瓦片正在重试", retrying),
                        });
                    }
                }
            }
        }

        // ===== 重试队列：最多 3 轮，每轮降低并发 + 增加间隔 =====
        const MAX_RETRY_ROUNDS: usize = 3;
        let retry_delays_secs: [u64; 3] = [5, 15, 30];
        let retry_concurrencies: [usize; 3] = [
            (concurrency / 2).max(5),
            (concurrency / 4).max(3),
            (concurrency / 6).max(2),
        ];

        for round in 0..MAX_RETRY_ROUNDS {
            if failed_tiles.is_empty() { break; }
            if let Some(token) = cancel_token {
                if token.is_cancelled() { return Err("任务已取消".to_string()); }
            }
            if let Some(pc) = pause_control {
                pc.wait_if_paused().await;
            }

            let retry_count = failed_tiles.len();
            let wait_secs = retry_delays_secs[round];
            progress_callback(DownloadProgress {
                total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32,
                status: format!("重试第{}轮: {} 个失败瓦片，等待 {}s 后重试...", round + 1, retry_count, wait_secs),
            });

            // 等待一段时间再重试，让服务器限速恢复
            tokio::time::sleep(Duration::from_secs(wait_secs)).await;

            progress_callback(DownloadProgress {
                total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32,
                status: format!("重试第{}轮: 开始重试 {} 个瓦片，并发 {}", round + 1, retry_count, retry_concurrencies[round]),
            });

            let mut still_failed: Vec<TileCoord> = Vec::new();
            let rc = retry_concurrencies[round];

            failed_tiles.shuffle(&mut rand::thread_rng());

            let retry_futures = failed_tiles.into_iter().map(|tile| {
                let url = self.get_tile_url(&tile);
                let headers = self.get_headers();
                let client = self.client.clone();
                let td = temp_dir.clone();
                let cs = cache_src.clone();
                let ci = cache_info.clone();

                async move {
                    let file_path = td.join(format!("{}_{}.png", tile.x, tile.y));
                    let coord = CacheCoord { z: tile.z as u8, x: tile.x, y: tile.y };

                    // 缓存命中直接返回 Bytes，跳过 temp_dir IO（#26）
                    if tcache::get_config().enabled {
                        if let Ok(Some(stored)) = tcache::Store::global().get(&cs, coord) {
                            if !stored.bytes.is_empty() {
                                return (tile, Ok(MergerTileSource::from_bytes(stored.bytes)));
                            }
                        }
                    }

                    // 重试轮只给 1 次重试机会
                    let result = Self::download_one_tile(&client, &url, &headers, &file_path, 1, None).await;
                    let final_result: Result<MergerTileSource, String> = result.and_then(|_| {
                        if file_path.exists() {
                            Ok(MergerTileSource::from_path(file_path.clone()))
                        } else {
                            Err("no_data".to_string())
                        }
                    });

                    if final_result.is_ok() && tcache::get_config().enabled {
                        if let Ok(bytes) = tokio::fs::read(&file_path).await {
                            if !bytes.is_empty() && bytes.len() <= 4 * 1024 * 1024 {
                                let fmt = Self::detect_format(&bytes);
                                let stored = StoredTile {
                                    bytes,
                                    content_type: Self::format_to_mime(fmt),
                                };
                                let _ = tcache::Store::global().put(&cs, coord, stored, Some((*ci).clone()));
                            }
                        }
                    }

                    (tile, final_result)
                }
            });

            let mut retry_stream = stream::iter(retry_futures).buffer_unordered(rc);

            while let Some((tile, result)) = retry_stream.next().await {
                if let Some(token) = cancel_token {
                    if token.is_cancelled() { return Err("任务已取消".to_string()); }
                }
                match result {
                    Ok(path) => {
                        tile_files.insert((tile.x, tile.y), path);
                        completed += 1;
                        failed -= 1;
                    }
                    Err(e) => {
                        if e == "no_data" {
                            no_data_count += 1;
                            completed += 1;
                            failed -= 1;
                        } else {
                            still_failed.push(tile);
                        }
                    }
                }
                progress_callback(DownloadProgress {
                    total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32,
                    status: format!("重试第{}轮...", round + 1),
                });
            }

            failed_tiles = still_failed;
        }

        // 报告完成
        let status = if failed == 0 && no_data_count == 0 {
            "completed"
        } else if failed == 0 {
            "completed_with_no_data"
        } else {
            "completed_with_errors"
        };
        progress_callback(DownloadProgress {
            total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32, status: status.to_string(),
        });

        if tile_files.is_empty() {
            if no_data_count > 0 {
                return Err(format!("该区域在此缩放级别无可用数据（全部 {} 张瓦片均返回 404）", no_data_count));
            }
            return Err("没有成功下载任何瓦片".to_string());
        }

        Ok(tile_files)
    }
}

/// 创建空白瓦片 (白色)
pub fn create_blank_tile() -> RgbImage {
    RgbImage::from_pixel(
        config::TILE_SIZE,
        config::TILE_SIZE,
        image::Rgb([255, 255, 255]),
    )
}
