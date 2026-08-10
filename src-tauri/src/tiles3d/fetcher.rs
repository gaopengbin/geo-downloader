use crate::task::PauseControl;
use crate::tiles3d::filter::{
    filter_tileset, filter_tileset_all, filter_tileset_with_parent_transform, SelectionRegion,
    TileTransform, IDENTITY_TRANSFORM,
};
use crate::tiles3d::tileset::{
    IonEndpointResponse, ResolvedEndpoint, Tiles3dSource, Tileset, TilesetSummary,
};
use futures::stream::StreamExt;
use reqwest::Client;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;

// ============================================================
// 3D Tiles 下载器
// ============================================================

pub struct Tiles3dFetcher {
    client: Client,
    auth_headers: HashMap<String, String>,
}

/// 下载进度回调
pub struct FetchProgress {
    pub total: u32,
    pub completed: u32,
    pub failed: u32,
    pub status: String,
}

impl Tiles3dFetcher {
    pub fn new(proxy: Option<&str>) -> Result<Self, String> {
        let mut builder = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(60))
            .pool_max_idle_per_host(50)
            .tcp_keepalive(std::time::Duration::from_secs(15))
            .http2_adaptive_window(true)
            .danger_accept_invalid_certs(crate::config::allow_invalid_certs());

        if let Some(proxy_url) = proxy {
            if !proxy_url.is_empty() {
                builder = builder.proxy(
                    reqwest::Proxy::all(proxy_url)
                        .map_err(|e| format!("代理设置错误: {}", e))?,
                );
            }
        }

        let client = builder.build().map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

        Ok(Self {
            client,
            auth_headers: HashMap::new(),
        })
    }

    /// 解析数据源，获取 tileset.json URL 和认证信息
    pub async fn resolve_source(&mut self, source: &Tiles3dSource) -> Result<ResolvedEndpoint, String> {
        match source {
            Tiles3dSource::CesiumIon {
                asset_id,
                access_token,
            } => {
                let url = format!(
                    "https://api.cesium.com/v1/assets/{}/endpoint",
                    asset_id
                );
                let resp = self
                    .client
                    .get(&url)
                    .header("Authorization", format!("Bearer {}", access_token))
                    .send()
                    .await
                    .map_err(|e| format!("Cesium Ion API 请求失败: {}", e))?;

                if !resp.status().is_success() {
                    return Err(format!(
                        "Cesium Ion API 返回错误 {}: {}",
                        resp.status(),
                        resp.text().await.unwrap_or_default()
                    ));
                }

                let resp_text = resp
                    .text()
                    .await
                    .map_err(|e| format!("读取 Ion 响应失败: {}", e))?;

                log::info!("Ion endpoint raw: {}", resp_text.chars().take(2000).collect::<String>());

                let endpoint: IonEndpointResponse = serde_json::from_str(&resp_text)
                    .map_err(|e| format!("解析 Ion 响应失败: {}", e))?;

                // 获取 tileset URL：优先顶层 url，其次 options.url
                let raw_url = endpoint
                    .url
                    .or_else(|| endpoint.options.and_then(|o| o.url))
                    .ok_or("Ion endpoint 响应中缺少 URL")?;

                log::info!("Ion endpoint: type={}, url={}", endpoint.r#type, &raw_url);

                // 认证头：标准 Ion 用 Bearer token，外部类型（如 Google）不需要
                let mut headers = HashMap::new();
                if let Some(token) = &endpoint.access_token {
                    headers.insert(
                        "Authorization".to_string(),
                        format!("Bearer {}", token),
                    );
                }

                self.auth_headers = headers.clone();

                // Ion 返回的 URL 可能不以 tileset.json 结尾，需要补全
                // 注意：URL 可能带查询参数如 ?v=2，需要先去掉再判断
                let url_path = raw_url.split('?').next().unwrap_or(&raw_url);
                let tileset_url = if url_path.to_lowercase().ends_with(".json") {
                    raw_url
                } else {
                    let base = raw_url.trim_end_matches('/');
                    format!("{}/tileset.json", base)
                };

                Ok(ResolvedEndpoint {
                    tileset_url,
                    auth_headers: headers,
                })
            }
            Tiles3dSource::DirectUrl {
                tileset_url,
                headers,
            } => {
                self.auth_headers = headers.clone();
                Ok(ResolvedEndpoint {
                    tileset_url: tileset_url.clone(),
                    auth_headers: headers.clone(),
                })
            }
        }
    }

    /// 获取并解析 tileset.json
    pub async fn fetch_tileset(&self, tileset_url: &str) -> Result<Tileset, String> {
        let mut req = self.client.get(tileset_url);
        for (k, v) in &self.auth_headers {
            req = req.header(k, v);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("获取 tileset.json 失败: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!(
                "tileset.json 请求返回 {}: {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            ));
        }

        let status = resp.status();
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown")
            .to_string();

        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应体失败: {}", e))?;

        log::info!(
            "tileset response: status={}, content-type={}, body_len={}, preview={}",
            status,
            content_type,
            text.len(),
            text.chars().take(300).collect::<String>()
        );

        serde_json::from_str::<Tileset>(&text)
            .map_err(|e| format!("解析 tileset.json 失败: {}", e))
    }

    /// 获取 tileset.json 原始字节 + 解析后的结构体（用于解析阶段同时写盘）
    async fn fetch_raw_tileset(&self, tileset_url: &str) -> Result<(Tileset, Vec<u8>), String> {
        let mut req = self.client.get(tileset_url);
        for (k, v) in &self.auth_headers {
            req = req.header(k, v);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("获取 tileset 失败: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("tileset 请求返回 {}", resp.status()));
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取响应体失败: {}", e))?;

        let tileset = serde_json::from_slice::<Tileset>(&bytes)
            .map_err(|e| format!("解析 tileset 失败: {}", e))?;

        Ok((tileset, bytes.to_vec()))
    }

    /// 解析 tileset 并返回摘要信息（不下载内容）
    pub async fn analyze(
        &mut self,
        source: &Tiles3dSource,
    ) -> Result<(ResolvedEndpoint, TilesetSummary), String> {
        let endpoint = self.resolve_source(source).await?;
        let tileset = self.fetch_tileset(&endpoint.tileset_url).await?;
        let summary = tileset.summary();
        Ok((endpoint, summary))
    }

    /// 执行空间过滤后的下载
    pub async fn download<F>(
        &mut self,
        tileset_url: &str,
        polygon: Option<&[Vec<f64>]>,
        output_dir: &Path,
        concurrency: usize,
        cancel_token: CancellationToken,
        pause_control: PauseControl,
        progress_callback: F,
    ) -> Result<PathBuf, String>
    where
        F: Fn(FetchProgress) + Send + Sync + 'static,
    {
        // 0. 自动设置 Referer（OSS/CDN 的 bucket referer 策略需要）
        if !self.auth_headers.contains_key("Referer") && !self.auth_headers.contains_key("referer") {
            if let Ok(url) = reqwest::Url::parse(tileset_url) {
                let origin = format!("{}://{}/", url.scheme(), url.host_str().unwrap_or(""));
                self.auth_headers.insert("Referer".to_string(), origin);
            }
        }

        // 1. 获取 tileset
        let tileset = self.fetch_tileset(tileset_url).await?;

        // 2. 空间过滤
        let filter_result = if let Some(poly) = polygon {
            let region = SelectionRegion::new(poly);
            let result = filter_tileset(&tileset, &region);
            if result.download_uris.is_empty() {
                return Err("选区内无可下载的瓦片".to_string());
            }
            result
        } else {
            // 无选区：下载全部
            filter_tileset_all(&tileset)
        };

        // 3. 创建输出目录
        tokio::fs::create_dir_all(output_dir)
            .await
            .map_err(|e| format!("创建输出目录失败: {}", e))?;

        // 4. 解析 base URL（用于解析相对路径）及 query 参数（如 ?token=xxx）
        let (clean_tileset_url, query_params) = if let Some((path, query)) = tileset_url.split_once('?') {
            (path.to_string(), query.to_string())
        } else {
            (tileset_url.to_string(), String::new())
        };
        let base_url = clean_tileset_url
            .rsplit_once('/')
            .map(|(base, _)| format!("{}/", base))
            .unwrap_or_default();

        progress_callback(FetchProgress {
            total: 0,
            completed: 0,
            failed: 0,
            status: format!(
                "过滤完成: {}/{} 节点保留, 开始解析+下载...",
                filter_result.filtered_count,
                filter_result.original_count,
            ),
        });

        // 5. 预计算 URI 映射（用于重写 root tileset.json）
        let mut uri_to_local: HashMap<String, String> = HashMap::new();
        for uri in &filter_result.download_uris {
            let absolute_url = resolve_url(&base_url, uri);
            let local = absolute_to_local(&absolute_url, &base_url);
            uri_to_local.insert(uri.clone(), local);
        }

        // 6. 管线化：解析和下载并行
        //    - 解析任务发现 b3dm/glb → 立即推入下载通道
        //    - 解析任务发现 JSON → 获取、解析、写盘，继续递归
        //    - 下载消费者从通道取出 URL 并发下载
        let total_discovered = Arc::new(AtomicU32::new(0));
        let completed = Arc::new(AtomicU32::new(0));
        let failed = Arc::new(AtomicU32::new(0));
        let resolution_done = Arc::new(AtomicBool::new(false));

        let callback = Arc::new(progress_callback);

        // 6a. 进度上报（每 500ms）
        let progress_handle = {
            let td = total_discovered.clone();
            let c = completed.clone();
            let f = failed.clone();
            let rd = resolution_done.clone();
            let cancel = cancel_token.clone();
            let cb = callback.clone();
            tokio::spawn(async move {
                loop {
                    if cancel.is_cancelled() {
                        break;
                    }
                    let total = td.load(Ordering::Relaxed);
                    let comp = c.load(Ordering::Relaxed);
                    let fail = f.load(Ordering::Relaxed);
                    let done = rd.load(Ordering::Relaxed);
                    let status = if !done {
                        format!(
                            "解析+下载中... 已发现 {} 个文件, 已完成 {}",
                            total, comp
                        )
                    } else {
                        "下载中".to_string()
                    };
                    cb(FetchProgress {
                        total,
                        completed: comp,
                        failed: fail,
                        status,
                    });
                    if done && total > 0 && comp + fail >= total {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            })
        };

        // 6b. 下载通道（producer: 解析任务, consumer: 下载工作者）
        let (tx, rx) = mpsc::channel::<(String, String)>(500);

        // 6c. 下载消费者
        let download_handle = {
            let client = self.client.clone();
            let auth = self.auth_headers.clone();
            let cancel = cancel_token.clone();
            let pause = pause_control.clone();
            let completed = completed.clone();
            let failed = failed.clone();
            let out_dir = output_dir.to_path_buf();
            let sem_size = concurrency;

            tokio::spawn(async move {
                let sem = Arc::new(Semaphore::new(sem_size));
                let mut handles = Vec::new();
                let mut rx = rx;

                while let Some((url, local_rel)) = rx.recv().await {
                    if cancel.is_cancelled() {
                        break;
                    }
                    pause.wait_if_paused().await;

                    let local_path = out_dir.join(&local_rel);
                    let client = client.clone();
                    let auth = auth.clone();
                    let cancel = cancel.clone();
                    let completed = completed.clone();
                    let failed = failed.clone();
                    let permit = match sem.clone().acquire_owned().await {
                        Ok(p) => p,
                        Err(_) => break,
                    };

                    handles.push(tokio::spawn(async move {
                        let _permit = permit;
                        if cancel.is_cancelled() {
                            return;
                        }
                        // 断点续传：跳过已存在文件
                        if local_path.exists() {
                            completed.fetch_add(1, Ordering::Relaxed);
                            return;
                        }
                        match download_file(&client, &url, &auth, &local_path, &cancel).await {
                            Ok(_) => {
                                completed.fetch_add(1, Ordering::Relaxed);
                            }
                            Err(e) => {
                                failed.fetch_add(1, Ordering::Relaxed);
                                let url_tail: String = url.chars().rev().take(60).collect::<Vec<_>>().into_iter().rev().collect();
                                log::warn!("下载失败: …{} — {}", url_tail, e);
                            }
                        }
                    }));
                }

                // 等待全部下载任务完成
                for h in handles {
                    let _ = h.await;
                }
            })
        };

        // 6d. 解析（producer）—— 解析外部 tileset 并将下载条目推入通道
        //     当有选区时，对子 tileset 也做空间过滤
        let selection_region = polygon.map(|p| SelectionRegion::new(p));
        let resolve_result = self
            .resolve_and_stream(
                &filter_result.download_uris,
                &filter_result.uri_transforms,
                &base_url,
                &query_params,
                output_dir,
                &cancel_token,
                tx,
                total_discovered.clone(),
                selection_region.as_ref(),
            )
            .await;
        // tx 在 resolve_and_stream 结束时 drop，下载消费者在通道关闭后退出

        // 7. 等待下载完成
        resolution_done.store(true, Ordering::Relaxed);
        let _ = download_handle.await;
        progress_handle.abort();

        resolve_result?;

        if cancel_token.is_cancelled() {
            return Err("下载已取消".to_string());
        }

        // 8. 重写 root tileset.json 中的 URI 为本地路径
        let mut rewritten_tileset = rewrite_tileset_uris(&filter_result.tileset, &uri_to_local);
        strip_query_params_from_tileset(&mut rewritten_tileset);

        // 9. 写入 tileset.json
        let output_tileset_path = output_dir.join("tileset.json");
        let json = serde_json::to_string_pretty(&rewritten_tileset)
            .map_err(|e| format!("序列化 tileset.json 失败: {}", e))?;
        tokio::fs::write(&output_tileset_path, json)
            .await
            .map_err(|e| format!("写入 tileset.json 失败: {}", e))?;

        let final_completed = completed.load(Ordering::Relaxed);
        let final_failed = failed.load(Ordering::Relaxed);
        let final_total = total_discovered.load(Ordering::Relaxed);
        callback(FetchProgress {
            total: final_total,
            completed: final_completed,
            failed: final_failed,
            status: if final_failed > 0 {
                format!("下载不完整: {} 成功, {} 失败", final_completed, final_failed)
            } else {
                format!("完成: {} 成功", final_completed)
            },
        });

        if final_failed > 0 {
            return Err(format!(
                "3D Tiles 下载不完整：{} 个内容文件下载失败",
                final_failed
            ));
        }

        Ok(output_tileset_path)
    }

    /// 管线化解析：BFS 解析外部 tileset，非 JSON 文件立即推入下载通道
    /// JSON 文件解析后直接写盘，不经过下载通道
    /// 失败的 JSON 会重试最多 5 次（指数退避）
    /// 当 region 不为 None 时，对子 tileset 也做空间过滤
    async fn resolve_and_stream(
        &self,
        initial_uris: &[String],
        initial_transforms: &HashMap<String, TileTransform>,
        root_base: &str,
        query_params: &str,
        output_dir: &Path,
        cancel: &CancellationToken,
        tx: mpsc::Sender<(String, String)>,
        total_discovered: Arc<AtomicU32>,
        region: Option<&SelectionRegion>,
    ) -> Result<(), String> {
        use futures::stream::FuturesUnordered;
        use std::pin::Pin;

        type FetchResult = (
            String,
            String,
            u8,
            TileTransform,
            Result<(Tileset, Vec<u8>), String>,
        );

        let mut visited: HashSet<String> = HashSet::new();
        let sem = Arc::new(tokio::sync::Semaphore::new(50));
        let mut in_flight: FuturesUnordered<Pin<Box<dyn Future<Output = FetchResult> + Send + '_>>> =
            FuturesUnordered::new();

        // 种子：将初始 URI 分类

        // Google 3D Tiles: 根 tileset 的内容 URI 带 ?session=xxx，但子 tileset 不带
        // 需要提取 session 参数全局附加，否则子 tileset 的 glb 下载会 403
        let effective_query = {
            let mut extra = String::new();
            for uri in initial_uris {
                if let Some((_, q)) = uri.split_once('?') {
                    for p in q.split('&') {
                        if p.starts_with("session=") {
                            extra = p.to_string();
                            break;
                        }
                    }
                    if !extra.is_empty() { break; }
                }
            }
            if extra.is_empty() {
                query_params.to_string()
            } else if query_params.is_empty() {
                extra
            } else {
                format!("{}\x26{}", query_params, extra)
            }
        };
        let query_params = effective_query.as_str();

        for uri in initial_uris {
            let absolute_url = resolve_url(root_base, uri);
            if !visited.insert(absolute_url.clone()) {
                continue;
            }

            let local_path = absolute_to_local(&absolute_url, root_base);

            let clean_uri = uri.split('?').next().unwrap_or(uri);
            let is_json = clean_uri.to_lowercase().ends_with(".json");
            let inherited_transform = initial_transforms
                .get(uri)
                .copied()
                .unwrap_or(IDENTITY_TRANSFORM);

            if is_json {
                let json_base = absolute_url
                    .rsplit_once('/')
                    .map(|(b, _)| format!("{}/", b))
                    .unwrap_or_default();
                let sem_clone = sem.clone();
                let qp = query_params.to_string();
                in_flight.push(Box::pin(async move {
                    let _permit = sem_clone.acquire().await.unwrap();
                    let fetch_url = append_query(&absolute_url, &qp);
                    let result = self.fetch_raw_tileset(&fetch_url).await;
                    (absolute_url, json_base, 0u8, inherited_transform, result)
                }));
            } else {
                // 非 JSON → 立即推入下载通道
                total_discovered.fetch_add(1, Ordering::Relaxed);
                let download_url = append_query(&absolute_url, query_params);
                if tx.send((download_url, local_path)).await.is_err() {
                    break;
                }
            }
        }

        const MAX_RETRIES: u8 = 5;
        let mut resolve_failures = 0u32;

        // 连续流水线：子 tileset 一发现就立即入队解析，不等当前批次完成
        while let Some((url, base, retries, inherited_transform, result)) = in_flight.next().await {
            if cancel.is_cancelled() {
                return Err("已取消".to_string());
            }

            match result {
                Ok((sub_tileset, raw_bytes)) => {
                    let json_local = absolute_to_local(&url, root_base);
                    let dest = output_dir.join(&json_local);
                    if let Some(parent) = dest.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }

                    // 对子 tileset 应用空间过滤（如有选区）
                    let (sub_uris, sub_transforms) = if let Some(reg) = region {
                        let filter_result = filter_tileset_with_parent_transform(
                            &sub_tileset,
                            reg,
                            &inherited_transform,
                        );
                        // 重写子 tileset URI 为本地相对路径（离线预览需要）
                        let json_dir = json_local.rsplit_once('/')
                            .map(|(d, _)| format!("{}/", d))
                            .unwrap_or_default();
                        let sub_uri_map: HashMap<String, String> = filter_result.download_uris.iter()
                            .map(|uri| {
                                let abs = resolve_url(&base, uri);
                                let local = absolute_to_local(&abs, root_base);
                                let relative = if local.starts_with(&json_dir) {
                                    local[json_dir.len()..].to_string()
                                } else {
                                    local
                                };
                                (uri.clone(), relative)
                            })
                            .collect();
                        let mut filtered = rewrite_tileset_uris(&filter_result.tileset, &sub_uri_map);
                        strip_query_params_from_tileset(&mut filtered);
                        if let Ok(json) = serde_json::to_string_pretty(&filtered) {
                            let _ = tokio::fs::write(&dest, json.as_bytes()).await;
                        } else {
                            let _ = tokio::fs::write(&dest, &raw_bytes).await;
                        }
                        (filter_result.download_uris, filter_result.uri_transforms)
                    } else {
                        // 无选区：重写 URI 为本地相对路径
                        let all_uris = collect_tile_content_uris(&sub_tileset.root);
                        let json_dir = json_local.rsplit_once('/')
                            .map(|(d, _)| format!("{}/", d))
                            .unwrap_or_default();
                        let sub_uri_map: HashMap<String, String> = all_uris.iter()
                            .map(|uri| {
                                let abs = resolve_url(&base, uri);
                                let local = absolute_to_local(&abs, root_base);
                                let relative = if local.starts_with(&json_dir) {
                                    local[json_dir.len()..].to_string()
                                } else {
                                    local
                                };
                                (uri.clone(), relative)
                            })
                            .collect();
                        let mut clean = rewrite_tileset_uris(&sub_tileset, &sub_uri_map);
                        strip_query_params_from_tileset(&mut clean);
                        if let Ok(json) = serde_json::to_string_pretty(&clean) {
                            let _ = tokio::fs::write(&dest, json.as_bytes()).await;
                        } else {
                            let _ = tokio::fs::write(&dest, &raw_bytes).await;
                        }
                        (all_uris, HashMap::new())
                    };

                    for sub_uri in &sub_uris {
                        let abs = resolve_url(&base, sub_uri);
                        if !visited.insert(abs.clone()) {
                            continue;
                        }

                        let local = absolute_to_local(&abs, root_base);

                        let clean_sub = sub_uri.split('?').next().unwrap_or(sub_uri);
                        if clean_sub.to_lowercase().ends_with(".json") {
                            let child_transform = sub_transforms
                                .get(sub_uri)
                                .copied()
                                .unwrap_or(inherited_transform);
                            let json_base = abs
                                .rsplit_once('/')
                                .map(|(b, _)| format!("{}/", b))
                                .unwrap_or_default();
                            let sem_clone = sem.clone();
                            let qp = query_params.to_string();
                            in_flight.push(Box::pin(async move {
                                let _permit = sem_clone.acquire().await.unwrap();
                                let fetch_url = append_query(&abs, &qp);
                                let result = self.fetch_raw_tileset(&fetch_url).await;
                                (abs, json_base, 0u8, child_transform, result)
                            }));
                        } else {
                            total_discovered.fetch_add(1, Ordering::Relaxed);
                            let download_url = append_query(&abs, query_params);
                            if tx.send((download_url, local)).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                Err(e) => {
                    if retries < MAX_RETRIES {
                        log::warn!(
                            "解析外部 tileset 失败 (第 {} 次重试): {}",
                            retries + 1,
                            e
                        );
                        let sem_clone = sem.clone();
                        let qp = query_params.to_string();
                        let next_retries = retries + 1;
                        in_flight.push(Box::pin(async move {
                            let _permit = sem_clone.acquire().await.unwrap();
                            // 指数退避
                            let delay = std::time::Duration::from_millis(
                                500 * 2u64.pow(next_retries as u32 - 1),
                            );
                            tokio::time::sleep(delay).await;
                            let fetch_url = append_query(&url, &qp);
                            let result = self.fetch_raw_tileset(&fetch_url).await;
                            (url, base, next_retries, inherited_transform, result)
                        }));
                    } else {
                        resolve_failures += 1;
                        log::warn!(
                            "解析外部 tileset 最终失败 (已重试 {} 次): {}",
                            MAX_RETRIES, e
                        );
                    }
                }
            }
        }

        if resolve_failures > 0 {
            return Err(format!(
                "{} 个外部 tileset 解析失败，下载结果不完整",
                resolve_failures
            ));
        }

        // tx 在这里被 drop，下载消费者的 rx.recv() 将返回 None 退出循环
        Ok(())
    }
}

fn temporary_download_path(dest: &Path) -> Result<PathBuf, String> {
    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "下载目标文件名无效".to_string())?;
    Ok(dest.with_file_name(format!(
        "{}.{}.tmp",
        file_name,
        uuid::Uuid::new_v4()
    )))
}

/// 下载单个文件，带重试
async fn download_file(
    client: &Client,
    url: &str,
    auth: &HashMap<String, String>,
    dest: &Path,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let max_retries = 3;
    let mut last_err = String::new();

    for attempt in 0..max_retries {
        if cancel.is_cancelled() {
            return Err("已取消".to_string());
        }

        let mut req = client.get(url);
        for (k, v) in auth {
            req = req.header(k, v);
        }

        match req.send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_err = format!("HTTP {}", resp.status());
                    if attempt < max_retries - 1 {
                        tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64 + 1))).await;
                        continue;
                    }
                    return Err(last_err);
                }

                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| format!("读取响应体失败: {}", e))?;

                // 写入临时文件后重命名，防止写入一半被中断
                let tmp_path = temporary_download_path(dest)?;
                if let Some(parent) = tmp_path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("创建目录失败: {}", e))?;
                }
                if let Err(error) = tokio::fs::write(&tmp_path, &bytes).await {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    return Err(format!("写入文件失败: {}", error));
                }
                if let Err(error) = tokio::fs::rename(&tmp_path, dest).await {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    return Err(format!("重命名文件失败: {}", error));
                }

                return Ok(());
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt < max_retries - 1 {
                    tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64 + 1))).await;
                }
            }
        }
    }

    Err(last_err)
}

/// 将相对 URI 解析为绝对 URL（正确处理 ../ 等相对路径）
fn resolve_url(base: &str, relative: &str) -> String {
    if relative.starts_with("http://") || relative.starts_with("https://") {
        return relative.to_string();
    }
    // 用 Url::parse + join 正确解析 ../ ./ 等相对引用
    if let Ok(base_url) = reqwest::Url::parse(base) {
        if let Ok(resolved) = base_url.join(relative) {
            return resolved.to_string();
        }
    }
    // fallback: 简单拼接
    format!("{}{}", base, relative)
}

/// 给 URL 追加 query 参数（如 ?token=xxx），保持 URL 已有参数兼容
fn append_query(url: &str, query: &str) -> String {
    if query.is_empty() {
        return url.to_string();
    }
    if url.contains('?') {
        format!("{}&{}", url, query)
    } else {
        format!("{}?{}", url, query)
    }
}

/// 递归收集一个 Tile 树的所有内容 URI
fn collect_tile_content_uris(tile: &crate::tiles3d::tileset::Tile) -> Vec<String> {
    let mut uris = Vec::new();
    for uri in tile.content_uris() {
        uris.push(uri.to_string());
    }
    if let Some(ref children) = tile.children {
        for child in children {
            uris.extend(collect_tile_content_uris(child));
        }
    }
    uris
}

/// 将 URI 转为本地相对路径，保持原始目录层级
fn uri_to_local_path(uri: &str) -> String {
    // 去掉协议头（如果是绝对 URL）
    let s = uri
        .strip_prefix("http://")
        .or_else(|| uri.strip_prefix("https://"))
        .unwrap_or(uri);

    // 去掉域名部分（如果存在）
    let path_part = if let Some((_domain, path)) = s.split_once('/') {
        path
    } else {
        s
    };

    // 去掉查询参数
    let clean = path_part.split('?').next().unwrap_or(path_part);

    // 清理首尾斜杠，替换反斜杠为正斜杠
    let normalized = clean
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string();

    // 如果路径为空（不太可能），给个默认名
    if normalized.is_empty() {
        return "unknown_content".to_string();
    }

    normalized
}

/// 从绝对 URL 提取相对于 base_url 的本地路径，去除查询参数
fn absolute_to_local(absolute_url: &str, base_url: &str) -> String {
    let rel = if absolute_url.starts_with(base_url) {
        &absolute_url[base_url.len()..]
    } else {
        return uri_to_local_path(absolute_url);
    };
    // 去掉查询参数
    rel.split('?').next().unwrap_or(rel).to_string()
}

/// 重写 tileset 中所有内容 URI 为本地路径
fn rewrite_tileset_uris(
    tileset: &Tileset,
    uri_map: &HashMap<String, String>,
) -> Tileset {
    let mut result = tileset.clone();
    rewrite_tile_uris(&mut result.root, uri_map);
    result
}

fn rewrite_tile_uris(
    tile: &mut crate::tiles3d::tileset::Tile,
    uri_map: &HashMap<String, String>,
) {
    // 重写 content
    if let Some(ref mut content) = tile.content {
        if let Some(uri) = content.get_uri().map(|s| s.to_string()) {
            if let Some(local) = uri_map.get(&uri) {
                content.set_uri(local.clone());
            }
        }
    }

    // 重写 contents
    if let Some(ref mut contents) = tile.contents {
        for content in contents.iter_mut() {
            if let Some(uri) = content.get_uri().map(|s| s.to_string()) {
                if let Some(local) = uri_map.get(&uri) {
                    content.set_uri(local.clone());
                }
            }
        }
    }

    // 递归子节点
    if let Some(ref mut children) = tile.children {
        for child in children.iter_mut() {
            rewrite_tile_uris(child, uri_map);
        }
    }
}

/// 去掉 tileset 中所有 content URI 的查询参数，用于本地化存储
fn strip_query_params_from_tileset(tileset: &mut Tileset) {
    strip_query_params_from_tile(&mut tileset.root);
}

fn strip_query_params_from_tile(tile: &mut crate::tiles3d::tileset::Tile) {
    if let Some(ref mut content) = tile.content {
        if let Some(uri) = content.get_uri().map(|s| s.to_string()) {
            if let Some((path, _)) = uri.split_once('?') {
                content.set_uri(path.to_string());
            }
        }
    }
    if let Some(ref mut contents) = tile.contents {
        for content in contents.iter_mut() {
            if let Some(uri) = content.get_uri().map(|s| s.to_string()) {
                if let Some((path, _)) = uri.split_once('?') {
                    content.set_uri(path.to_string());
                }
            }
        }
    }
    if let Some(ref mut children) = tile.children {
        for child in children.iter_mut() {
            strip_query_params_from_tile(child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_paths_preserve_full_file_name_and_are_unique() {
        let glb = temporary_download_path(Path::new("tiles/a.glb")).unwrap();
        let b3dm = temporary_download_path(Path::new("tiles/a.b3dm")).unwrap();
        let second_glb = temporary_download_path(Path::new("tiles/a.glb")).unwrap();

        assert!(glb.file_name().unwrap().to_string_lossy().starts_with("a.glb."));
        assert!(b3dm.file_name().unwrap().to_string_lossy().starts_with("a.b3dm."));
        assert_ne!(glb, b3dm);
        assert_ne!(glb, second_glb);
    }
}
