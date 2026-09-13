//! Strict, bounded headless jobs and the versioned GeoStyle artifact contract.
use crate::{
    config::TileSource, downloader::TileDownloader, exporter, merger, tile, tile_cache, vector,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageryRequest {
    pub url: String,
    pub source: String,
    pub attribution: String,
    pub zoom: u8,
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    #[serde(default)]
    pub allow_missing: bool,
    /// Mask the raster by the union of polygons in this normalized vector layer.
    pub clip_to_layer: Option<String>,
}
fn default_format() -> String {
    "geotiff".into()
}
fn default_concurrency() -> usize {
    4
}

#[derive(Debug, Deserialize)]
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
fn tile_bounds(b: [f64; 4]) -> tile::Bounds {
    tile::Bounds {
        west: b[0],
        south: b[1],
        east: b[2],
        north: b[3],
    }
}
fn footprint(b: &tile::TileBounds) -> [f64; 4] {
    [b.west, b.south, b.east, b.north]
}

pub fn plan(request: &Request) -> Result<serde_json::Value, String> {
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
    if !(1..=4096).contains(&limits.max_tiles)
        || !(1..=67_108_864).contains(&limits.max_pixels)
        || !(1..=1800).contains(&limits.timeout_seconds)
    {
        return Err("limits exceed supported bounds: maxTiles 1..4096, maxPixels 1..67108864, timeoutSeconds 1..1800".into());
    }
    let mut imagery = serde_json::Value::Null;
    if let Some(i) = &request.imagery {
        if i.zoom > 22 || !(1..=32).contains(&i.concurrency) {
            return Err("imagery.zoom must be 0..22 and concurrency 1..32".into());
        }
        if !["png", "jpeg", "geotiff"].contains(&i.format.as_str()) {
            return Err("imagery.format must be png, jpeg, or geotiff".into());
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
        }
        if i.source.trim().is_empty() || i.attribution.trim().is_empty() {
            return Err("imagery.source and attribution are required".into());
        }
        if !["{x}", "{y}", "{z}"].iter().all(|key| i.url.contains(key)) {
            return Err("imagery.url must contain {z}, {x}, and {y}".into());
        }
        let url = reqwest::Url::parse(&i.url).map_err(|_| "Invalid imagery URL")?;
        if !["http", "https"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("imagery.url must be HTTP(S) without embedded user credentials".into());
        }
        if url.host_str().is_some_and(|host| {
            host == "tile.openstreetmap.org" || host.ends_with(".tile.openstreetmap.org")
        }) {
            return Err("OSM standard tile servers are for interactive use; configure an XYZ service allowing downloads".into());
        }
        let (x0, y0, x1, y1, cols, rows) =
            tile::get_tile_matrix_size(&tile_bounds(request.bounds), i.zoom);
        let count = u64::from(cols) * u64::from(rows);
        let pixels = count * 256 * 256;
        if count > u64::from(limits.max_tiles) || pixels > limits.max_pixels {
            return Err(format!("RESOURCE_LIMIT: {count} tiles / {pixels} pixels exceed limits; reduce zoom, split region, or explicitly raise bounded limits"));
        }
        imagery = serde_json::json!({"tileCount":count,"width":cols*256,"height":rows*256,"pixels":pixels,
            "estimatedRgbBytes":pixels*3,"actualBounds":footprint(&tile::get_merged_bounds(x0,y0,x1,y1,i.zoom)),"crs":"EPSG:3857","zoom":i.zoom,
            "clip":i.clip_to_layer.as_ref().map(|layer|serde_json::json!({"layer":layer,"mode":"polygon-union-alpha","outside":"transparent","vectorGeometriesUnchanged":true}))});
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
fn asset(
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
    plan(&request)?;
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
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stage = tempfile::Builder::new()
        .prefix(".geod-stage-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    let timeout = Duration::from_secs(request.limits.timeout_seconds);
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(timeout, execute(&request, base_dir, stage.path()))
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
        fs::rename(stage.path().join(&a.path), destination.join(&a.path))
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

async fn execute(request: &Request, base_dir: &Path, stage: &Path) -> Result<Manifest, String> {
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
        tile_cache::set_enabled(false);
        let temp = tempfile::Builder::new()
            .prefix(".geod-tiles-")
            .tempdir_in(stage)
            .map_err(|e| e.to_string())?;
        let source = TileSource {
            id: "geod-cli-xyz".into(),
            name: i.source.clone(),
            url: i.url.clone(),
            subdomains: vec![],
            max_zoom: 22,
            attribution: i.attribution.clone(),
        };
        let downloader = TileDownloader::new(source, None)?;
        let b = tile_bounds(request.bounds);
        let tiles = tile::get_tiles_in_bounds(&b, i.zoom);
        let expected = tiles.len() as u32;
        let mut last_report = 0;
        let files=downloader.download_tiles(tiles,i.concurrency,temp.path(),None,None,|p|{
            if p.completed != last_report { eprintln!("{}",serde_json::json!({"phase":"download","completed":p.completed,"total":p.total,"failed":p.failed,"noData":p.no_data})); last_report=p.completed; }
        }).await?;
        let mut valid = std::collections::HashMap::new();
        for (key, source) in files {
            let bytes = source.bytes().map_err(|e| e.to_string())?;
            // Bound decompression before allocating decoded data.
            let reader = image::ImageReader::new(std::io::Cursor::new(bytes.as_ref()))
                .with_guessed_format()
                .map_err(|e| e.to_string())?;
            match reader.into_dimensions() {
                Ok((256, 256)) if image::load_from_memory(bytes.as_ref()).is_ok() => {
                    drop(bytes);
                    valid.insert(key, source);
                }
                _ => {
                    m.quality.warnings.push(format!(
                        "Invalid or non-256px tile omitted: {}/{}",
                        key.0, key.1
                    ));
                }
            }
        }
        let missing = expected.saturating_sub(valid.len() as u32);
        if valid.is_empty() {
            return Err("NO_DATA: no valid imagery tiles received".into());
        }
        if missing > 0 && !i.allow_missing {
            return Err(format!("MISSING_TILES: {missing}/{expected} unavailable or invalid; no bundle published. Set imagery.allowMissing explicitly to accept gaps"));
        }
        m.quality.missing_tiles = missing;
        if missing > 0 {
            m.quality.status = "partial".into();
            m.quality
                .warnings
                .push(format!("{missing} missing tiles are white in the mosaic"));
        }
        let (x0, y0, x1, y1, _, _) = tile::get_tile_matrix_size(&b, i.zoom);
        let actual = tile::get_merged_bounds(x0, y0, x1, y1, i.zoom);
        eprintln!("{{\"phase\":\"export\"}}");
        let image = merger::merge_tiles(&valid, x0, y0, x1, y1);
        let (width, height) = image.dimensions();
        let (format, file, mime) = match i.format.as_str() {
            "png" => (exporter::ExportFormat::Png, "imagery.png", "image/png"),
            "jpeg" => (exporter::ExportFormat::Jpeg, "imagery.jpg", "image/jpeg"),
            _ => (exporter::ExportFormat::GeoTiff, "imagery.tif", "image/tiff"),
        };
        let (pw, ph) = if let Some(layer) = &i.clip_to_layer {
            eprintln!("{{\"phase\":\"clip\"}}");
            let vectors: serde_json::Value = serde_json::from_slice(
                &fs::read(stage.join("data.geojson")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let clipped = crate::clip::clip_raster(image, &vectors, layer, &actual)?;
            let preview = image::DynamicImage::ImageRgba8(clipped.clone())
                .resize(
                    width.min(2048),
                    height.min(2048),
                    image::imageops::FilterType::Triangle,
                )
                .to_rgba8();
            let size = preview.dimensions();
            exporter::export_rgba_image_to_file(
                preview,
                exporter::ExportFormat::Png,
                &stage.join("imagery-preview.png"),
                Some(&actual),
                "lzw",
            )?;
            exporter::export_rgba_image_to_file(
                clipped,
                format,
                &stage.join(file),
                Some(&actual),
                "lzw",
            )?;
            m.quality.warnings.push(format!("Raster clipped to polygon union in layer '{layer}'; outside pixels are transparent. Vector geometries are unchanged."));
            size
        } else {
            let preview = image::DynamicImage::ImageRgb8(image.clone())
                .resize(
                    width.min(2048),
                    height.min(2048),
                    image::imageops::FilterType::Triangle,
                )
                .to_rgb8();
            let size = preview.dimensions();
            exporter::export_image_to_file(
                preview,
                exporter::ExportFormat::Png,
                &stage.join("imagery-preview.png"),
                Some(&actual),
                "lzw",
            )?;
            exporter::export_image_to_file(image, format, &stage.join(file), Some(&actual), "lzw")?;
            size
        };
        let mut a = asset(
            stage,
            "imagery-preview",
            "imagery-preview.png",
            "raster",
            "preview",
            "image/png",
            "EPSG:3857",
            footprint(&actual),
        )?;
        a.width = Some(pw);
        a.height = Some(ph);
        m.assets.push(a);
        let mut a = asset(
            stage,
            "imagery",
            file,
            "raster",
            "analysis",
            mime,
            "EPSG:3857",
            footprint(&actual),
        )?;
        a.width = Some(width);
        a.height = Some(height);
        m.assets.push(a);
        m.provenance.push(Provenance {
            source: i.source.clone(),
            attribution: i.attribution.clone(),
            retrieved_at: created_at.clone(),
        });
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
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("Manifest exceeds 1 MiB".into());
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
