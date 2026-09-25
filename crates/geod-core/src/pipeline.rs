//! Strict, bounded headless jobs and the versioned GeoStyle artifact contract.
use crate::{tile, vector};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub schema_version: String,
    pub name: String,
    /// All public bounds use WGS84 [west, south, east, north].
    pub bounds: [f64; 4],
    pub imagery: Option<ImageryRequest>,
    pub vector: Option<vector::VectorRequest>,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageryRequest {
    pub url: String,
    pub source: String,
    pub attribution: String,
    pub zoom: u8,
    /// Native square tile edge in pixels. Does not change XYZ coordinates.
    #[serde(default = "default_tile_size")]
    pub tile_size: u32,
    #[serde(default)]
    pub zoom_max: Option<u8>,
    /// When set, these discrete levels take precedence over zoom..=zoomMax.
    #[serde(default)]
    pub zoom_levels: Option<Vec<u8>>,
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    #[serde(default)]
    pub allow_missing: bool,
    #[serde(default = "default_compression")]
    pub compression: String,
    #[serde(default)]
    pub generate_sidecars: bool,
    #[serde(default)]
    pub subdomains: Vec<String>,
    #[serde(default)]
    pub overlays: Vec<OverlayRequest>,
    /// Same WGS84 polygon shape used by the desktop download request.
    #[serde(default)]
    pub crop_to_shape: bool,
    #[serde(default)]
    pub polygon: Option<Vec<Vec<PolygonCoord>>>,
    #[serde(default)]
    pub build_pyramid: bool,
    /// Mask the raster by the union of polygons in this normalized vector layer.
    pub clip_to_layer: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayRequest {
    pub url: String,
    pub source: String,
    pub attribution: String,
    #[serde(default)]
    pub subdomains: Vec<String>,
    #[serde(default)]
    pub max_zoom: Option<u8>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PolygonCoord {
    pub lat: f64,
    pub lng: f64,
}
fn default_format() -> String {
    "geotiff".into()
}
fn default_compression() -> String {
    "lzw".into()
}
fn default_concurrency() -> usize {
    4
}
fn default_tile_size() -> u32 {
    256
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    #[serde(default = "default_tiles")]
    pub max_tiles: u32,
    #[serde(default = "default_pixels")]
    pub max_pixels: u64,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}
fn default_tiles() -> u32 {
    256
}
fn default_pixels() -> u64 {
    16_777_216
}
fn default_timeout() -> u64 {
    180
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_tiles: default_tiles(),
            max_pixels: default_pixels(),
            timeout_seconds: default_timeout(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub id: String,
    pub kind: String,
    pub role: String,
    pub path: String,
    pub mime_type: String,
    pub bytes: u64,
    pub sha256: String,
    pub crs: String,
    /// Geographic footprint, even when the raster's pixel grid is Mercator.
    pub bounds: [f64; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_count: Option<usize>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quality {
    pub status: String,
    pub missing_tiles: u32,
    pub warnings: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provenance {
    pub source: String,
    pub attribution: String,
    pub retrieved_at: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: String,
    pub kind: String,
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub bounds: [f64; 4],
    pub assets: Vec<Asset>,
    pub layers: Vec<vector::LayerProfile>,
    pub quality: Quality,
    pub provenance: Vec<Provenance>,
}

pub fn read_request(path: &Path) -> Result<Request, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("Request exceeds 1 MiB".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).map_err(|e| format!("Invalid request: {e}"))
}

pub fn validate_bounds(b: [f64; 4]) -> Result<(), String> {
    if b.iter().any(|v| !v.is_finite())
        || b[0] < -180.0
        || b[2] > 180.0
        || b[1] < -85.05112878
        || b[3] > 85.05112878
        || b[0] >= b[2]
        || b[1] >= b[3]
    {
        return Err("bounds must be finite WGS84 [west,south,east,north], ordered and inside Web Mercator limits; antimeridian regions must be split".into());
    }
    Ok(())
}
pub(crate) fn tile_bounds(b: [f64; 4]) -> tile::Bounds {
    tile::Bounds {
        west: b[0],
        south: b[1],
        east: b[2],
        north: b[3],
    }
}
pub(crate) fn footprint(b: &tile::TileBounds) -> [f64; 4] {
    [b.west, b.south, b.east, b.north]
}

pub(crate) fn selected_zooms(i: &ImageryRequest) -> Result<Vec<u8>, String> {
    if let Some(levels) = &i.zoom_levels {
        if levels.is_empty() || levels.len() > 23 || levels.iter().any(|&z| z > 22) {
            return Err("imagery.zoomLevels must contain 1..23 levels in 0..22".into());
        }
        let mut sorted = levels.clone();
        sorted.sort_unstable();
        sorted.dedup();
        if sorted.len() != levels.len() {
            return Err("imagery.zoomLevels must not contain duplicate levels".into());
        }
        return Ok(sorted);
    }
    if i.zoom > 22 || i.zoom_max.is_some_and(|z| z > 22 || z < i.zoom) {
        return Err("imagery.zoom and zoomMax must be ordered levels in 0..22".into());
    }
    Ok((i.zoom..=i.zoom_max.unwrap_or(i.zoom)).collect())
}

pub fn validate_tile_source(
    url: &str,
    source: &str,
    attribution: &str,
    subdomains: &[String],
) -> Result<(), String> {
    if source.trim().is_empty() || attribution.trim().is_empty() {
        return Err("Each imagery source and attribution are required".into());
    }
    if !(url.contains("{q}")
        || (url.contains("{z}")
            && url.contains("{x}")
            && (url.contains("{y}") || url.contains("{-y}"))))
    {
        return Err("Tile URL must contain {z}, {x}, and {y}/{-y}, or {q} QuadKey".into());
    }
    if subdomains.len() > 8
        || subdomains.iter().any(|s| {
            s.is_empty()
                || s.len() > 16
                || !s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
        || (url.contains("{s}") && subdomains.is_empty())
    {
        return Err("Tile URL {s} requires 1..8 alphanumeric subdomains".into());
    }
    let sample = url
        .replace("{s}", subdomains.first().map_or("a", String::as_str))
        .replace("{z}", "0")
        .replace("{x}", "0")
        .replace("{y}", "0")
        .replace("{-y}", "0")
        .replace("{q}", "0");
    let parsed = reqwest::Url::parse(&sample).map_err(|_| "Invalid tile URL")?;
    if !["http", "https"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Tile URL must be HTTP(S) without embedded user credentials".into());
    }
    crate::tile_policy::ensure_offline_allowed(&sample)?;
    Ok(())
}

#[derive(Clone, Copy)]
enum JobProfile {
    Hosted,
    Local,
}

pub fn plan(request: &Request) -> Result<serde_json::Value, String> {
    plan_with_profile(request, JobProfile::Hosted)
}

pub fn plan_local(request: &Request) -> Result<serde_json::Value, String> {
    plan_with_profile(request, JobProfile::Local)
}

fn plan_with_profile(request: &Request, profile: JobProfile) -> Result<serde_json::Value, String> {
    validate_bounds(request.bounds)?;
    if request.schema_version != "1.0" {
        return Err("Unsupported request schemaVersion (expected 1.0)".into());
    }
    if request.name.trim().is_empty() || request.name.len() > 240 {
        return Err("name must contain 1..240 bytes".into());
    }
    if request.imagery.is_none() && request.vector.is_none() {
        return Err("Specify imagery and/or vector".into());
    }
    let limits = &request.limits;
    let (tile_ceiling, pixel_ceiling, time_ceiling) = match profile {
        JobProfile::Hosted => (4_096, 67_108_864, 1_800),
        JobProfile::Local => (16_384, 1_073_741_824, 43_200),
    };
    if !(1..=tile_ceiling).contains(&limits.max_tiles)
        || !(1..=pixel_ceiling).contains(&limits.max_pixels)
        || !(1..=time_ceiling).contains(&limits.timeout_seconds)
    {
        return Err(format!("limits exceed supported bounds: maxTiles 1..{tile_ceiling}, maxPixels 1..{pixel_ceiling}, timeoutSeconds 1..{time_ceiling}"));
    }
    let mut imagery = serde_json::Value::Null;
    if let Some(i) = &request.imagery {
        let zooms = selected_zooms(i)?;
        if ![256, 512].contains(&i.tile_size) {
            return Err("imagery.tileSize must be 256 or 512".into());
        }
        if i.tile_size == 512 && matches!(i.format.as_str(), "mbtiles" | "gpkg") {
            return Err("512px tiles are not yet supported in MBTiles or GeoPackage exports; choose PNG, JPEG, GeoTIFF, or raw tiles".into());
        }
        if !(1..=32).contains(&i.concurrency) {
            return Err("imagery.concurrency must be 1..32".into());
        }
        if !["png", "jpeg", "geotiff", "tiles", "mbtiles", "gpkg"].contains(&i.format.as_str()) {
            return Err(
                "imagery.format must be png, jpeg, geotiff, tiles, mbtiles, or gpkg".into(),
            );
        }
        if !["none", "lzw", "deflate"].contains(&i.compression.as_str()) {
            return Err("imagery.compression must be none, lzw, or deflate".into());
        }
        if i.generate_sidecars && i.format != "geotiff" {
            return Err("imagery.generateSidecars requires geotiff".into());
        }
        if i.build_pyramid && i.format != "geotiff" {
            return Err("imagery.buildPyramid requires geotiff".into());
        }
        if i.build_pyramid && (i.crop_to_shape || i.clip_to_layer.is_some()) {
            return Err("imagery.buildPyramid currently requires an unclipped GeoTIFF".into());
        }
        if i.crop_to_shape && i.clip_to_layer.is_some() {
            return Err("CLIP_INVALID: choose either cropToShape/polygon or clipToLayer".into());
        }
        if i.crop_to_shape {
            if i.format == "jpeg" {
                return Err(
                    "CLIP_INVALID: JPEG cannot preserve transparent clipping; use png or geotiff"
                        .into(),
                );
            }
            if !["png", "geotiff"].contains(&i.format.as_str()) {
                return Err("CLIP_INVALID: polygon clipping requires png or geotiff".into());
            }
            let polygons = i
                .polygon
                .as_ref()
                .ok_or("CLIP_INVALID: cropToShape requires polygon")?;
            if polygons.is_empty()
                || polygons.len() > 100
                || polygons.iter().any(|ring| {
                    ring.len() < 3
                        || ring.len() > 10_000
                        || ring.iter().any(|p| {
                            !p.lat.is_finite()
                                || !p.lng.is_finite()
                                || p.lat.abs() > 85.05112878
                                || p.lng.abs() > 180.0
                        })
                })
            {
                return Err("CLIP_INVALID: polygon must contain 1..100 rings of 3..10000 valid WGS84 points".into());
            }
        } else if i.polygon.is_some() {
            return Err("CLIP_INVALID: polygon requires cropToShape=true".into());
        }
        if i.overlays.len() > 4 {
            return Err("imagery.overlays supports at most four sources".into());
        }
        validate_tile_source(&i.url, &i.source, &i.attribution, &i.subdomains)?;
        for overlay in &i.overlays {
            validate_tile_source(
                &overlay.url,
                &overlay.source,
                &overlay.attribution,
                &overlay.subdomains,
            )?;
            if overlay.max_zoom.is_some_and(|z| z > 22) {
                return Err("imagery.overlays.maxZoom must be 0..22".into());
            }
        }
        if let Some(layer) = &i.clip_to_layer {
            if layer.trim().is_empty() || layer.len() > 120 || request.vector.is_none() {
                return Err("CLIP_INVALID: imagery.clipToLayer requires a nonempty vector layer ID and a vector request".into());
            }
            if i.format == "jpeg" {
                return Err(
                    "CLIP_INVALID: JPEG cannot preserve transparent clipping; use png or geotiff"
                        .into(),
                );
            }
            if !["png", "geotiff"].contains(&i.format.as_str()) {
                return Err("CLIP_INVALID: polygon clipping requires png or geotiff".into());
            }
        }
        let mut total_tiles = 0u64;
        let mut total_pixels = 0u64;
        let mut level_plans = Vec::new();
        for &zoom in &zooms {
            let (x0, y0, x1, y1, cols, rows) =
                tile::get_tile_matrix_size(&tile_bounds(request.bounds), zoom);
            let count = u64::from(cols) * u64::from(rows);
            let pixels = count * u64::from(i.tile_size) * u64::from(i.tile_size);
            if (i.tile_size == 512 || i.format == "jpeg" || i.crop_to_shape || i.clip_to_layer.is_some())
                && pixels > 67_108_864
            {
                return Err("RESOURCE_LIMIT: 512px, JPEG and clipped rasters are limited to 67108864 pixels per zoom; reduce zoom or split the region".into());
            }
            total_tiles += count;
            total_pixels += pixels;
            level_plans.push(serde_json::json!({"zoom":zoom,"tileCount":count,"width":cols*i.tile_size,"height":rows*i.tile_size,
                "pixels":pixels,"actualBounds":footprint(&tile::get_merged_bounds(x0,y0,x1,y1,zoom))}));
        }
        if total_tiles > u64::from(limits.max_tiles) || total_pixels > limits.max_pixels {
            return Err(format!("RESOURCE_LIMIT: {total_tiles} tiles / {total_pixels} pixels exceed limits; reduce zoom, split region, or explicitly raise bounded limits"));
        }
        let last = level_plans.last().expect("zoom list is nonempty");
        imagery = serde_json::json!({"tileCount":total_tiles,"width":last["width"],"height":last["height"],"pixels":total_pixels,
            "estimatedRgbBytes":total_pixels*3,"actualBounds":last["actualBounds"],"crs":"EPSG:3857","zoom":last["zoom"],
            "zoomLevels":zooms,"levels":level_plans,"tileSize":i.tile_size,"format":i.format,"overlayCount":i.overlays.len(),
            "clip":if i.crop_to_shape { Some(serde_json::json!({"mode":"drawn-polygon-alpha","outside":"transparent"})) }
                else {i.clip_to_layer.as_ref().map(|layer|serde_json::json!({"layer":layer,"mode":"polygon-union-alpha","outside":"transparent","vectorGeometriesUnchanged":true}))}});
    }
    if let Some(v) = &request.vector {
        vector::validate_request(v, request.bounds)?;
        if v.input.is_none() && v.url.is_none() {
            let b = request.bounds;
            let area = (b[2] - b[0])
                * 111.32
                * ((b[1] + b[3]) * 0.5).to_radians().cos()
                * (b[3] - b[1])
                * 111.32;
            if area > 400.0 {
                return Err("RESOURCE_LIMIT: online Overpass extraction is limited to 400 km² per job; supply prepared GeoJSON for province maps or split scenic-area jobs".into());
            }
        }
    }
    Ok(
        serde_json::json!({"ok":true,"schemaVersion":"1.0","name":request.name,"bounds":request.bounds,
        "imagery":imagery,"vector":request.vector.as_ref().map(|v|serde_json::json!({"mode":if v.input.is_some(){"local"}else if v.url.is_some(){"geojson-url"}else{"overpass"},"layers":v.layers})),
        "notes":["Raster output is aligned to the tile grid; asset.bounds records its actual footprint.","Vector extraction selects intersecting features; exact polygon clipping is not part of v1."]}),
    )
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub(crate) fn asset(
    dir: &Path,
    id: &str,
    file: &str,
    kind: &str,
    role: &str,
    mime: &str,
    crs: &str,
    bounds: [f64; 4],
) -> Result<Asset, String> {
    let path = dir.join(file);
    Ok(Asset {
        id: id.into(),
        kind: kind.into(),
        role: role.into(),
        path: file.into(),
        mime_type: mime.into(),
        bytes: fs::metadata(&path).map_err(|e| e.to_string())?.len(),
        sha256: sha256_file(&path)?,
        crs: crs.into(),
        bounds,
        width: None,
        height: None,
        feature_count: None,
    })
}

fn geojson_bounds(data: &serde_json::Value, fallback: [f64; 4]) -> [f64; 4] {
    fn visit(value: &serde_json::Value, b: &mut [f64; 4]) {
        if let Some(values) = value.as_array() {
            if values.len() >= 2 && values[0].is_number() && values[1].is_number() {
                let x = values[0].as_f64().unwrap();
                let y = values[1].as_f64().unwrap();
                b[0] = b[0].min(x);
                b[1] = b[1].min(y);
                b[2] = b[2].max(x);
                b[3] = b[3].max(y);
            } else {
                for child in values {
                    visit(child, b);
                }
            }
        }
    }
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    if let Some(features) = data["features"].as_array() {
        for f in features {
            visit(&f["geometry"]["coordinates"], &mut bounds);
        }
    }
    if bounds.iter().all(|v| v.is_finite()) {
        bounds
    } else {
        fallback
    }
}

pub async fn fetch(
    request: Request,
    base_dir: &Path,
    destination: &Path,
) -> Result<Manifest, String> {
    fetch_with_work_dir(request, base_dir, destination, None).await
}

/// A persistent work directory lets the downloader reuse validated tiles after interruption.
/// It is bound to the exact request so source or bounds changes cannot silently reuse old data.
pub async fn fetch_with_work_dir(
    request: Request,
    base_dir: &Path,
    destination: &Path,
    work_dir: Option<&Path>,
) -> Result<Manifest, String> {
    fetch_with_profile(request, base_dir, destination, work_dir, JobProfile::Hosted).await
}

pub async fn fetch_local_with_work_dir(
    request: Request,
    base_dir: &Path,
    destination: &Path,
    work_dir: Option<&Path>,
) -> Result<Manifest, String> {
    fetch_with_profile(request, base_dir, destination, work_dir, JobProfile::Local).await
}

async fn fetch_with_profile(
    request: Request,
    base_dir: &Path,
    destination: &Path,
    work_dir: Option<&Path>,
    profile: JobProfile,
) -> Result<Manifest, String> {
    plan_with_profile(&request, profile)?;
    if destination.exists() {
        return Err("OUTPUT_EXISTS: choose a new output directory; existing artifacts are never overwritten".into());
    }
    let destination = if destination.is_absolute() {
        destination.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(destination)
    };
    let parent = destination
        .parent()
        .ok_or("Output must have a parent directory")?;
    let work_dir = if let Some(path) = work_dir {
        if request.imagery.is_none() {
            return Err("--work-dir requires an imagery request".into());
        }
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join(path)
        };
        if path.starts_with(&destination) || destination.starts_with(&path) {
            return Err("Work directory and output directory must be separate".into());
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&request).map_err(|e| e.to_string())?)
        );
        if path.exists() {
            let marker = fs::read_to_string(path.join(".geod-request.sha256")).map_err(|_| {
                "WORK_DIR_MISMATCH: existing work directory has no GeoD request marker"
            })?;
            if marker.trim() != digest {
                return Err("WORK_DIR_MISMATCH: this directory belongs to another request".into());
            }
        } else {
            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            fs::write(path.join(".geod-request.sha256"), &digest).map_err(|e| e.to_string())?;
        }
        Some(path)
    } else {
        None
    };
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stage = tempfile::Builder::new()
        .prefix(".geod-stage-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    let timeout = Duration::from_secs(request.limits.timeout_seconds);
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(
        timeout,
        execute(&request, base_dir, stage.path(), work_dir.as_deref()),
    )
    .await
    .map_err(|_| {
        "TIMEOUT: job deadline exceeded; no completed bundle was published".to_string()
    })??;
    // Synchronous bounded encoders may not yield to Tokio's timer. Still refuse
    // to publish their result when the overall job deadline has elapsed.
    if started.elapsed() >= timeout {
        return Err("TIMEOUT: job deadline exceeded during export; no bundle published".into());
    }
    fs::write(
        stage.path().join("manifest.json"),
        serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // create_dir is the portable no-replace operation. A competing job or user
    // directory always wins; never rename a directory over an existing one.
    fs::create_dir(&destination)
        .map_err(|e| format!("OUTPUT_EXISTS_OR_UNAVAILABLE: could not reserve destination: {e}"))?;
    for a in &result.assets {
        let target = destination.join(&a.path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::rename(stage.path().join(&a.path), target)
            .map_err(|e| format!("Publication incomplete (manifest absent): {e}"))?;
    }
    // Readers only accept a bundle after this final completion marker exists.
    fs::rename(
        stage.path().join("manifest.json"),
        destination.join("manifest.json"),
    )
    .map_err(|e| format!("Could not publish manifest: {e}"))?;
    Ok(result)
}

async fn execute(
    request: &Request,
    base_dir: &Path,
    stage: &Path,
    tile_work_dir: Option<&Path>,
) -> Result<Manifest, String> {
    let created_at = chrono::Utc::now().to_rfc3339();
    let mut m = Manifest {
        schema_version: "1.0".into(),
        kind: "geod-bundle".into(),
        id: format!("geod-{}", uuid::Uuid::new_v4()),
        name: request.name.clone(),
        created_at: created_at.clone(),
        bounds: request.bounds,
        assets: vec![],
        layers: vec![],
        quality: Quality {
            status: "complete".into(),
            missing_tiles: 0,
            warnings: vec![],
        },
        provenance: vec![],
    };
    if let Some(v) = &request.vector {
        eprintln!("{{\"phase\":\"vector\"}}");
        let client = reqwest::Client::builder()
            .user_agent("GeoD-CLI/0.1 (+https://github.com/gaopengbin/geo-downloader)")
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(request.limits.timeout_seconds))
            .redirect(if std::env::var_os("GEOD_PUBLIC_MCP").is_some() {
                reqwest::redirect::Policy::none()
            } else {
                reqwest::redirect::Policy::default()
            })
            .build()
            .map_err(|e| e.to_string())?;
        let result = vector::acquire(v, request.bounds, base_dir, &client).await?;
        let count = result
            .geojson
            .get("features")
            .and_then(|f| f.as_array())
            .map_or(0, Vec::len);
        fs::write(
            stage.join("data.geojson"),
            serde_json::to_vec(&result.geojson).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let mut a = asset(
            stage,
            "vectors",
            "data.geojson",
            "vector",
            "data",
            "application/geo+json",
            "EPSG:4326",
            geojson_bounds(&result.geojson, request.bounds),
        )?;
        a.feature_count = Some(count);
        m.assets.push(a);
        m.layers = result.layers;
        if result.partial {
            m.quality.status = "partial".into();
        }
        m.quality.warnings.extend(result.warnings);
        m.provenance.push(Provenance {
            source: result.source,
            attribution: result.attribution,
            retrieved_at: created_at.clone(),
        });
    }
    if let Some(i) = &request.imagery {
        if let Some(layer) = &i.clip_to_layer {
            if !m.layers.iter().any(|profile| {
                &profile.id == layer && ["polygon", "mixed"].contains(&profile.geometry.as_str())
            }) {
                return Err(format!(
                    "CLIP_INVALID: no polygon data in vector layer '{layer}'"
                ));
            }
        }
        crate::imagery_job::execute(request, i, stage, &mut m, tile_work_dir).await?;
    }
    Ok(m)
}

pub fn resolve_asset(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.contains(['\\', ':'])
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Unsafe asset path".into());
    }
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let resolved = fs::canonicalize(root.join(relative)).map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) || !resolved.is_file() {
        return Err("Asset escapes the bundle directory or is not a file".into());
    }
    Ok(resolved)
}
pub fn inspect(path: &Path) -> Result<Manifest, String> {
    let path = if path.is_dir() {
        path.join("manifest.json")
    } else {
        path.to_path_buf()
    };
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
        return Err("Manifest exceeds 32 MiB".into());
    }
    let manifest: Manifest = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Invalid manifest: {e}"))?;
    if manifest.schema_version != "1.0"
        || manifest.kind != "geod-bundle"
        || manifest.assets.is_empty()
    {
        return Err("Unsupported or empty GeoD bundle".into());
    }
    validate_bounds(manifest.bounds)?;
    let root = path.parent().ok_or("Manifest has no parent")?;
    let mut paths = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    for a in &manifest.assets {
        if !paths.insert(&a.path) || !ids.insert(&a.id) {
            return Err("Duplicate asset path or ID".into());
        }
        let file = resolve_asset(root, &a.path)?;
        if fs::metadata(&file).map_err(|e| e.to_string())?.len() != a.bytes
            || sha256_file(&file)? != a.sha256
        {
            return Err(format!("ASSET_MISMATCH: {}", a.path));
        }
    }
    Ok(manifest)
}

pub async fn import_geostyle(
    bundle: &Path,
    url: &str,
    token: Option<&str>,
    style: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let m = inspect(bundle)?;
    let root = if bundle.is_dir() {
        bundle
    } else {
        bundle.parent().ok_or("Missing bundle directory")?
    };
    let mut files = vec![];
    let total: u64 = m.assets.iter().map(|a| a.bytes).sum();
    if total > 68 * 1024 * 1024 {
        return Err("GeoStyle JSON upload supports at most 68 MiB of asset bytes; reduce data or imagery resolution".into());
    }
    for a in &m.assets {
        let bytes = fs::read(resolve_asset(root, &a.path)?).map_err(|e| e.to_string())?;
        files.push(serde_json::json!({"path":a.path,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}));
    }
    let endpoint = format!("{}/api/geodata/geod-bundles", url.trim_end_matches('/'));
    let endpoint = reqwest::Url::parse(&endpoint).map_err(|_| "Invalid GeoStyle URL")?;
    if !["http", "https"].contains(&endpoint.scheme())
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err("GeoStyle URL must be HTTP(S) without embedded credentials".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut payload = serde_json::json!({"manifest":m,"files":files});
    if let Some(style) = style {
        payload["openStyle"] = style;
    }
    let mut call = client.post(endpoint).json(&payload);
    if let Some(token) = token {
        call = call.bearer_auth(token);
    }
    let response = call.send().await.map_err(|e| e.without_url().to_string())?;
    let status = response.status();
    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if !status.is_success() {
        return Err(format!("GeoStyle HTTP {}: {}", status.as_u16(), result));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn req() -> Request {
        serde_json::from_value(serde_json::json!({"schemaVersion":"1.0","name":"test","bounds":[116.38,39.9,116.4,39.92],"imagery":{"url":"http://localhost/{z}/{x}/{y}.png","source":"fixture","attribution":"fixture","zoom":10}})).unwrap()
    }
    #[test]
    fn rejects_resources_before_tile_allocation() {
        let mut r = req();
        r.imagery.as_mut().unwrap().zoom = 22;
        assert!(plan(&r).unwrap_err().contains("RESOURCE_LIMIT"));
    }
    #[test]
    fn rejects_coordinate_order_and_unknown_format() {
        let mut r = req();
        r.bounds = [116., 40., 115., 39.];
        assert!(plan(&r).is_err());
        r = req();
        r.imagery.as_mut().unwrap().format = "pnng".into();
        assert!(plan(&r).is_err());
    }
    #[test]
    fn prevents_path_escape_and_absolute_paths() {
        let d = tempfile::tempdir().unwrap();
        assert!(resolve_asset(d.path(), "../other").is_err());
        assert!(resolve_asset(d.path(), "C:/other").is_err());
        assert!(resolve_asset(d.path(), "a\\b").is_err());
    }
    #[test]
    fn blocks_osm_standard_bulk_download() {
        let mut r = req();
        r.imagery.as_mut().unwrap().url = "https://tile.openstreetmap.org/{z}/{x}/{y}.png".into();
        assert!(plan(&r).is_err());
    }
    #[test]
    fn request_rejects_typos() {
        assert!(serde_json::from_str::<Request>(
            r#"{"schemaVersion":"1.0","name":"test","bounds":[1,2,3,4],"zoomz":2}"#
        )
        .is_err());
    }
}
