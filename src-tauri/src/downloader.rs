//! 异步瓦片下载器模块

use crate::config::{self, TileSource, USER_AGENTS};
use crate::tile::TileCoord;
use image::{DynamicImage, RgbImage};
use reqwest::Client;
use std::collections::HashMap;
use std::time::Duration;
use rand::seq::SliceRandom;
use futures::stream::{self, StreamExt};

/// 下载进度
#[derive(Debug, Clone)]
pub struct DownloadProgress {
    pub total: u32,
    pub completed: u32,
    pub failed: u32,
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
            .danger_accept_invalid_certs(true);

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
        } else {
            "https://www.google.com/maps"
        };
        headers.insert(reqwest::header::REFERER, referer.parse().unwrap());

        headers
    }

    /// 批量下载瓦片 - 使用流式并发
    pub async fn download_tiles<F>(
        &self,
        tiles: Vec<TileCoord>,
        concurrency: usize,
        mut progress_callback: F,
    ) -> Result<HashMap<(u32, u32), DynamicImage>, String>
    where
        F: FnMut(DownloadProgress),
    {
        let concurrency = concurrency.clamp(10, 100);
        let total = tiles.len() as u32;
        let mut completed = 0u32;
        let mut failed = 0u32;
        let mut tile_images: HashMap<(u32, u32), DynamicImage> = HashMap::with_capacity(tiles.len());

        // 报告初始进度
        progress_callback(DownloadProgress {
            total,
            completed,
            failed,
            status: "downloading".to_string(),
        });

        // 分批下载，每批 500 个瓦片，避免内存压力过大
        const BATCH_SIZE: usize = 500;
        let tile_batches: Vec<Vec<TileCoord>> = tiles
            .chunks(BATCH_SIZE)
            .map(|chunk| chunk.to_vec())
            .collect();
        
        for batch in tile_batches {
            let batch_futures: Vec<_> = batch.into_iter().map(|tile| {
                let url = self.get_tile_url(&tile);
                let headers = self.get_headers();
                let client = self.client.clone();
                let retry_times = self.retry_times;
                
                async move {
                    let mut last_error = String::new();

                    for attempt in 0..=retry_times {
                        // 每个请求最多 10 秒超时
                        let request_future = async {
                            match client.get(&url).headers(headers.clone()).send().await {
                                Ok(response) => {
                                    if response.status().is_success() {
                                        match response.bytes().await {
                                            Ok(bytes) => match image::load_from_memory(&bytes) {
                                                Ok(img) => return Ok(img),
                                                Err(e) => return Err(format!("解析失败: {}", e)),
                                            },
                                            Err(e) => return Err(format!("读取失败: {}", e)),
                                        }
                                    } else {
                                        return Err(format!("HTTP {}", response.status()));
                                    }
                                }
                                Err(e) => return Err(e.to_string()),
                            }
                        };
                        
                        match tokio::time::timeout(Duration::from_secs(10), request_future).await {
                            Ok(Ok(img)) => return (tile, Ok(img)),
                            Ok(Err(e)) => last_error = e,
                            Err(_) => last_error = "请求超时".to_string(),
                        }

                        // 重试前等待
                        if attempt < retry_times {
                            tokio::time::sleep(Duration::from_millis(200 * (attempt as u64 + 1))).await;
                        }
                    }

                    (tile, Err(last_error))
                }
            }).collect();
            
            // 并发执行这批任务
            let mut batch_stream = stream::iter(batch_futures)
                .buffer_unordered(concurrency);
            
            // 处理这批结果
            while let Some((tile, result)) = batch_stream.next().await {
                match result {
                    Ok(img) => {
                        tile_images.insert((tile.x, tile.y), img);
                        completed += 1;
                    }
                    Err(_) => {
                        failed += 1;
                    }
                }

                // 每 20 个瓦片报告一次进度
                if (completed + failed) % 20 == 0 || (completed + failed) == total {
                    progress_callback(DownloadProgress {
                        total,
                        completed,
                        failed,
                        status: "downloading".to_string(),
                    });
                }
            }
        }

        // 报告完成
        let status = if failed == 0 {
            "completed"
        } else {
            "completed_with_errors"
        };
        progress_callback(DownloadProgress {
            total,
            completed,
            failed,
            status: status.to_string(),
        });

        if tile_images.is_empty() {
            return Err("没有成功下载任何瓦片".to_string());
        }

        Ok(tile_images)
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
