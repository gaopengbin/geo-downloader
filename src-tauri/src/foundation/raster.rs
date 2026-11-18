//! Native-only raster tiles. Neither geographic features nor glyph work enters the WebView.
use super::{cancelled, check_page, register, Bounds, Layer, Source};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::SystemTime,
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tokio_util::sync::CancellationToken;

mod draw;
const SIZE: u32 = 512;
const PAD: u32 = 128;
const MAX_DATA_BYTES: usize = 32 * 1024 * 1024;
const DISK_BUDGET: u64 = 256 * 1024 * 1024;
const HEADER: &[u8; 8] = b"GDRPNG1\0";
static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static LOCKS: OnceLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> = OnceLock::new();
static MEMORY: OnceLock<Mutex<VecDeque<(String, Arc<Rendered>)>>> = OnceLock::new();
static WRITES: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RasterStyle {
    pub layer: Layer,
    pub color: String,
    pub width: u8,
    pub labels: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RasterConfig {
    pub layers: Vec<RasterStyle>,
    pub font_size: u8,
    pub gcj: bool,
    pub revision: u32,
}
impl RasterConfig {
    fn validate(&mut self, z: u8, x: u32, y: u32) -> Result<(), String> {
        if !(8..=22).contains(&z) || x >= 1u32 << (z - 1) || y >= 1u32 << (z - 1) {
            return Err("FOUNDATION_BOUNDS: invalid raster tile".into());
        }
        if self.layers.is_empty() || self.layers.len() > 4 || !(10..=22).contains(&self.font_size) {
            return Err("FOUNDATION_STYLE: invalid raster configuration".into());
        }
        let mut seen = HashSet::new();
        for style in &mut self.layers {
            if !seen.insert(style.layer.id())
                || !(1..=4).contains(&style.width)
                || style.color.len() != 7
                || !style.color.starts_with('#')
                || !style.color.as_bytes()[1..]
                    .iter()
                    .all(u8::is_ascii_hexdigit)
            {
                return Err("FOUNDATION_STYLE: invalid raster style".into());
            }
            style.color.make_ascii_lowercase();
        }
        self.layers.sort_by_key(|s| rank(s.layer));
        Ok(())
    }
}
fn rank(layer: Layer) -> u8 {
    match layer {
        Layer::Water => 0,
        Layer::Roads => 1,
        Layer::Railways => 2,
        Layer::Settlements => 3,
    }
}
struct Rendered {
    png: Vec<u8>,
    font_available: bool,
    empty: bool,
}
#[derive(Serialize)]
pub struct RasterTile {
    pub data_url: String,
    pub font_available: bool,
    pub empty: bool,
    pub cache_hit: bool,
}
fn response(value: &Rendered, cache_hit: bool) -> RasterTile {
    RasterTile {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&value.png)
        ),
        font_available: value.font_available,
        empty: value.empty,
        cache_hit,
    }
}
fn remembered(key: &str) -> Option<Arc<Rendered>> {
    let mut cache = MEMORY.get_or_init(Default::default).lock().unwrap();
    let index = cache.iter().position(|(k, _)| k == key)?;
    let item = cache.remove(index).unwrap();
    let result = item.1.clone();
    cache.push_back(item);
    Some(result)
}
fn remember(key: String, tile: Arc<Rendered>) {
    let mut cache = MEMORY.get_or_init(Default::default).lock().unwrap();
    cache.retain(|(k, _)| k != &key);
    cache.push_back((key, tile));
    while cache.len() > 64
        || cache.iter().map(|(_, t)| t.png.len()).sum::<usize>() > 16 * 1024 * 1024
    {
        cache.pop_front();
    }
}
fn key_lock(key: &str) -> Arc<AsyncMutex<()>> {
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap();
    if locks.len() >= 128 {
        locks.retain(|_, value| value.strong_count() > 0);
    }
    if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(key.into(), Arc::downgrade(&lock));
    lock
}
fn read_disk(root: &Path, key: &str) -> Option<Rendered> {
    let path = root.join(format!("{key}.tile"));
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.len() > 4 * 1024 * 1024
        || SystemTime::now()
            .duration_since(meta.modified().ok()?)
            .ok()?
            .as_secs()
            > 86400
    {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 10 || &bytes[..8] != HEADER {
        return None;
    }
    let png = bytes[10..].to_vec();
    if png.len() < 24
        || !png.starts_with(b"\x89PNG\r\n\x1a\n")
        || &png[12..16] != b"IHDR"
        || u32::from_be_bytes(png[16..20].try_into().ok()?) != SIZE
        || u32::from_be_bytes(png[20..24].try_into().ok()?) != SIZE
    {
        return None;
    }
    let decoded = tiny_skia::Pixmap::decode_png(&png).ok()?;
    if decoded.width() != SIZE || decoded.height() != SIZE {
        return None;
    }
    Some(Rendered {
        png,
        font_available: bytes[8] == 1,
        empty: bytes[9] == 1,
    })
}
fn write_disk(root: &Path, key: &str, tile: &Rendered) {
    if std::fs::create_dir_all(root).is_err()
        || std::fs::symlink_metadata(root)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true)
    {
        return;
    }
    let temp = root.join(format!(".{key}.{}.tmp", uuid::Uuid::new_v4()));
    let mut bytes = Vec::with_capacity(10 + tile.png.len());
    bytes.extend_from_slice(HEADER);
    bytes.extend_from_slice(&[u8::from(tile.font_available), u8::from(tile.empty)]);
    bytes.extend_from_slice(&tile.png);
    if std::fs::write(&temp, bytes).is_ok() {
        let _ = std::fs::rename(&temp, root.join(format!("{key}.tile")));
    }
    let _ = std::fs::remove_file(&temp);
    if WRITES.fetch_add(1, Ordering::Relaxed) % 64 != 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut files = Vec::new();
    let mut total = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.len() != 69
            || !name.ends_with(".tile")
            || !name.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit)
        {
            continue;
        }
        if let Ok(meta) = std::fs::symlink_metadata(entry.path()) {
            if meta.is_file() && !meta.file_type().is_symlink() {
                total += meta.len();
                files.push((
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    meta.len(),
                    entry.path(),
                ));
            }
        }
    }
    files.sort_by_key(|x| x.0);
    for (_, size, path) in files {
        if total <= DISK_BUDGET {
            break;
        }
        if path.parent() == Some(root) && std::fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

pub(super) fn project(lng: f64, lat: f64, z: u8) -> (f64, f64) {
    let world = 256.0 * 2f64.powi(z as i32);
    let sin = lat.clamp(-85.05112878, 85.05112878).to_radians().sin();
    (
        (lng + 180.) / 360. * world,
        (0.5 - ((1. + sin) / (1. - sin)).ln() / (4. * std::f64::consts::PI)) * world,
    )
}
fn unproject(x: f64, y: f64, z: u8) -> (f64, f64) {
    let world = 256.0 * 2f64.powi(z as i32);
    (
        x / world * 360. - 180.,
        (std::f64::consts::PI * (1. - 2. * y / world))
            .sinh()
            .atan()
            .to_degrees(),
    )
}
fn wgs_to_gcj(lng: f64, lat: f64) -> (f64, f64) {
    use std::f64::consts::PI;
    if !(73.66 < lng && lng < 135.05 && 3.86 < lat && lat < 53.55) {
        return (lng, lat);
    }
    let x = lng - 105.;
    let y = lat - 35.;
    let rad = lat.to_radians();
    let magic = 1. - 0.006693421622965943 * rad.sin().powi(2);
    let sqrt = magic.sqrt();
    let mut dlat = -100. + 2. * x + 3. * y + 0.2 * y * y + 0.1 * x * y + 0.2 * x.abs().sqrt();
    dlat += (20. * (6. * x * PI).sin() + 20. * (2. * x * PI).sin()) * 2. / 3.;
    dlat += (20. * (y * PI).sin() + 40. * (y / 3. * PI).sin()) * 2. / 3.;
    dlat += (160. * (y / 12. * PI).sin() + 320. * (y * PI / 30.).sin()) * 2. / 3.;
    let mut dlng = 300. + x + 2. * y + 0.1 * x * x + 0.1 * x * y + 0.1 * x.abs().sqrt();
    dlng += (20. * (6. * x * PI).sin() + 20. * (2. * x * PI).sin()) * 2. / 3.;
    dlng += (20. * (x * PI).sin() + 40. * (x / 3. * PI).sin()) * 2. / 3.;
    dlng += (150. * (x / 12. * PI).sin() + 300. * (x / 30. * PI).sin()) * 2. / 3.;
    (
        lng + dlng * 180. / (6378245. / sqrt * rad.cos() * PI),
        lat + dlat * 180. / (6378245. * (1. - 0.006693421622965943) / (magic * sqrt) * PI),
    )
}
fn gcj_to_wgs(lng: f64, lat: f64) -> (f64, f64) {
    let (mut x, mut y) = (lng, lat);
    for _ in 0..4 {
        let p = wgs_to_gcj(x, y);
        x += lng - p.0;
        y += lat - p.1;
    }
    (x, y)
}
pub(super) fn bounds(config: &RasterConfig, z: u8, x: u32, y: u32) -> Bounds {
    let mut points = Vec::new();
    for px in [
        x as f64 * SIZE as f64 - PAD as f64,
        (x + 1) as f64 * SIZE as f64 + PAD as f64,
    ] {
        for py in [
            y as f64 * SIZE as f64 - PAD as f64,
            (y + 1) as f64 * SIZE as f64 + PAD as f64,
        ] {
            let p = unproject(px, py, z);
            points.push(if config.gcj { gcj_to_wgs(p.0, p.1) } else { p });
        }
    }
    Bounds {
        west: points
            .iter()
            .map(|p| p.0)
            .fold(f64::INFINITY, f64::min)
            .max(-180.),
        east: points
            .iter()
            .map(|p| p.0)
            .fold(f64::NEG_INFINITY, f64::max)
            .min(180.),
        south: points
            .iter()
            .map(|p| p.1)
            .fold(f64::INFINITY, f64::min)
            .max(-85.05112878),
        north: points
            .iter()
            .map(|p| p.1)
            .fold(f64::NEG_INFINITY, f64::max)
            .min(85.05112878),
    }
}
async fn data(
    source: &Source,
    config: &RasterConfig,
    bounds: Bounds,
    cancel: &CancellationToken,
) -> Result<Vec<(RasterStyle, Vec<Value>)>, String> {
    let mut result = Vec::new();
    let mut bytes = 0;
    for style in &config.layers {
        let mut features = Vec::new();
        let mut seen = HashSet::new();
        loop {
            let start = features.len();
            let (page, _) = source.page(style.layer, bounds, start, cancel).await?;
            check_page(&page, start, &mut seen)?;
            bytes += serde_json::to_vec(&page.features)
                .map_err(|_| "FOUNDATION_RESPONSE")?
                .len();
            if bytes > MAX_DATA_BYTES || start + page.features.len() > 50_000 {
                return Err("FOUNDATION_DENSITY: zoom in to generate raster tiles".into());
            }
            let done = page
                .matched
                .map(|n| start as u64 + page.features.len() as u64 >= n)
                .unwrap_or(page.features.len() < source.page_size);
            features.extend(page.features);
            if done {
                break;
            }
        }
        result.push((style.clone(), features));
    }
    Ok(result)
}
pub(super) async fn tile(
    mut source: Source,
    mut config: RasterConfig,
    z: u8,
    x: u32,
    y: u32,
    cancel: &CancellationToken,
) -> Result<RasterTile, String> {
    config.validate(z, x, y)?;
    if cancel.is_cancelled() {
        return Err(cancelled());
    }
    // Installing a missing system font then restarting must invalidate old no-label images.
    let font_ready = if !config.layers.iter().any(|s| s.labels) {
        true
    } else if let Some(available) = draw::font_state() {
        available
    } else {
        tokio::select! {_ = cancel.cancelled()=>return Err(cancelled()),value=tokio::task::spawn_blocking(draw::ensure_font)=>value.map_err(|_|"FOUNDATION_RASTER: font worker")?}
    };
    let root = source
        .cache
        .parent()
        .unwrap_or(&source.cache)
        .join("foundation-raster-v1");
    let key = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                2,
                &source.endpoint,
                &source.cache,
                &config,
                font_ready,
                z,
                x,
                y,
                chrono::Utc::now().format("%Y-%m-%d").to_string()
            ))
            .unwrap()
        )
    );
    if let Some(value) = remembered(&key) {
        return Ok(response(&value, true));
    }
    let lock = key_lock(&key);
    let _guard =
        tokio::select! {_ = cancel.cancelled()=>return Err(cancelled()),guard=lock.lock()=>guard};
    if let Some(value) = remembered(&key) {
        return Ok(response(&value, true));
    }
    let slots = SLOTS.get_or_init(|| Arc::new(Semaphore::new(2))).clone();
    let permit = tokio::select! {_ = cancel.cancelled()=>return Err(cancelled()),permit=slots.acquire_owned()=>permit.map_err(|_|"FOUNDATION_BUSY")?};
    let read_root = root.clone();
    let read_key = key.clone();
    let disk = tokio::task::spawn_blocking(move || read_disk(&read_root, &read_key))
        .await
        .map_err(|_| "FOUNDATION_RASTER: cache worker")?;
    if let Some(value) = disk {
        let value = Arc::new(value);
        remember(key, value.clone());
        return Ok(response(&value, true));
    }
    source.cache_read = config.revision == 0;
    let features = data(&source, &config, bounds(&config, z, x, y), cancel).await?;
    let token = cancel.clone();
    let cache_root = root;
    let cache_key = key.clone();
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let result = draw::render(&features, &config, z, x, y, &token)?;
        if token.is_cancelled() {
            return Err(cancelled());
        }
        write_disk(&cache_root, &cache_key, &result);
        Ok::<_, String>(result)
    });
    let result = tokio::select! {_ = cancel.cancelled()=>return Err(cancelled()),value=work=>value.map_err(|_|"FOUNDATION_RASTER: render worker failed")??};
    let result = Arc::new(result);
    remember(key, result.clone());
    Ok(response(&result, false))
}
#[tauri::command]
pub async fn foundation_raster_tile(
    request_id: String,
    config: RasterConfig,
    z: u8,
    x: u32,
    y: u32,
    proxy: Option<String>,
) -> Result<RasterTile, String> {
    let (_guard, cancel) = register(&request_id)?;
    tile(Source::new(proxy.as_deref())?, config, z, x, y, &cancel).await
}

pub(super) async fn render_snapshot(
    identity: &str,
    mut config: RasterConfig,
    features: Vec<Value>,
    z: u8,
    x: u32,
    y: u32,
    cancel: &CancellationToken,
) -> Result<RasterTile, String> {
    config.validate(z, x, y)?;
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(identity, &config, z, x, y)).unwrap())
    );
    if let Some(value) = remembered(&key) {
        return Ok(response(&value, true));
    }
    let slots = SLOTS.get_or_init(|| Arc::new(Semaphore::new(2))).clone();
    let permit = tokio::select! { _ = cancel.cancelled() => return Err(cancelled()), p = slots.acquire_owned() => p.map_err(|_| "FOUNDATION_BUSY")? };
    let token = cancel.clone();
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        draw::render(
            &[(config.layers[0].clone(), features)],
            &config,
            z,
            x,
            y,
            &token,
        )
    });
    let value = tokio::select! { _ = cancel.cancelled() => return Err(cancelled()), v = work => v.map_err(|_| "FOUNDATION_RASTER: worker failed")?? };
    let value = Arc::new(value);
    remember(key, value.clone());
    Ok(response(&value, false))
}

#[cfg(test)]
mod tests;
