//! 异步瓦片下载器模块

use crate::config::{self, TileSource, USER_AGENTS};
use crate::merger::TileSource as MergerTileSource;
use crate::pause_control::PauseControl;
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
use crate::{tile_payload, tile_policy};
use crate::tianditu_tokens::{self, TiandituTokens};

#[derive(Default)]
struct RateLimitGate(std::sync::Mutex<Option<tokio::time::Instant>>);

impl RateLimitGate {
    async fn wait(&self) {
        loop {
            let until = *self.0.lock().unwrap();
            match until {
                Some(until) if until > tokio::time::Instant::now() => tokio::time::sleep_until(until).await,
                _ => return,
            }
        }
    }

    fn defer(&self, delay: Duration) {
        let until = tokio::time::Instant::now() + delay;
        let mut current = self.0.lock().unwrap();
        *current = Some(current.map_or(until, |value| value.max(until)));
    }
}

pub(crate) fn retry_after(headers: &reqwest::header::HeaderMap, attempt: u32) -> Duration {
    let seconds = headers.get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok().or_else(|| {
            chrono::DateTime::parse_from_rfc2822(v).ok().map(|date| {
                (date.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_seconds().max(0) as u64
            })
        }))
        .unwrap_or(2 * (u64::from(attempt) + 1));
    Duration::from_secs(seconds)
}

/// Bounds compressed raster/vector tile payloads before they can exhaust memory.
/// This also applies to decoded HTTP content (for example a gzip response).
const MAX_TILE_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

async fn bounded_tile_body(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let too_large = || format!("TILE_TOO_LARGE: tile response exceeds {max_bytes} bytes");
    if response.content_length().is_some_and(|length| length > max_bytes as u64) {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取失败: {}", e.without_url()))?
    {
        // Check before extending, including responses with no Content-Length or
        // chunked transfer encoding. Never reserve based on untrusted headers.
        if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

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
    preview_only: bool,
    rate_limit: Arc<RateLimitGate>,
    tianditu_tokens: Option<Arc<TiandituTokens>>,
}

impl TileDownloader {
    fn http_error_message(url: &str, status: reqwest::StatusCode) -> String {
        if url.contains("tianditu.gov.cn") {
            let reason = match status.as_u16() {
                401 => "Token 无效或未通过认证",
                418 => "请求被服务防护拦截或 Token 异常",
                403 => "Token 无权限、来源受限或公开 Key 已失效",
                429 => "Token 请求额度不足或服务正在限流",
                _ => return format!("天地图请求失败：HTTP {}", status.as_u16()),
            };
            let token_kind = if url.contains(config::TIANDITU_DEFAULT_TOKEN) {
                "当前使用 GeoD 内置的公开共享 Key，其额度和可用性不受保证"
            } else {
                "当前使用用户配置的天地图 Token"
            };
            return format!(
                "天地图请求失败：HTTP {}（{}）。{}；请在设置中检查 Token，或前往 https://cloudcenter.tianditu.gov.cn/center/development/myApp 申请自己的 Token",
                status.as_u16(),
                reason,
                token_kind
            );
        }
        format!("HTTP {}", status)
    }

    /// 创建新的下载器
    pub fn new(source: TileSource, proxy: Option<&str>) -> Result<Self, String> {
        tile_policy::ensure_offline_allowed(&source.url)?;
        Self::build(source, proxy, false)
    }

    /// Single-tile interactive probe; never usable for offline task downloads.
    pub fn new_preview(source: TileSource, proxy: Option<&str>) -> Result<Self, String> {
        Self::build(source, proxy, true)
    }

    fn build(source: TileSource, proxy: Option<&str>, preview_only: bool) -> Result<Self, String> {
        let mut builder = Client::builder()
            .timeout(Duration::from_secs(config::TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(20)
            .pool_idle_timeout(Duration::from_secs(30))
            .tcp_keepalive(Duration::from_secs(15))
            .danger_accept_invalid_certs(config::allow_invalid_certs());

        if !preview_only {
            builder = builder.redirect(if std::env::var_os("GEOD_PUBLIC_MCP").is_some() { reqwest::redirect::Policy::none() } else { tile_policy::offline_redirect_policy() });
        }
        if crate::geovis::is_geovis_url(&source.url) {
            builder = builder.redirect(reqwest::redirect::Policy::none());
        }
        if source.url.starts_with("earth-history://") {
            let parsed=reqwest::Url::parse(&source.url).map_err(|_|"EARTH_PLAN: invalid provider context")?;
            let id=parsed.host_str().ok_or("EARTH_PLAN: plan identity missing")?;
            let plan=crate::earth_history::planner::Plan::load(id)?;
            if source.id!=format!("earth_history_{id}")||source.max_zoom!=plan.output_zoom{
                return Err("EARTH_PLAN: source namespace does not match the frozen plan".into());
            }
            builder = builder.redirect(reqwest::redirect::Policy::none()).no_gzip().no_brotli().no_deflate().no_zstd();
        }
        if source.url.starts_with("keyhole-history://") {
            let id=source.url.strip_prefix("keyhole-history://").and_then(|s|s.split('/').next()).ok_or("EARTH_PLAN: Keyhole context")?;
            let context=crate::earth_history::keyhole::Context::load(id)?;
            if context.tiles.is_none() || source.id!=context.source().id || source.max_zoom!=context.source().max_zoom{return Err("EARTH_PLAN: download requires a frozen Keyhole plan".into());}
            builder=builder.redirect(reqwest::redirect::Policy::none()).no_gzip().no_brotli().no_deflate().no_zstd();
        }

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
            preview_only,
            rate_limit: Arc::new(RateLimitGate::default()),
            tianditu_tokens: None,
        })
    }

    pub fn with_tianditu_tokens(mut self, tokens: Arc<TiandituTokens>) -> Self {
        if tianditu_tokens::is_tianditu_url(&self.source.url) {
            self.tianditu_tokens = Some(tokens);
        }
        self
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

        // Replace XYZ, TMS inverted Y and Bing-style QuadKey placeholders.
        let inverted_y = inverted_y(tile.z, tile.y);
        let quadkey = tile_quadkey(tile.x, tile.y, tile.z);
        url = url.replace("{x}", &tile.x.to_string());
        url = url.replace("{y}", &tile.y.to_string());
        url = url.replace("{-y}", &inverted_y.to_string());
        url = url.replace("{z}", &tile.z.to_string());
        url = url.replace("{q}", &quadkey);

        url
    }

    /// 生成瓦片 URL（公开接口，供探测等外部调用）
    pub fn get_tile_url_public(&self, tile: &TileCoord) -> String {
        self.get_tile_url(tile)
    }

    /// 获取请求头
    fn get_headers(&self) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();

        let is_osm_standard = tile_policy::is_osm_standard_url(&self.source.url);
        let is_geovis = crate::geovis::is_geovis_url(&self.source.url);
        let is_nasa_gibs = crate::historical_sources::is_gibs_url(&self.source.url);
        let is_eox = crate::historical_sources::is_eox_url(&self.source.url);
        let is_earth_history = self.source.url.starts_with("earth-history://") || self.source.url.starts_with("keyhole-history://");
        let ua = if is_osm_standard || is_geovis || is_nasa_gibs || is_eox || is_earth_history {
            concat!(
                "GeoD/",
                env!("CARGO_PKG_VERSION"),
                " (+https://geodownloader.pages.dev/; https://github.com/gaopengbin/geo-downloader/issues)"
            )
        } else {
            USER_AGENTS.choose(&mut rand::thread_rng()).unwrap()
        };
        headers.insert(
            reqwest::header::USER_AGENT,
            ua.parse().unwrap(),
        );

        headers.insert(
            reqwest::header::ACCEPT,
            "image/webp,image/apng,image/*,*/*;q=0.8".parse().unwrap(),
        );

        // 设置 Referer
        let referer = if is_osm_standard || is_geovis || is_nasa_gibs || is_eox || is_earth_history {
            None
        } else if self.source.url.contains("tianditu") {
            Some("https://map.tianditu.gov.cn/")
        } else if self.source.url.contains("arcgis") || self.source.url.contains("maptiles.arcgis.com") {
            Some("https://livingatlas.arcgis.com/")
        } else {
            Some("https://www.google.com/maps")
        };
        if let Some(referer) = referer {
            headers.insert(reqwest::header::REFERER, referer.parse().unwrap());
        }

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
        rate_limit: &RateLimitGate,
        tokens: Option<&TiandituTokens>,
    ) -> Result<(), String> {
        tile_policy::ensure_offline_allowed(url)?;
        if url.starts_with("keyhole-history://") {
            let(source,z,x,y)=crate::earth_history::keyhole::parse_url(url)?;
            let bytes=crate::earth_history::keyhole::read_tile(&source,z,x,y,client.clone()).await?;
            tile_payload::validate(&bytes,Some("image/png"))?;
            if let Some(parent)=file_path.parent(){tokio::fs::create_dir_all(parent).await.map_err(|e|e.to_string())?;}
            return tokio::fs::write(file_path,bytes).await.map_err(|e|e.to_string());
        }
        if url.starts_with("earth-history://") {
            return match crate::earth_history::planner::read_tile(url, client.clone()).await {
                Ok(bytes) => {
                    tile_payload::validate(&bytes, Some("image/png"))?;
                    if let Some(parent) = file_path.parent() { tokio::fs::create_dir_all(parent).await.map_err(|e|e.to_string())?; }
                    tokio::fs::write(file_path, bytes).await.map_err(|e|e.to_string())
                }
                Err(error) if error.starts_with("EARTH_NO_DATA:") => { let _=tokio::fs::remove_file(file_path).await; Ok(()) }
                Err(error) => Err(error),
            };
        }
        let tokens = tokens.filter(|_| tianditu_tokens::is_tianditu_url(url));
        let mut last_error: String;
        if let Some(parent) = file_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("创建瓦片目录失败: {}", e))?;
        }

        let mut attempt = 0;
        loop {
            rate_limit.wait().await;
            let selected = tokens.map(TiandituTokens::current).transpose()?;
            let request_url = selected.as_ref().map(|selected| tianditu_tokens::token_url(url, &selected.token));
            let url = request_url.as_deref().unwrap_or(url);
            let req_fut = async {
                if let (Some(pool), Some(used)) = (tokens, selected.as_ref()) { pool.record_request(used); }
                let request = crate::geovis::request(client, url).map_err(|e| (e, false))?;
                match request.headers(headers.clone()).send().await {
                    Ok(resp) => {
                        let status = resp.status();
                        if status.is_success() {
                            let content_type = resp.headers().get(reqwest::header::CONTENT_TYPE)
                                .and_then(|v| v.to_str().ok()).map(str::to_owned);
                            match bounded_tile_body(resp, MAX_TILE_RESPONSE_BYTES).await {
                                Ok(bytes) => {
                                    if crate::geovis::is_geovis_url(url) { crate::geovis::validate_tile(&bytes).map_err(|e|(e,false))?; }
                                    if crate::historical_sources::is_no_data_tile(url,&bytes) {let _=tokio::fs::remove_file(file_path).await;return Ok(());}
                                    tile_payload::validate(&bytes, content_type.as_deref())
                                        .map_err(|e| (e, false))?;
                                    match tokio::fs::write(file_path, &bytes).await {
                                    Ok(_) => {
                                        if let (Some(pool), Some(used)) = (tokens, selected.as_ref()) { pool.record_success(used); }
                                        Ok(())
                                    },
                                    Err(e) => Err((format!("写入失败: {}", e), false)),
                                    }
                                }
                                Err(e) => Err((e, false)),
                            }
                        } else if tokens.is_some() && matches!(status.as_u16(), 401 | 403 | 429) {
                            if status.as_u16() == 429 {
                                let delay = retry_after(resp.headers(), attempt);
                                if delay > Duration::from_secs(60) {
                                    return Err((format!("TILE_RATE_LIMITED: {}；请稍后重试", Self::http_error_message(url, status)), false));
                                }
                                rate_limit.defer(delay);
                            }
                            Err((format!("TIANDITU_TOKEN_REJECTED: HTTP {}", status.as_u16()), false))
                        } else if status.as_u16() == 404 {
                            // 瓦片不存在（该区域/缩放级别无数据），跳过不重试
                            // 清除可能残存的旧文件，避免断点续传误判
                            let _ = tokio::fs::remove_file(file_path).await;
                            Ok(())
                        } else if status.as_u16() == 429 || status.as_u16() == 503 {
                            let delay = retry_after(resp.headers(), attempt);
                            if delay > Duration::from_secs(60) || attempt >= retry_times {
                                return Err((format!("TILE_RATE_LIMITED: {}；请稍后重试", Self::http_error_message(url, status)), false));
                            }
                            rate_limit.defer(delay);
                            Err((Self::http_error_message(url, status), true))
                        } else if status.as_u16() == 401 || status.as_u16() == 403 {
                            Err((format!("TILE_ACCESS_DENIED: {}；任务已停止，请检查权限或切换图源", Self::http_error_message(url, status)), false))
                        } else {
                            Err((Self::http_error_message(url, status), false))
                        }
                    }
                    Err(e) if e.is_redirect() => Err((
                        "TILE_REDIRECT_DENIED: 下载重定向被拒绝（公共 OSM 瓦片或重定向过多），请切换图源".into(), false)),
                    Err(e) => Err((e.without_url().to_string(), false)),
                }
            };

            match tokio::time::timeout(Duration::from_secs(8), req_fut).await {
                Ok(Ok(())) => return Ok(()),
                Ok(Err((e, rate_limited))) => {
                    if let Some(reason) = e.strip_prefix("TIANDITU_TOKEN_REJECTED: ") {
                        tokens.unwrap().reject(selected.as_ref().unwrap(), reason)?;
                        attempt = 0;
                        continue;
                    }
                    if tile_policy::is_terminal_download_error(&e) { return Err(e); }
                    last_error = e;
                    if attempt < retry_times {
                        if let Some(counter) = retrying_count {
                            counter.fetch_add(1, Ordering::Relaxed);
                        }
                        let delay = if rate_limited { 0 } else { 300 * (attempt as u64 + 1) };
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
            if attempt >= retry_times { break; }
            attempt += 1;
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
        tile_policy::ensure_offline_allowed(&self.source.url)?;
        if self.preview_only { return Err("交互预览客户端不能用于离线下载".into()); }
        let cancellation = cancel_token.cloned().unwrap_or_default();
        if cancellation.is_cancelled() { return Err("任务已取消".into()); }
        let concurrency = concurrency.clamp(1, 100);
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
        progress_callback(DownloadProgress {
            total, completed, failed, no_data: 0, browse_filled: 0,
            status: format!("检查已有瓦片：0/{}", total),
        });
        let mut scanned = 0usize;
        let mut scan_report = std::time::Instant::now();
        for tile in &tiles {
            if (self.source.url.starts_with("earth-history://") && tile.z>self.source.max_zoom) || (self.source.url.starts_with("keyhole-history://") && tile.z!=self.source.max_zoom) {return Err("EARTH_PLAN: tile exceeds frozen output detail".into());}
            crate::historical_sources::validate_zoom(&self.source.url,tile.z)?;
        }
        for chunk in tiles.chunks(256) {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err("任务已取消".into()),
                _ = async {
                    if let Some(pc) = pause_control { pc.wait_if_paused().await; }
                } => {},
            }
            let batch = chunk.to_vec();
            let directory = temp_dir.clone();
            let token = cancellation.clone();
            let historical_url=self.source.url.clone();
            let checked = tokio::task::spawn_blocking(move || {
                let mut checked = Vec::with_capacity(batch.len());
                for tile in batch {
                    if token.is_cancelled() { return Err("任务已取消".to_string()); }
                    let sharded = directory.join(tile.x.to_string()).join(format!("{}.png", tile.y));
                    let path = if sharded.exists() { sharded }
                        else { directory.join(format!("{}_{}.png", tile.x, tile.y)) };
                    let existing = (tile_payload::valid_file(&path) && (!crate::historical_sources::is_weld_url(&historical_url) || std::fs::read(&path).is_ok_and(|b|crate::historical_sources::usable_cached_tile(&historical_url,&b)))).then_some(path);
                    checked.push((tile, existing));
                }
                Ok(checked)
            }).await.map_err(|e| format!("检查已有瓦片失败: {e}"))??;
            scanned += checked.len();
            for (tile, existing) in checked {
                if let Some(path) = existing {
                    tile_files.insert((tile.x, tile.y), MergerTileSource::from_path(path));
                    completed += 1;
                } else { need_download.push(tile); }
            }
            if scanned == tiles.len() || scan_report.elapsed().as_secs() >= 1 {
                progress_callback(DownloadProgress {
                    total, completed, failed, no_data: 0, browse_filled: 0,
                    status: format!("检查已有瓦片：{}/{}", scanned, total),
                });
                scan_report = std::time::Instant::now();
            }
        }
        drop(tiles);
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
        let mut first_failure_error: Option<String> = None;
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
        // 批量查询坐标，但命中数据逐张落盘，只保留路径。
        // 大任务不能将全部主瓦片及注记的压缩字节一起留在内存。
        let mut cache_hit_count = 0u32;
        if tcache::get_config().enabled && !need_download.is_empty() {
            let coords: Vec<CacheCoord> = need_download
                .iter()
                .map(|t| CacheCoord { z: t.z as u8, x: t.x, y: t.y })
                .collect();
            let mut cached_set = std::collections::HashSet::new();
            let mut queried = 0usize;
            let mut query_report = std::time::Instant::now();
            progress_callback(DownloadProgress {
                total, completed, failed, no_data: 0, browse_filled: 0,
                status: format!("查询缓存索引：0/{}", coords.len()),
            });
            for chunk in coords.chunks(1024) {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err("任务已取消".into()),
                    _ = async {
                        if let Some(pc) = pause_control { pc.wait_if_paused().await; }
                    } => {},
                }
                let batch = chunk.to_vec();
                let source = cache_src.clone();
                let found = tokio::task::spawn_blocking(move ||
                    tcache::Store::global().contains_batch(&source, &batch))
                    .await.map_err(|e| format!("查询缓存索引失败: {e}"))?;
                if let Ok(found) = found { cached_set.extend(found); }
                queried += chunk.len();
                if queried == coords.len() || query_report.elapsed().as_secs() >= 1 {
                    progress_callback(DownloadProgress {
                        total, completed, failed, no_data: 0, browse_filled: 0,
                        status: format!("查询缓存索引：{}/{}", queried, coords.len()),
                    });
                    query_report = std::time::Instant::now();
                }
            }
            if !cached_set.is_empty() {
                let (cached_tiles, mut real_need): (Vec<_>, Vec<_>) = need_download
                    .into_iter()
                    .partition(|t| {
                        cached_set.contains(&CacheCoord {
                            z: t.z as u8,
                            x: t.x,
                            y: t.y,
                        })
                    });

                for chunk in cached_tiles.chunks(64) {
                    tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => return Err("任务已取消".into()),
                        _ = async {
                            if let Some(pc) = pause_control { pc.wait_if_paused().await; }
                        } => {},
                    }
                    let batch = chunk.to_vec();
                    let source = cache_src.clone();
                    let directory = temp_dir.clone();
                    let token = cancellation.clone();
                    let historical_url=self.source.url.clone();
                    let restored = tokio::task::spawn_blocking(move || {
                        restore_cached_batch(batch, &directory, &token,
                            |coord| tcache::Store::global().get(&source, coord).map(|stored|stored.filter(|s|crate::historical_sources::usable_cached_tile(&historical_url,&s.bytes))))
                    }).await.map_err(|e| format!("读取缓存瓦片失败: {e}"))??;
                    for (tile, path) in restored {
                        if let Some(path) = path {
                            tile_files.insert((tile.x, tile.y), path);
                            completed += 1;
                            cache_hit_count += 1;
                        } else { real_need.push(tile); }
                    }
                    progress_callback(DownloadProgress {
                        total, completed, failed, no_data: 0, browse_filled: 0,
                        status: format!("读取缓存瓦片：{}/{}", completed, total),
                    });
                }
                need_download = real_need;
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

        // 缓存写入失败计数器（put 在 future 闭包内异步调用，主循环通过 Arc 读取）
        let put_fail_count = Arc::new(AtomicU32::new(0));

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
            let pfc = put_fail_count.clone();

            async move {
                let file_path = td
                    .join(tile.x.to_string())
                    .join(format!("{}.png", tile.y));
                let coord = CacheCoord { z: tile.z as u8, x: tile.x, y: tile.y };

                // 1) 检查是否已被浏览补齐（Issue #28）
                if !active_downloads::is_still_pending(&ask, coord) {
                    if let Ok(Some(stored)) = tcache::Store::global().get(&cs, coord) {
                        if crate::historical_sources::usable_cached_tile(&url, &stored.bytes) {
                            return (tile, persist_cached_tile(file_path, stored.bytes).await);
                        }
                    }
                }

                // 2) 优先查缓存，逐张落盘以限制内存占用
                if tcache::get_config().enabled {
                    if let Ok(Some(stored)) = tcache::Store::global().get(&cs, coord) {
                        if crate::historical_sources::usable_cached_tile(&url, &stored.bytes) {
                            return (tile, persist_cached_tile(file_path, stored.bytes).await);
                        }
                    }
                }

                // 3) 网络下载
                let result = Self::download_one_tile(&client, &url, &headers, &file_path, retry_times, Some(&rc), &self.rate_limit, self.tianditu_tokens.as_deref()).await;
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
                            if let Err(e) = tcache::Store::global().put(&cs, coord, stored, Some((*ci).clone())) {
                                pfc.fetch_add(1, Ordering::Relaxed);
                                log::warn!("tile_cache put failed src={} z={} x={} y={}: {}", cs.as_str(), coord.z, coord.x, coord.y, e);
                            }
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
        // 一次性告警：no_data 占比过高时主动提示用户图源可能无覆盖
        let mut high_nodata_warned = false;
        let mut last_progress_report = std::time::Instant::now();
        // 一次性告警：缓存写入失败次数过多
        let mut high_putfail_warned = false;

        loop {
            // 暂停检查：如果已暂停，等待恢复后再继续拉取新瓦片
            if let Some(pc) = pause_control {
                if pc.is_paused() {
                    progress_callback(DownloadProgress {
                        total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32, status: "paused".to_string(),
                    });
                    tokio::select! {
                        _ = cancellation.cancelled() => return Err("任务已取消".into()),
                        _ = pc.wait_if_paused() => {},
                    }
                    progress_callback(DownloadProgress {
                        total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32, status: "downloading".to_string(),
                    });
                }
            }
            tokio::select! {
                _ = cancellation.cancelled() => return Err("任务已取消".into()),
                result = tile_stream.next() => {
                    match result {
                        Some((tile, Ok(path))) => {
                            tile_files.insert((tile.x, tile.y), path);
                            completed += 1;
                        }
                        Some((_tile, Err(e))) => {
                            if tile_policy::is_terminal_download_error(&e) { return Err(e); }
                            if e == "no_data" {
                                no_data_count += 1;
                                completed += 1;
                                // 一次性触发：no_data 占已完成比例 >= 50% 且至少 100 张
                                if !high_nodata_warned
                                    && no_data_count >= 100
                                    && no_data_count.saturating_mul(2) >= completed
                                {
                                    high_nodata_warned = true;
                                    let pct = if completed > 0 {
                                        no_data_count.saturating_mul(100) / completed
                                    } else {
                                        0
                                    };
                                    progress_callback(DownloadProgress {
                                        total,
                                        completed,
                                        failed,
                                        no_data: no_data_count,
                                        browse_filled: active_downloads::browse_filled_count() as u32,
                                        status: format!(
                                            "已有 {} 张瓦片无数据（占已完成 {}%），图源在此区域/级别可能无覆盖，建议切换年份、区域或级别",
                                            no_data_count, pct
                                        ),
                                    });
                                }
                            } else {
                                if first_failure_error.is_none() {
                                    first_failure_error = Some(e);
                                }
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
                        crate::fs_util::ensure_minimum_free_space(&temp_dir)?;
                    }
                    if report_progress_now(total, completed + failed, last_progress_report.elapsed()) {
                        last_progress_report = std::time::Instant::now();
                        let retrying = retrying_counter.load(Ordering::Relaxed);
                        let status = if retrying > 0 {
                            format!("下载中，{} 个瓦片正在重试", retrying)
                        } else {
                            "downloading".to_string()
                        };
                        progress_callback(DownloadProgress {
                            total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32, status,
                        });
                        // 一次性触发：缓存写入失败 >= 50 次时主动告警
                        let pf = put_fail_count.load(Ordering::Relaxed);
                        if !high_putfail_warned && pf >= 50 {
                            high_putfail_warned = true;
                            progress_callback(DownloadProgress {
                                total, completed, failed, no_data: no_data_count,
                                browse_filled: active_downloads::browse_filled_count() as u32,
                                status: format!(
                                    "缓存写入失败累计 {} 次，瓦片可能未存入缓存数据库（详见控制台日志）",
                                    pf
                                ),
                            });
                        }
                    }
                }
                _ = stall_timer.tick() => {
                    // 定时报告进度，即使没有瓦片完成
                    if let Some(token) = cancel_token {
                        if token.is_cancelled() { return Err("任务已取消".to_string()); }
                    }
                    let retrying = retrying_counter.load(Ordering::Relaxed);
                    progress_callback(DownloadProgress {
                        total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32,
                        status: if retrying > 0 { format!("下载中，{} 个瓦片正在重试", retrying) } else { "downloading".into() },
                    });
                }
            }
        }

        // ===== 重试队列：最多 3 轮，每轮降低并发 + 增加间隔 =====
        const MAX_RETRY_ROUNDS: usize = 3;
        let retry_delays_secs: [u64; 3] = [5, 15, 30];
        let retry_concurrencies: [usize; 3] = [
            (concurrency / 2).max(5).min(concurrency),
            (concurrency / 4).max(3).min(concurrency),
            (concurrency / 6).max(2).min(concurrency),
        ];

        for round in 0..MAX_RETRY_ROUNDS {
            if failed_tiles.is_empty() { break; }
            if let Some(token) = cancel_token {
                if token.is_cancelled() { return Err("任务已取消".to_string()); }
            }
            if let Some(pc) = pause_control {
                tokio::select! {
                    _ = cancellation.cancelled() => return Err("任务已取消".into()),
                    _ = pc.wait_if_paused() => {},
                }
            }

            let retry_count = failed_tiles.len();
            let wait_secs = retry_delays_secs[round];
            progress_callback(DownloadProgress {
                total, completed, failed, no_data: no_data_count, browse_filled: active_downloads::browse_filled_count() as u32,
                status: format!("重试第{}轮: {} 个失败瓦片，等待 {}s 后重试...", round + 1, retry_count, wait_secs),
            });

            // 等待一段时间再重试，让服务器限速恢复
            tokio::select! {
                _ = cancellation.cancelled() => return Err("任务已取消".into()),
                _ = tokio::time::sleep(Duration::from_secs(wait_secs)) => {},
            }

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
                let pfc = put_fail_count.clone();

                async move {
                    let file_path = td.join(format!("{}_{}.png", tile.x, tile.y));
                    let coord = CacheCoord { z: tile.z as u8, x: tile.x, y: tile.y };

                    // 重试命中同样落盘，不累计压缩字节
                    if tcache::get_config().enabled {
                        if let Ok(Some(stored)) = tcache::Store::global().get(&cs, coord) {
                            if crate::historical_sources::usable_cached_tile(&url, &stored.bytes) {
                                return (tile, persist_cached_tile(file_path, stored.bytes).await);
                            }
                        }
                    }

                    // 重试轮只给 1 次重试机会
                    let result = Self::download_one_tile(&client, &url, &headers, &file_path, 1, None, &self.rate_limit, self.tianditu_tokens.as_deref()).await;
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
                                if let Err(e) = tcache::Store::global().put(&cs, coord, stored, Some((*ci).clone())) {
                                    pfc.fetch_add(1, Ordering::Relaxed);
                                    log::warn!("tile_cache put failed (retry) src={} z={} x={} y={}: {}", cs.as_str(), coord.z, coord.x, coord.y, e);
                                }
                            }
                        }
                    }

                    (tile, final_result)
                }
            });

            let mut retry_stream = stream::iter(retry_futures).buffer_unordered(rc);

            loop {
                let next = tokio::select! {
                    _ = cancellation.cancelled() => return Err("任务已取消".into()),
                    result = retry_stream.next() => result,
                };
                let Some((tile, result)) = next else { break; };
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
                        if tile_policy::is_terminal_download_error(&e) { return Err(e); }
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

        if tile_files.is_empty() && failed > 0 {
            return Err(first_failure_error.unwrap_or_else(|| {
                format!("全部 {} 张瓦片下载失败，请检查图源配置和网络连接", failed)
            }));
        }

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

fn inverted_y(z: u8, y: u32) -> u32 {
    ((1u64 << z.min(31)) - 1)
        .saturating_sub(y as u64)
        .min(u32::MAX as u64) as u32
}

fn tile_quadkey(x: u32, y: u32, z: u8) -> String {
    let mut key = String::with_capacity(z as usize);
    for level in (1..=z).rev() {
        let mask = 1u32 << (level - 1);
        let mut digit = 0u8;
        if x & mask != 0 {
            digit += 1;
        }
        if y & mask != 0 {
            digit += 2;
        }
        key.push(char::from(b'0' + digit));
    }
    key
}

// Cached payloads must not accumulate in the task's tile map.
async fn persist_cached_tile(
    path: std::path::PathBuf,
    bytes: Vec<u8>,
) -> Result<MergerTileSource, String> {
    tokio::task::spawn_blocking(move || persist_cached_tile_on_disk(path, bytes))
        .await.map_err(|e| format!("TILE_STORAGE_FAILED: 写入缓存瓦片失败: {e}"))?
}

fn persist_cached_tile_on_disk(path: std::path::PathBuf, bytes: Vec<u8>) -> Result<MergerTileSource, String> {
    let partial = path.with_extension("cache-part");
    let result = (|| {
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::write(&partial, bytes)?;
        std::fs::rename(&partial, &path)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("TILE_STORAGE_FAILED: 写入缓存瓦片失败: {error}"));
    }
    Ok(MergerTileSource::from_path(path))
}

fn restore_cached_batch(
    batch: Vec<TileCoord>, directory: &Path, token: &CancellationToken,
    mut read: impl FnMut(CacheCoord) -> Result<Option<StoredTile>, String>,
) -> Result<Vec<(TileCoord, Option<MergerTileSource>)>, String> {
    crate::fs_util::ensure_minimum_free_space(directory)
        .map_err(|e| format!("TILE_STORAGE_FAILED: {e}"))?;
    let mut restored = Vec::with_capacity(batch.len());
    for tile in batch {
        if token.is_cancelled() { return Err("任务已取消".into()); }
        let coord = CacheCoord { z: tile.z as u8, x: tile.x, y: tile.y };
        let stored = read(coord).ok().flatten()
            .filter(|stored| tile_payload::validate(&stored.bytes, None).is_ok());
        let path = match stored {
            Some(stored) => Some(persist_cached_tile_on_disk(
                directory.join(tile.x.to_string()).join(format!("{}.png", tile.y)), stored.bytes)?),
            None => None,
        };
        restored.push((tile, path));
    }
    Ok(restored)
}

fn report_progress_now(total:u32,finished:u32,since_last:Duration)->bool {total<=50 || finished>=total || since_last>=Duration::from_millis(100)}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn small_downloads_report_each_tile_while_large_downloads_are_throttled(){
        assert!(report_progress_now(4,1,Duration::ZERO));
        assert!(!report_progress_now(400,1,Duration::from_millis(10)));
        assert!(report_progress_now(400,8,Duration::from_millis(100)));
        assert!(report_progress_now(400,400,Duration::ZERO));
    }



    #[tokio::test]
    async fn small_network_downloads_expose_every_intermediate_completion() {
        let _cache_test_lock=crate::tile_cache::CACHE_TEST_LOCK.lock().unwrap();
        struct RestoreCache(crate::tile_cache::CacheConfig);
        impl Drop for RestoreCache { fn drop(&mut self){crate::tile_cache::set_config(self.0.clone());} }
        let _restore=RestoreCache(crate::tile_cache::get_config());
        crate::tile_cache::set_enabled(false);
        for total in [4u32,25] {
            let mut png=std::io::Cursor::new(Vec::new());
            image::RgbaImage::from_pixel(256,256,image::Rgba([20,80,120,255])).write_to(&mut png,image::ImageFormat::Png).unwrap();
            let (url,requests,server)=mock_tile_server(wire("200 OK","Content-Type: image/png\r\n",&png.into_inner())).await;
            let mut source=custom_source(&format!("{url}/{{z}}/{{x}}/{{y}}"));source.id=format!("progress_{}",uuid::Uuid::new_v4());
            let downloader=TileDownloader::new(source,None).unwrap();let directory=tempfile::tempdir().unwrap();
            let tiles=(0..total).map(|i|TileCoord{x:i%5,y:i/5,z:5}).collect();
            let mut observed=Vec::new();
            let files=downloader.download_tiles(tiles,2,directory.path(),None,None,|p|observed.push(p.completed)).await.unwrap();server.abort();
            assert_eq!(files.len(),total as usize);assert_eq!(requests.load(Ordering::SeqCst),total);
            for completed in 0..=total{assert!(observed.contains(&completed),"missing {completed}: {observed:?}");}
        }
    }






    #[test]
    fn cache_restore_reads_sqlite_one_tile_at_a_time_and_preserves_retry_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = tcache::store::TileStore::open(&dir.path().join("test.mbtiles"), "test").unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::new(256, 256))
            .write_to(&mut png, image::ImageFormat::Png).unwrap();
        let original = png.into_inner();
        let tiles: Vec<_> = (0..64).map(|x| TileCoord { x, y: 0, z: 15 }).collect();
        for tile in &tiles {
            store.put(CacheCoord { z: 15, x: tile.x, y: 0 }, &StoredTile {
                bytes: if tile.x == 7 { b"bad cache".to_vec() } else { original.clone() },
                content_type: "image/png".into(),
            }).unwrap();
        }
        let out = dir.path().join("restored");
        let paths = restore_cached_batch(tiles.clone(), &out, &CancellationToken::new(),
            |coord| store.get(coord)).unwrap();
        assert_eq!(paths.iter().filter(|(_, path)| path.is_some()).count(), 63);
        for (tile, path) in paths {
            if tile.x == 7 { assert!(path.is_none()); continue; }
            assert!(matches!(path, Some(MergerTileSource::Path(_))));
            assert_eq!(path.unwrap().bytes().unwrap().as_ref(), &original);
            assert!(!out.join(format!("{}/0.cache-part", tile.x)).exists());
        }
        assert!(store.get(CacheCoord { z: 15, x: 7, y: 0 }).unwrap().is_some());
        let cancelled = CancellationToken::new();
        let mut reads = 0;
        let result = restore_cached_batch(tiles.clone(), &dir.path().join("cancelled"), &cancelled,
            |coord| { reads += 1; cancelled.cancel(); store.get(coord) });
        assert!(result.unwrap_err().contains("取消"));
        assert_eq!(reads, 1);
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let error = restore_cached_batch(tiles, &blocked, &CancellationToken::new(),
            |coord| store.get(coord)).unwrap_err();
        assert!(error.starts_with("TILE_STORAGE_FAILED:"));
        assert!(store.get(CacheCoord { z: 15, x: 0, y: 0 }).unwrap().is_some());
    }

    #[tokio::test]
    async fn resumed_layer_reports_existing_scan_and_can_cancel_from_callback() {
        let dir = tempfile::tempdir().unwrap();
        let (url, requests, server) = mock_tile_server(wire("200 OK", "Content-Type: image/png\r\n", b"unused")).await;
        let downloader = TileDownloader::new(custom_source(&url), None).unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::new(2, 2))
            .write_to(&mut png, image::ImageFormat::Png).unwrap();
        let tiles: Vec<_> = (0..600).map(|x| TileCoord { x, y: 0, z: 15 }).collect();
        for tile in &tiles {
            std::fs::write(dir.path().join(format!("{}_0.png", tile.x)), png.get_ref()).unwrap();
        }
        let mut observed = Vec::new();
        let paths = downloader.download_tiles(tiles.clone(), 4, dir.path(), None, None,
            |p| observed.push(p)).await.unwrap();
        assert_eq!(paths.len(), 600);
        assert!(paths.values().all(|path| matches!(path, MergerTileSource::Path(_))));
        assert!(observed.iter().any(|p| p.status == "检查已有瓦片：0/600"));
        assert!(observed.iter().any(|p| p.status == "检查已有瓦片：600/600" && p.completed == 600));
        assert_eq!(observed.last().unwrap().status, "completed");
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        let token = CancellationToken::new();
        let result = downloader.download_tiles(tiles, 4, dir.path(), Some(&token), None,
            |p| { if p.status.starts_with("检查已有瓦片") { token.cancel(); } }).await;
        assert!(result.unwrap_err().contains("取消"));
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[tokio::test]
    async fn cached_payload_is_persisted_and_only_a_path_is_retained() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("12/34.png");
        for bytes in [vec![1; 4096], vec![2; 8192]] {
            let source = persist_cached_tile(path.clone(), bytes.clone()).await.unwrap();
            assert!(matches!(source, MergerTileSource::Path(_)));
            assert_eq!(source.bytes().unwrap().as_ref(), bytes);
            assert!(!path.with_extension("cache-part").exists());
        }
        let blocked = dir.path().join("file");
        std::fs::write(&blocked, b"occupied").unwrap();
        let error = persist_cached_tile(blocked.join("tile.png"), vec![1]).await.unwrap_err();
        assert!(tile_policy::is_terminal_download_error(&error));
    }

    async fn mock_tile_server(response: Vec<u8>) -> (String, Arc<AtomicU32>, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let count = Arc::new(AtomicU32::new(0));
        let observed = count.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0; 4096];
                if socket.read(&mut request).await.is_err() { continue; }
                observed.fetch_add(1, Ordering::SeqCst);
                let _ = socket.write_all(&response).await;
                let _ = socket.shutdown().await;
            }
        });
        (format!("http://{address}/tile"), count, server)
    }

    fn wire(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        response.extend_from_slice(body);
        response
    }

    #[tokio::test]
    async fn refuses_forbidden_sources_even_when_a_resumed_tile_exists() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("0_0.png"), b"old blocked tile").unwrap();
        let source = custom_source("https://a.tile.openstreetmap.org/{z}/{x}/{y}.png");
        assert!(TileDownloader::new(source.clone(), None).is_err());
        let preview = TileDownloader::new_preview(source, None).unwrap();
        let result = preview.download_tiles(vec![TileCoord { x: 0, y: 0, z: 0 }], 1, dir.path(), None, None, |_| {}).await;
        assert!(result.unwrap_err().starts_with("OSM_OFFLINE_FORBIDDEN:"));
        assert!(dir.path().join("0_0.png").exists());
    }

    #[tokio::test]
    async fn denied_or_invalid_http_responses_are_not_retried_or_saved() {
        for (status, mime, body, expected) in [
            ("403 Forbidden", "image/png", b"blocked".as_slice(), "TILE_ACCESS_DENIED:"),
            ("401 Unauthorized", "text/html", b"login".as_slice(), "TILE_ACCESS_DENIED:"),
            ("200 OK", "text/html", b"<html>Access blocked</html>".as_slice(), "INVALID_TILE:"),
            ("200 OK", "image/png", b"\x89PNG\r\n\x1a\n".as_slice(), "INVALID_TILE:"),
        ] {
            let (url, count, server) = mock_tile_server(wire(status, &format!("Content-Type: {mime}\r\n"), body)).await;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("tile.png");
            let client = Client::builder().no_proxy().build().unwrap();
            let error = TileDownloader::download_one_tile(&client, &url, &Default::default(), &path, 3, None, &RateLimitGate::default(), None).await.unwrap_err();
            server.abort();
            assert!(error.starts_with(expected), "{error}");
            assert_eq!(count.load(Ordering::SeqCst), 1);
            assert!(!path.exists());
        }
    }

    #[tokio::test]
    async fn rate_limits_have_bounded_retries_and_honor_long_retry_after() {
        for (retry_after, expected_requests) in [("0", 2), ("120", 1)] {
            let (url, count, server) = mock_tile_server(wire("429 Too Many Requests", &format!("Retry-After: {retry_after}\r\n"), b"limited")).await;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("tile.png");
            let client = Client::builder().no_proxy().build().unwrap();
            let error = TileDownloader::download_one_tile(&client, &url, &Default::default(), &path, 1, None, &RateLimitGate::default(), None).await.unwrap_err();
            server.abort();
            assert!(error.starts_with("TILE_RATE_LIMITED:"), "{error}");
            assert_eq!(count.load(Ordering::SeqCst), expected_requests);
            assert!(!path.exists());
        }
    }

    #[tokio::test]
    async fn tianditu_failover_retries_the_same_tile_and_shares_active_token_across_layers() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let bytes = png.into_inner();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = requests.clone();
        let body = bytes.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0; 4096];
                let count = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                let path = request.split_whitespace().nth(1).unwrap();
                observed.lock().unwrap().push(path.to_owned());
                let status = if path.contains("tk=quota") { "429 Too Many Requests" }
                    else if path.contains("tk=invalid") { "401 Unauthorized" }
                    else if path.contains("tk=denied") { "403 Forbidden" }
                    else { "200 OK" };
                socket.write_all(&wire(status, "Retry-After: 0\r\nContent-Type: image/png\r\n", &body)).await.unwrap();
                socket.shutdown().await.unwrap();
            }
        });
        let url = format!("http://t0.tianditu.gov.cn:{}/tile?x=2&y=3&z=4&tk=stale&hl=en", address.port());
        let client = Client::builder().no_proxy().resolve("t0.tianditu.gov.cn", address).build().unwrap();
        let pool = TiandituTokens::new(vec!["quota".into(), "invalid".into(), "denied".into(), "valid".into()], Arc::new(|_| {}));
        let gate = RateLimitGate::default();
        let dir = tempfile::tempdir().unwrap();
        for layer in ["main", "annotation"] {
            pool.set_stage(if layer == "main" { "base_download" } else { "overlay_download" }, true);
            let path = dir.path().join(format!("{layer}.png"));
            TileDownloader::download_one_tile(&client, &url, &Default::default(), &path, 0, None, &gate, Some(&pool)).await.unwrap();
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        let diagnostics = pool.diagnostics();
        assert_eq!((diagnostics.configured_tokens, diagnostics.used_tokens, diagnostics.token_switches, diagnostics.recovered_switches), (4, 4, 3, 1));
        assert_eq!(diagnostics.last_rejection_status, 403);
        assert!(!diagnostics.tokens_exhausted);
        let json = serde_json::to_string(&diagnostics).unwrap();
        assert!(!json.contains("quota") && !json.contains("invalid") && !json.contains("denied") && !json.contains("valid"));
        if let Ok(directory) = std::env::var("GEOD_TOKEN_DIAGNOSTIC_FIXTURES") {
            std::fs::write(std::path::Path::new(&directory).join("recovered.json"), json).unwrap();
        }
        server.abort();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 5);
        for (request, token) in requests.iter().zip(["quota", "invalid", "denied", "valid", "valid"]) {
            assert!(request.contains(&format!("tk={token}")), "{request}");
            assert!(request.contains("x=2") && request.contains("y=3") && request.contains("z=4") && request.contains("hl=en"));
            assert!(!request.contains("stale"));
        }
    }

    #[tokio::test]
    async fn all_tokens_exhausted_stop_without_bad_files_and_other_hosts_never_receive_tokens() {
        for tianditu in [true, false] {
            let (url, count, server) = mock_tile_server(wire("429 Too Many Requests", "Retry-After: 0\r\n", b"quota exhausted")).await;
            let address = reqwest::Url::parse(&url).unwrap().socket_addrs(|| None).unwrap()[0];
            let url = if tianditu { url.replace("127.0.0.1", "t0.tianditu.gov.cn") } else { url };
            let client = Client::builder().no_proxy().resolve("t0.tianditu.gov.cn", address).build().unwrap();
            let pool = TiandituTokens::new(vec!["private-a".into(), "private-b".into()], Arc::new(|_| {}));
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("tile.png");
            let error = TileDownloader::download_one_tile(&client, &url, &Default::default(), &path, 0, None, &RateLimitGate::default(), Some(&pool)).await.unwrap_err();
            server.abort();
            assert!(error.starts_with(if tianditu { "TILE_TOKENS_EXHAUSTED:" } else { "TILE_RATE_LIMITED:" }), "{error}");
            assert!(tile_policy::is_terminal_download_error(&error));
            assert!(!error.contains("private-"));
            if tianditu {
                let diagnostics = pool.diagnostics();
                assert_eq!((diagnostics.used_tokens, diagnostics.token_switches, diagnostics.recovered_switches), (2, 1, 0));
                assert_eq!(diagnostics.last_rejection_status, 429);
                assert!(diagnostics.tokens_exhausted);
                if let Ok(directory) = std::env::var("GEOD_TOKEN_DIAGNOSTIC_FIXTURES") {
                    std::fs::write(std::path::Path::new(&directory).join("exhausted.json"), serde_json::to_string(&diagnostics).unwrap()).unwrap();
                }
            }
            assert_eq!(count.load(Ordering::SeqCst), if tianditu { 2 } else { 1 });
            assert!(!path.exists());
        }
    }

    #[tokio::test]
    async fn provider_waf_and_long_retry_after_do_not_rotate_tokens() {
        for (status, headers, prefix) in [
            ("418 I'm a teapot", "", "天地图"),
            ("429 Too Many Requests", "Retry-After: 120\r\n", "TILE_RATE_LIMITED:"),
        ] {
            let (url, count, server) = mock_tile_server(wire(status, headers, b"CloudWAF")).await;
            let address = reqwest::Url::parse(&url).unwrap().socket_addrs(|| None).unwrap()[0];
            let url = url.replace("127.0.0.1", "t0.tianditu.gov.cn");
            let client = Client::builder().no_proxy().resolve("t0.tianditu.gov.cn", address).build().unwrap();
            let pool = TiandituTokens::new(vec!["a".into(), "b".into()], Arc::new(|_| {}));
            let dir = tempfile::tempdir().unwrap();
            let error = TileDownloader::download_one_tile(&client, &url, &Default::default(), &dir.path().join("tile.png"), 0, None, &RateLimitGate::default(), Some(&pool)).await.unwrap_err();
            server.abort();
            assert!(error.starts_with(prefix), "{error}");
            assert_eq!(count.load(Ordering::SeqCst), 1);
            assert_eq!(pool.current().unwrap().token, "a");
        }
    }

    #[tokio::test]
    async fn blocks_redirect_before_sending_any_request_to_osm() {
        // Even a regression must only contact loopback, never the real OSM service.
        let (target_url, target_count, target_server) = mock_tile_server(wire("200 OK", "", b"blocked")).await;
        let target_url = reqwest::Url::parse(&target_url).unwrap();
        let port = target_url.port().unwrap();
        let location = format!("Location: http://TILE.OPENSTREETMAP.ORG.:{port}/1/0/0.png\r\n");
        let (url, count, server) = mock_tile_server(wire("302 Found", &location, b"")).await;
        let client = Client::builder().no_proxy()
            .resolve("tile.openstreetmap.org.", ([127, 0, 0, 1], port).into())
            .redirect(tile_policy::offline_redirect_policy()).build().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tile.png");
        let error = TileDownloader::download_one_tile(&client, &url, &Default::default(), &path, 3, None, &RateLimitGate::default(), None).await.unwrap_err();
        server.abort();
        target_server.abort();
        assert!(error.starts_with("TILE_REDIRECT_DENIED:"), "{error}");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(target_count.load(Ordering::SeqCst), 0);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn valid_png_and_vector_tiles_still_download() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2).write_to(&mut png, image::ImageFormat::Png).unwrap();
        for (mime, bytes) in [("image/png", png.into_inner()), ("application/x-protobuf", b"\x1a\x07\x0a\x03osm\x78\x02".to_vec())] {
            let (url, count, server) = mock_tile_server(wire("200 OK", &format!("Content-Type: {mime}\r\n"), &bytes)).await;
            let client = Client::builder().no_proxy().build().unwrap();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("tile.png");
            TileDownloader::download_one_tile(&client, &url, &Default::default(), &path, 0, None, &RateLimitGate::default(), None).await.unwrap();
            server.abort();
            assert_eq!(std::fs::read(path).unwrap(), bytes);
            assert_eq!(count.load(Ordering::SeqCst), 1);
        }
    }

    async fn tile_response(wire_response: Vec<u8>) -> reqwest::Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            socket.write_all(&wire_response).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            client.get(format!("http://{address}/tile")).send(),
        ).await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(2), server).await.unwrap().unwrap();
        response
    }

    #[tokio::test]
    async fn rejects_large_declared_body_without_waiting_for_or_allocating_it() {
        // The fixture sends headers only. A read-before-length-check would fail
        // with a truncated HTTP body, rather than the intended resource error.
        let response = tile_response(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_TILE_RESPONSE_BYTES + 1,
        ).into_bytes()).await;
        let error = bounded_tile_body(response, MAX_TILE_RESPONSE_BYTES).await.unwrap_err();
        assert!(error.starts_with("TILE_TOO_LARGE:"), "{error}");
    }

    #[tokio::test]
    async fn rejects_chunked_body_that_exceeds_limit_without_content_length() {
        let response = tile_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nabcd\r\n4\r\nefgh\r\n0\r\n\r\n".to_vec(),
        ).await;
        assert_eq!(response.content_length(), None);
        let error = bounded_tile_body(response, 6).await.unwrap_err();
        assert!(error.starts_with("TILE_TOO_LARGE:"), "{error}");
    }

    #[tokio::test]
    async fn accepts_exact_limit_and_rejects_oversized_connection_delimited_body() {
        let response = tile_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd".to_vec(),
        ).await;
        assert_eq!(bounded_tile_body(response, 4).await.unwrap(), b"abcd");
        let response = tile_response(
            b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nabcdefgh".to_vec(),
        ).await;
        assert_eq!(response.content_length(), None);
        let error = bounded_tile_body(response, 6).await.unwrap_err();
        assert!(error.starts_with("TILE_TOO_LARGE:"), "{error}");
    }

    #[test]
    fn osm_standard_requests_identify_geod_without_fake_referer() {
        let source = config::get_tile_sources(None)
            .remove("osm")
            .expect("built-in OSM source");
        assert_eq!(
            source.url,
            "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        );
        assert!(source.subdomains.is_empty());
        let downloader = TileDownloader::new_preview(source, None).expect("downloader");
        let headers = downloader.get_headers();

        let user_agent = headers
            .get(reqwest::header::USER_AGENT)
            .expect("user-agent")
            .to_str()
            .expect("valid user-agent");
        assert!(user_agent.starts_with("GeoD/"));
        assert!(user_agent.contains("geodownloader.pages.dev"));
        assert!(!headers.contains_key(reqwest::header::REFERER));
    }

    fn custom_source(url: &str) -> TileSource {
        TileSource {
            id: "custom_test".to_string(),
            name: "Test".to_string(),
            url: url.to_string(),
            subdomains: vec![],
            max_zoom: 22,
            attribution: String::new(),
        }
    }

    #[test]
    fn builds_tms_tile_urls_from_inverted_y_placeholder() {
        let downloader = TileDownloader::new(
            custom_source("https://example.test/{z}/{x}/{-y}.png"),
            None,
        )
        .unwrap();
        let url = downloader.get_tile_url(&TileCoord { z: 3, x: 2, y: 1 });
        assert_eq!(url, "https://example.test/3/2/6.png");
    }

    #[test]
    fn builds_bing_quadkey_tile_urls() {
        let downloader = TileDownloader::new(
            custom_source("https://example.test/tiles/{q}.jpeg?z={z}"),
            None,
        )
        .unwrap();
        let url = downloader.get_tile_url(&TileCoord { z: 3, x: 3, y: 5 });
        assert_eq!(url, "https://example.test/tiles/213.jpeg?z=3");
    }

    #[test]
    fn explains_tianditu_auth_and_quota_errors() {
        let url = format!(
            "https://t0.tianditu.gov.cn/img_w/wmts?tk={}",
            config::TIANDITU_DEFAULT_TOKEN
        );
        let unauthorized = TileDownloader::http_error_message(
            &url,
            reqwest::StatusCode::UNAUTHORIZED,
        );
        assert!(unauthorized.contains("Token 无效"));
        assert!(unauthorized.contains("公开共享 Key"));

        let limited = TileDownloader::http_error_message(
            &url,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
        );
        assert!(limited.contains("额度不足"));
        assert!(limited.contains("cloudcenter.tianditu.gov.cn"));

        let blocked = TileDownloader::http_error_message(
            &url,
            reqwest::StatusCode::IM_A_TEAPOT,
        );
        assert!(blocked.contains("服务防护"));
    }
}
