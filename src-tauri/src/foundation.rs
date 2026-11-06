//! National reference features: fixed public WFS, bounded previews and streamed exports.
use crate::tile::Bounds;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;
use tokio::{io::AsyncWriteExt, sync::Semaphore};
use tokio_util::sync::CancellationToken;

const ENDPOINT: &str = "https://gisserver.tianditu.gov.cn/TDTService/wfs";
const PAGE_SIZE: usize = 500;
const PREVIEW_LIMIT: usize = 2000;
const MAX_PAGE_BYTES: usize = 16 * 1024 * 1024;
const CACHE_BUDGET: u64 = 256 * 1024 * 1024;
const CACHE_TTL: u64 = 86400;
static SLOTS: Semaphore = Semaphore::const_new(2);
static REQUESTS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
static EARLY_CANCELS: OnceLock<Mutex<Vec<(String, tokio::time::Instant)>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layer {
    Water,
    Roads,
    Railways,
    Settlements,
}
impl Layer {
    fn code(self) -> &'static str {
        match self {
            Self::Water => "HYDL",
            Self::Roads => "LRDL",
            Self::Railways => "LRRL",
            Self::Settlements => "AGNP",
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::Water => "water",
            Self::Roads => "roads",
            Self::Railways => "railways",
            Self::Settlements => "settlements",
        }
    }
}
fn validate_bounds(b: Bounds) -> Result<(), String> {
    if [b.west, b.south, b.east, b.north]
        .iter()
        .all(|v| v.is_finite())
        && b.west >= -180.
        && b.east <= 180.
        && b.south >= -90.
        && b.north <= 90.
        && b.west < b.east
        && b.south < b.north
    {
        Ok(())
    } else {
        Err("FOUNDATION_BOUNDS: invalid geographic bounds".into())
    }
}
fn cancelled() -> String {
    "FOUNDATION_CANCELLED".into()
}
struct RequestGuard(String);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        REQUESTS.get().unwrap().lock().unwrap().remove(&self.0);
    }
}
fn register(id: &str) -> Result<(RequestGuard, CancellationToken), String> {
    let id = uuid::Uuid::parse_str(id)
        .map_err(|_| "FOUNDATION_REQUEST: invalid request identifier")?
        .to_string();
    let mut map = REQUESTS.get_or_init(Default::default).lock().unwrap();
    let mut early = EARLY_CANCELS.get_or_init(Default::default).lock().unwrap();
    early.retain(|(_, at)| at.elapsed() < Duration::from_secs(60));
    if let Some(i) = early.iter().position(|(key, _)| key == &id) {
        early.remove(i);
        return Err(cancelled());
    }
    if map.len() >= 32 || map.contains_key(&id) {
        return Err("FOUNDATION_BUSY".into());
    }
    let token = CancellationToken::new();
    map.insert(id.clone(), token.clone());
    Ok((RequestGuard(id), token))
}
#[tauri::command]
pub fn foundation_cancel(request_id: String) {
    let Ok(id) = uuid::Uuid::parse_str(&request_id).map(|v| v.to_string()) else {
        return;
    };
    let requests = REQUESTS.get_or_init(Default::default).lock().unwrap();
    if let Some(token) = requests.get(&id) {
        token.cancel();
    } else {
        let mut early = EARLY_CANCELS.get_or_init(Default::default).lock().unwrap();
        if early.len() >= 64 {
            early.remove(0);
        }
        early.push((id, tokio::time::Instant::now()));
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Page {
    fetched_at: u64,
    matched: Option<u64>,
    features: Vec<Value>,
}
#[derive(Debug, Serialize)]
pub struct Preview {
    layer: Layer,
    bounds: Bounds,
    geojson: Value,
    feature_count: usize,
    total_matched: Option<u64>,
    truncated: bool,
    cache_hits: usize,
    network_pages: usize,
    queried_at: String,
    source: &'static str,
}
struct Source {
    client: Client,
    endpoint: String,
    cache: PathBuf,
    page_size: usize,
    cache_read: bool,
}
impl Source {
    fn new(proxy: Option<&str>) -> Result<Self, String> {
        let mut builder = Client::builder()
            .connect_timeout(Duration::from_secs(6))
            .timeout(Duration::from_secs(25))
            .user_agent(concat!("GeoD/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::custom(|a| {
                if a.previous().len() < 3
                    && a.url().scheme() == "https"
                    && a.url().host_str() == Some("gisserver.tianditu.gov.cn")
                {
                    a.follow()
                } else {
                    a.error("Untrusted WFS redirect")
                }
            }));
        if let Some(proxy) = proxy.filter(|p| !p.trim().is_empty()) {
            builder = builder
                .proxy(reqwest::Proxy::all(proxy).map_err(|_| "FOUNDATION_PROXY: invalid proxy")?);
        } else {
            builder = builder.no_proxy();
        }
        Ok(Self {
            client: builder
                .build()
                .map_err(|_| "FOUNDATION_NETWORK: client setup")?,
            endpoint: ENDPOINT.into(),
            cache: dirs::cache_dir()
                .ok_or("FOUNDATION_CACHE: cache directory unavailable")?
                .join("GeoDownloader/foundation-wfs-v1"),
            page_size: PAGE_SIZE,
            cache_read: true,
        })
    }
    async fn page(
        &self,
        layer: Layer,
        bounds: Bounds,
        start: usize,
        cancel: &CancellationToken,
    ) -> Result<(Page, bool), String> {
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        let key = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(1, &self.endpoint, layer, bounds, start, self.page_size))
                    .unwrap()
            )
        );
        let path = self.cache.join(format!("{key}.json"));
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if self.cache_read {
            if let Ok(meta) = tokio::fs::symlink_metadata(&path).await {
                if meta.is_file()
                    && !meta.file_type().is_symlink()
                    && meta.len() <= MAX_PAGE_BYTES as u64
                {
                    if let Ok(bytes) = tokio::fs::read(&path).await {
                        if let Ok(page) = serde_json::from_slice::<Page>(&bytes) {
                            if now
                                .checked_sub(page.fetched_at)
                                .is_some_and(|age| age < CACHE_TTL)
                                && page.features.len() <= self.page_size
                                && page.features.iter().all(valid_feature)
                            {
                                return Ok((page, true));
                            }
                        }
                    }
                }
            }
        }
        let _permit = tokio::select! {_ = cancel.cancelled()=>return Err(cancelled()),permit=SLOTS.acquire()=>permit.map_err(|_|"FOUNDATION_BUSY")?};
        let bbox = format!(
            "{},{},{},{},urn:ogc:def:crs:OGC:1.3:CRS84",
            bounds.west, bounds.south, bounds.east, bounds.north
        );
        let params = [
            ("service", "WFS".to_owned()),
            ("version", "2.0.0".into()),
            ("request", "GetFeature".into()),
            ("typeNames", format!("TDTService:{}", layer.code())),
            ("outputFormat", "application/json".into()),
            ("srsName", "EPSG:4326".into()),
            ("bbox", bbox),
            ("count", self.page_size.to_string()),
            ("startIndex", start.to_string()),
        ];
        let mut attempt = 0;
        let page = loop {
            let response = tokio::select! {_ = cancel.cancelled()=>return Err(cancelled()),r=self.client.get(&self.endpoint).query(&params).send()=>r.map_err(|_|"FOUNDATION_NETWORK: request failed")?};
            let status = response.status().as_u16();
            if matches!(status, 429 | 503) && attempt == 0 {
                let wait = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_retry_after)
                    .unwrap_or(1);
                if wait > 30 {
                    return Err(format!("FOUNDATION_RATE_LIMITED: HTTP {status}"));
                }
                tokio::select! {_ = cancel.cancelled()=>return Err(cancelled()),_ = tokio::time::sleep(Duration::from_secs(wait.max(1)))=>{}}
                attempt += 1;
                continue;
            }
            if matches!(status, 429 | 503) {
                return Err(format!("FOUNDATION_RATE_LIMITED: HTTP {status}"));
            }
            if status != 200 {
                return Err(format!("FOUNDATION_HTTP: {status}"));
            }
            let mut response = response;
            let mut bytes = Vec::new();
            loop {
                let chunk = tokio::select! {_ = cancel.cancelled()=>return Err(cancelled()),r=response.chunk()=>r.map_err(|_|"FOUNDATION_NETWORK: response interrupted")?};
                let Some(chunk) = chunk else { break };
                if bytes.len() + chunk.len() > MAX_PAGE_BYTES {
                    return Err("FOUNDATION_RESPONSE_TOO_LARGE".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| "FOUNDATION_RESPONSE: invalid JSON")?;
            break parse_page(value, self.page_size, now)?;
        };
        // Cache failure must not turn valid public data into a failed preview.
        if !cancel.is_cancelled() {
            self.cache_page(&key, &page).await;
        }
        Ok((page, false))
    }
    async fn cache_page(&self, key: &str, page: &Page) {
        if tokio::fs::create_dir_all(&self.cache).await.is_err() {
            return;
        }
        if tokio::fs::symlink_metadata(&self.cache)
            .await
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true)
        {
            return;
        }
        let temporary = self
            .cache
            .join(format!(".{key}.{}.tmp", uuid::Uuid::new_v4()));
        let target = self.cache.join(format!("{key}.json"));
        if let Ok(bytes) = serde_json::to_vec(page) {
            if tokio::fs::write(&temporary, bytes).await.is_ok() {
                let _ = tokio::fs::rename(&temporary, &target).await;
            }
        }
        let _ = tokio::fs::remove_file(&temporary).await;
        if let Ok(mut entries) = tokio::fs::read_dir(&self.cache).await {
            let mut files = Vec::new();
            let mut total = 0;
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.len() != 69
                    || !name.ends_with(".json")
                    || !name.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit)
                {
                    continue;
                }
                if let Ok(meta) = entry.metadata().await {
                    if meta.is_file()
                        && !entry
                            .file_type()
                            .await
                            .map(|t| t.is_symlink())
                            .unwrap_or(true)
                    {
                        total += meta.len();
                        files.push((
                            meta.modified().unwrap_or(UNIX_EPOCH),
                            meta.len(),
                            entry.path(),
                        ));
                    }
                }
            }
            files.sort_by_key(|v| v.0);
            for (_, size, path) in files {
                if total <= CACHE_BUDGET {
                    break;
                }
                if path.parent() == Some(self.cache.as_path())
                    && tokio::fs::remove_file(path).await.is_ok()
                {
                    total = total.saturating_sub(size);
                }
            }
        }
    }
}
fn valid_feature(value: &Value) -> bool {
    fn point(v: &Value) -> bool {
        v.as_array().is_some_and(|a| {
            a.len() >= 2
                && a[0]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n.abs() <= 180.)
                && a[1]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n.abs() <= 90.)
        })
    }
    fn list(v: &Value, depth: u8) -> bool {
        if depth == 0 {
            return point(v);
        }
        v.as_array()
            .is_some_and(|a| !a.is_empty() && a.iter().all(|v| list(v, depth - 1)))
    }
    value["type"] == "Feature"
        && value
            .get("properties")
            .is_some_and(|v| v.is_object() || v.is_null())
        && value.get("geometry").is_some_and(|v| {
            let depth = match v["type"].as_str() {
                Some("Point") => 0,
                Some("MultiPoint" | "LineString") => 1,
                Some("MultiLineString" | "Polygon") => 2,
                Some("MultiPolygon") => 3,
                _ => return false,
            };
            list(&v["coordinates"], depth)
        })
}
fn parse_retry_after(value: &str) -> Option<u64> {
    value.trim().parse().ok().or_else(|| {
        chrono::DateTime::parse_from_rfc2822(value).ok().map(|at| {
            at.signed_duration_since(chrono::Utc::now())
                .num_seconds()
                .max(0) as u64
        })
    })
}
fn parse_page(value: Value, count: usize, now: u64) -> Result<Page, String> {
    if value["type"] != "FeatureCollection" {
        return Err("FOUNDATION_RESPONSE: not a feature collection".into());
    }
    if let Some(name) = value
        .pointer("/crs/properties/name")
        .and_then(Value::as_str)
    {
        if !name.ends_with("4326") && !name.ends_with("CRS84") {
            return Err("FOUNDATION_CRS: unexpected coordinate system".into());
        }
    }
    let features = value["features"]
        .as_array()
        .ok_or("FOUNDATION_RESPONSE: missing features")?;
    if features.len() > count || !features.iter().all(valid_feature) {
        return Err("FOUNDATION_RESPONSE: invalid or oversized page".into());
    }
    let matched = value["numberMatched"]
        .as_u64()
        .or_else(|| value["totalFeatures"].as_u64());
    Ok(Page {
        fetched_at: now,
        matched,
        features: features.clone(),
    })
}
fn feature_key(value: &Value) -> String {
    value
        .get("id")
        .filter(|v| !v.is_null())
        .map(Value::to_string)
        .unwrap_or_else(|| format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap())))
}
fn check_page(page: &Page, start: usize, seen: &mut HashSet<String>) -> Result<(), String> {
    if page
        .matched
        .is_some_and(|n| n < (start + page.features.len()) as u64)
    {
        return Err("FOUNDATION_RESPONSE: inconsistent feature count".into());
    }
    if page.features.is_empty() && page.matched.is_some_and(|n| n > start as u64) {
        return Err("FOUNDATION_RESPONSE: incomplete pagination".into());
    }
    for f in &page.features {
        if !seen.insert(feature_key(f)) {
            return Err("FOUNDATION_RESPONSE: repeated feature or unsupported pagination".into());
        }
    }
    Ok(())
}
async fn preview(
    source: &Source,
    layer: Layer,
    bounds: Bounds,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<Preview, String> {
    validate_bounds(bounds)?;
    let mut features = Vec::new();
    let mut seen = HashSet::new();
    let mut hits = 0;
    let mut network = 0;
    let mut matched = None;
    let mut truncated = false;
    let mut oldest = u64::MAX;
    loop {
        let start = features.len();
        let (page, cached) = source.page(layer, bounds, start, cancel).await?;
        if cached {
            hits += 1
        } else {
            network += 1
        }
        oldest = oldest.min(page.fetched_at);
        matched = page.matched.or(matched);
        check_page(&page, start, &mut seen)?;
        let len = page.features.len();
        features.extend(page.features);
        let done = matched
            .map(|n| features.len() as u64 >= n)
            .unwrap_or(len < source.page_size);
        if done {
            break;
        }
        if features.len() >= limit {
            truncated = true;
            break;
        }
    }
    let count = features.len();
    Ok(Preview {
        layer,
        bounds,
        geojson: json!({"type":"FeatureCollection","features":features}),
        feature_count: count,
        total_matched: matched,
        truncated,
        cache_hits: hits,
        network_pages: network,
        queried_at: chrono::DateTime::from_timestamp(oldest as i64, 0)
            .unwrap_or_default()
            .to_rfc3339(),
        source: ENDPOINT,
    })
}
#[tauri::command]
pub async fn foundation_preview(
    request_id: String,
    layer: Layer,
    bounds: Bounds,
    proxy: Option<String>,
    refresh: Option<bool>,
) -> Result<Preview, String> {
    let (_guard, cancel) = register(&request_id)?;
    let mut source = Source::new(proxy.as_deref())?;
    source.cache_read = !refresh.unwrap_or(false);
    preview(&source, layer, bounds, PREVIEW_LIMIT, &cancel).await
}

#[derive(Clone, Serialize)]
pub struct ExportProgress {
    pub layer: Layer,
    pub features: u64,
    pub total: Option<u64>,
}
#[derive(Serialize)]
pub struct ExportResult {
    pub features: u64,
    pub bytes: u64,
    pub path: String,
}
async fn export(
    source: &Source,
    layers: &[Layer],
    bounds: Bounds,
    path: &Path,
    cancel: &CancellationToken,
    mut progress: impl FnMut(ExportProgress),
) -> Result<ExportResult, String> {
    validate_bounds(bounds)?;
    if layers.is_empty()
        || layers.len() > 4
        || layers.iter().map(|l| l.id()).collect::<HashSet<_>>().len() != layers.len()
    {
        return Err("FOUNDATION_LAYERS: invalid layer selection".into());
    }
    if path
        .extension()
        .and_then(|v| v.to_str())
        .map_or(true, |v| !v.eq_ignore_ascii_case("geojson"))
    {
        return Err("FOUNDATION_OUTPUT: choose a GeoJSON file".into());
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".geod-foundation-{}.part", uuid::Uuid::new_v4()));
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .await
        .map_err(|_| "FOUNDATION_STORAGE: cannot create output")?;
    let result=async {
        file.write_all(b"{\"type\":\"FeatureCollection\",\"features\":[").await.map_err(|_|"FOUNDATION_STORAGE: write failed")?;
        let mut total=0;
        for &layer in layers {let mut start=0;let mut seen=HashSet::new();
            loop {
                if cancel.is_cancelled(){return Err(cancelled());}
                crate::fs_util::ensure_minimum_free_space(&temporary).map_err(|_|"FOUNDATION_STORAGE: insufficient space")?;
                let (page,_)=source.page(layer,bounds,start,cancel).await?;check_page(&page,start,&mut seen)?;
                let count=page.features.len();let matched=page.matched;
                for mut feature in page.features {
                    if cancel.is_cancelled(){return Err(cancelled());}
                    if feature["properties"].is_null(){feature["properties"]=json!({});}feature["properties"]["geod:layer"]=json!(layer.id());
                    if total>0{file.write_all(b",").await.map_err(|_|"FOUNDATION_STORAGE: write failed")?;}
                    file.write_all(&serde_json::to_vec(&feature).map_err(|_|"FOUNDATION_RESPONSE: feature encoding")?).await.map_err(|_|"FOUNDATION_STORAGE: write failed")?;total+=1;
                }
                start+=count;progress(ExportProgress {layer,features:total,total:matched});
                if matched.map(|n|start as u64>=n).unwrap_or(count<source.page_size){break;}
            }
        }
        let metadata=json!({"source":ENDPOINT,"provider":"国家基础地理信息中心 / 天地图","crs":"EPSG:4326","bounds":bounds,"layers":layers,"queriedAt":chrono::Utc::now().to_rfc3339()});
        file.write_all(b"],\"geod:provenance\":").await.map_err(|_|"FOUNDATION_STORAGE: write failed")?;
        file.write_all(&serde_json::to_vec(&metadata).unwrap()).await.map_err(|_|"FOUNDATION_STORAGE: write failed")?;
        file.write_all(b"}").await.map_err(|_|"FOUNDATION_STORAGE: write failed")?;file.sync_all().await.map_err(|_|"FOUNDATION_STORAGE: sync failed")?;
        if cancel.is_cancelled(){return Err(cancelled());}Ok(total)
    }.await;
    drop(file);
    match result {
        Ok(features) => {
            if let Err(_) = tokio::fs::rename(&temporary, path).await {
                let _ = tokio::fs::remove_file(&temporary).await;
                return Err("FOUNDATION_STORAGE: cannot commit output".into());
            }
            let bytes = tokio::fs::metadata(path)
                .await
                .map_err(|_| "FOUNDATION_STORAGE: cannot verify output")?
                .len();
            Ok(ExportResult {
                features,
                bytes,
                path: path.to_string_lossy().into_owned(),
            })
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary).await;
            Err(error)
        }
    }
}
#[tauri::command]
pub async fn foundation_export(
    app: tauri::AppHandle,
    request_id: String,
    layers: Vec<Layer>,
    bounds: Bounds,
    path: String,
    proxy: Option<String>,
) -> Result<ExportResult, String> {
    let (_guard, cancel) = register(&request_id)?;
    let source = Source::new(proxy.as_deref())?;
    export(&source, &layers, bounds, Path::new(&path), &cancel, |p| {
        let _ = app.emit(&format!("foundation-export-{request_id}"), p);
    })
    .await
}

#[cfg(test)]
mod tests;
