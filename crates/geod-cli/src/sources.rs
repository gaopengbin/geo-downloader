//! User-local imagery source catalogue for the standalone CLI.
use geod_core::{
    config, downloader::TileDownloader, pipeline, source_analyzer, tile::TileCoord, tile_payload,
    tile_policy,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CustomSource {
    id: String,
    name: String,
    url: String,
    attribution: String,
    #[serde(default)]
    subdomains: Vec<String>,
    max_zoom: u8,
    scheme: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceStore {
    schema_version: u8,
    default_source_id: Option<String>,
    custom_sources: Vec<CustomSource>,
}

impl SourceStore {
    fn empty() -> Self {
        Self {
            schema_version: 1,
            default_source_id: None,
            custom_sources: Vec::new(),
        }
    }
}

fn home() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("GEOD_CLI_HOME") {
        if value.is_empty() {
            return Err("GEOD_CLI_HOME is empty".into());
        }
        return Ok(PathBuf::from(value));
    }
    if let Some(value) = env::var_os("APPDATA") {
        return Ok(PathBuf::from(value).join("GeoD CLI"));
    }
    env::var_os("HOME")
        .map(|value| PathBuf::from(value).join(".geod-cli"))
        .ok_or("Cannot find user configuration directory".into())
}

fn store_path() -> Result<PathBuf, String> {
    Ok(home()?.join("sources.json"))
}

fn read_store(path: &Path) -> Result<SourceStore, String> {
    if !path.exists() {
        return Ok(SourceStore::empty());
    }
    let meta = fs::metadata(path).map_err(|e| format!("Cannot read source registry: {e}"))?;
    if meta.len() > 1024 * 1024 {
        return Err("Source registry exceeds 1 MiB".into());
    }
    let store: SourceStore = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Invalid source registry: {e}"))?;
    if store.schema_version != 1 {
        return Err("Unsupported source registry version".into());
    }
    let mut ids = HashSet::new();
    for source in &store.custom_sources {
        validate_custom(source)?;
        if !ids.insert(source.id.as_str()) {
            return Err(format!("Duplicate source ID: {}", source.id));
        }
    }
    Ok(store)
}

fn write_store(path: &Path, store: &SourceStore) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid source registry path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // Keep the previous complete file if serialisation fails.
    let data = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| format!("Cannot save source registry: {e}"))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn validate_custom(source: &CustomSource) -> Result<(), String> {
    if !valid_id(&source.id) {
        return Err("Source ID must be 1..64 ASCII letters, digits, - or _".into());
    }
    if source.name.trim().is_empty() || source.name.len() > 128 {
        return Err("Source name is required (up to 128 bytes)".into());
    }
    if source.max_zoom > 22 {
        return Err("maxZoom must be in 0..22".into());
    }
    if !["xyz", "tms"].contains(&source.scheme.as_str()) {
        return Err("scheme must be xyz or tms".into());
    }
    if source.scheme == "tms" && source.url.contains("{q}") {
        return Err("TMS scheme cannot be combined with QuadKey".into());
    }
    pipeline::validate_tile_source(
        &effective_url(source),
        &source.name,
        &source.attribution,
        &source.subdomains,
    )
}

fn effective_url(source: &CustomSource) -> String {
    if source.scheme == "tms" {
        source.url.replace("{y}", "{-y}")
    } else {
        source.url.clone()
    }
}

fn builtins() -> std::collections::HashMap<String, config::TileSource> {
    // Never use the desktop app's shared Tianditu token for a public CLI.
    let token = env::var("GEOD_TIANDITU_TOKEN").unwrap_or_else(|_| "TOKEN_REQUIRED".into());
    let mut sources: std::collections::HashMap<String, config::TileSource> =
        config::get_tile_sources(Some(&token))
            .into_iter()
            .filter(|(id, _)| !id.starts_with("mvt_") && !id.starts_with("dem_"))
            .collect();
    sources.insert("nasa_gibs_blue_marble".into(), config::TileSource {
        id: "nasa_gibs_blue_marble".into(),
        name: "NASA GIBS Blue Marble".into(),
        url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg".into(),
        subdomains: Vec::new(), max_zoom: 8, attribution: "NASA GIBS".into(),
    });
    sources
}

fn resolve(store: &SourceStore, id: &str) -> Result<config::TileSource, String> {
    let source = if let Some(custom) = store.custom_sources.iter().find(|s| s.id == id) {
        config::TileSource {
            id: custom.id.clone(),
            name: custom.name.clone(),
            url: effective_url(custom),
            subdomains: custom.subdomains.clone(),
            max_zoom: custom.max_zoom,
            attribution: custom.attribution.clone(),
        }
    } else {
        if id.starts_with("tianditu_") && env::var("GEOD_TIANDITU_TOKEN").is_err() {
            return Err(
                "Set GEOD_TIANDITU_TOKEN to your own Tianditu token before selecting this source"
                    .into(),
            );
        }
        builtins()
            .remove(id)
            .ok_or_else(|| format!("Unknown imagery source: {id}; run geod sources list"))?
    };
    tile_policy::ensure_offline_allowed(&source.url)?;
    pipeline::validate_tile_source(
        &source.url,
        &source.name,
        &source.attribution,
        &source.subdomains,
    )?;
    Ok(source)
}

fn source_view(source: &config::TileSource, kind: &str, default_id: Option<&str>) -> Value {
    let blocked = tile_policy::ensure_offline_allowed(&source.url).err();
    let token_missing =
        source.id.starts_with("tianditu_") && env::var("GEOD_TIANDITU_TOKEN").is_err();
    json!({
        "id":source.id,"name":source.name,"kind":kind,"attribution":source.attribution,
        "maxZoom":source.max_zoom,"default":default_id == Some(source.id.as_str()),
        "available":blocked.is_none() && !token_missing,
        "reason": if token_missing { Some("GEOD_TIANDITU_TOKEN is required".to_string()) } else { blocked },
    })
}

pub fn read_request(
    path: &Path,
    source_override: Option<&str>,
) -> Result<pipeline::Request, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > 1024 * 1024 {
        return Err("Request exceeds 1 MiB".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let mut value: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("Invalid request: {e}"))?;
    let store = read_store(&store_path()?)?;
    let Some(imagery) = value.get_mut("imagery").and_then(Value::as_object_mut) else {
        if source_override.is_some() {
            return Err("--source requires an imagery request".into());
        }
        return serde_json::from_value(value).map_err(|e| format!("Invalid request: {e}"));
    };
    let requested_id = imagery
        .remove("sourceId")
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or("imagery.sourceId must be a string")
        })
        .transpose()?;
    let id = source_override.or(requested_id.as_deref()).or_else(|| {
        if imagery.contains_key("url") {
            None
        } else {
            store.default_source_id.as_deref()
        }
    });
    let main_source = if let Some(id) = id {
        if source_override.is_none()
            && (imagery.contains_key("url")
                || imagery.contains_key("source")
                || imagery.contains_key("attribution"))
        {
            return Err("Use sourceId or url/source/attribution, not both".into());
        }
        let source = resolve(&store, id)?;
        imagery.insert("url".into(), json!(source.url));
        imagery.insert("source".into(), json!(source.id));
        imagery.insert("attribution".into(), json!(source.attribution));
        imagery.insert("subdomains".into(), json!(source.subdomains));
        Some(source)
    } else {
        None
    };
    let mut overlay_sources = Vec::new();
    if let Some(overlays) = imagery.get_mut("overlays").and_then(Value::as_array_mut) {
        for overlay in overlays {
            let object = overlay
                .as_object_mut()
                .ok_or("imagery.overlays entries must be objects")?;
            let Some(id) = object.remove("sourceId") else {
                continue;
            };
            let id = id.as_str().ok_or("overlay.sourceId must be a string")?;
            if object.contains_key("url")
                || object.contains_key("source")
                || object.contains_key("attribution")
            {
                return Err("Use overlay.sourceId or url/source/attribution, not both".into());
            }
            let source = resolve(&store, id)?;
            object.insert("url".into(), json!(source.url));
            object.insert("source".into(), json!(source.id));
            object.insert("attribution".into(), json!(source.attribution));
            object.insert("subdomains".into(), json!(source.subdomains));
            if object
                .get("maxZoom")
                .and_then(Value::as_u64)
                .is_none_or(|z| z > u64::from(source.max_zoom))
            {
                object.insert("maxZoom".into(), json!(source.max_zoom));
            }
            overlay_sources.push(source);
        }
    }
    let request: pipeline::Request =
        serde_json::from_value(value).map_err(|e| format!("Invalid request: {e}"))?;
    if let Some(imagery) = &request.imagery {
        let high = imagery
            .zoom_levels
            .as_ref()
            .and_then(|v| v.iter().copied().max())
            .or(imagery.zoom_max)
            .unwrap_or(imagery.zoom);
        if let Some(source) = main_source {
            if high > source.max_zoom {
                return Err(format!(
                    "Source {} supports up to zoom {}, requested {}",
                    source.id, source.max_zoom, high
                ));
            }
        }
        for source in overlay_sources {
            if imagery.zoom > source.max_zoom && imagery.zoom_levels.is_none() {
                return Err(format!(
                    "Overlay {} is unavailable at zoom {}",
                    source.id, imagery.zoom
                ));
            }
        }
    }
    Ok(request)
}

fn optional_u8(value: Option<&String>, name: &str, default: u8) -> Result<u8, String> {
    value
        .map(|v| {
            v.parse::<u8>()
                .map_err(|_| format!("{name} must be in 0..255"))
        })
        .unwrap_or(Ok(default))
}

pub async fn run(args: &[String]) -> Result<Value, String> {
    let action = args
        .first()
        .map(String::as_str)
        .ok_or("Use geod sources list|register|update|remove|default|show|analyze|probe")?;
    let path = store_path()?;
    let mut store = read_store(&path)?;
    match action {
        "list" => {
            crate::options(&args[1..], &[])?;
            let mut rows: Vec<Value> = builtins()
                .values()
                .map(|s| source_view(s, "builtIn", store.default_source_id.as_deref()))
                .collect();
            rows.extend(store.custom_sources.iter().map(|s| {
                let tile = config::TileSource {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    url: effective_url(s),
                    subdomains: s.subdomains.clone(),
                    max_zoom: s.max_zoom,
                    attribution: s.attribution.clone(),
                };
                source_view(&tile, "custom", store.default_source_id.as_deref())
            }));
            rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
            Ok(json!({"ok":true,"defaultSourceId":store.default_source_id,"sources":rows}))
        }
        "register" | "update" => {
            let options = crate::options(
                &args[1..],
                &[
                    "--id",
                    "--name",
                    "--url",
                    "--attribution",
                    "--max-zoom",
                    "--subdomains",
                    "--scheme",
                ],
            )?;
            let id = crate::required(&options, "--id")?.to_string();
            let source = CustomSource {
                id: id.clone(),
                name: crate::required(&options, "--name")?.to_string(),
                url: crate::required(&options, "--url")?.to_string(),
                attribution: crate::required(&options, "--attribution")?.to_string(),
                max_zoom: optional_u8(options.get("--max-zoom"), "--max-zoom", 18)?,
                subdomains: options
                    .get("--subdomains")
                    .map(|s| s.split(',').map(|v| v.trim().to_string()).collect())
                    .unwrap_or_default(),
                scheme: options
                    .get("--scheme")
                    .cloned()
                    .unwrap_or_else(|| "xyz".into()),
            };
            validate_custom(&source)?;
            if builtins().contains_key(&id) {
                return Err("Cannot replace a built-in source ID".into());
            }
            let existing = store.custom_sources.iter().position(|s| s.id == id);
            if action == "register" && existing.is_some() {
                return Err(format!("Source {id} already exists; use sources update"));
            }
            if action == "update" && existing.is_none() {
                return Err(format!("Source {id} does not exist; use sources register"));
            }
            if let Some(index) = existing {
                store.custom_sources[index] = source;
            } else {
                store.custom_sources.push(source);
            }
            write_store(&path, &store)?;
            Ok(json!({"ok":true,"id":id,"registry":path}))
        }
        "remove" => {
            let options = crate::options(&args[1..], &["--id"])?;
            let id = crate::required(&options, "--id")?;
            let before = store.custom_sources.len();
            store.custom_sources.retain(|s| s.id != id);
            if store.custom_sources.len() == before {
                return Err(format!("Custom source {id} not found"));
            }
            if store.default_source_id.as_deref() == Some(id) {
                store.default_source_id = None;
            }
            write_store(&path, &store)?;
            Ok(json!({"ok":true,"removed":id}))
        }
        "default" => {
            let options = crate::options(&args[1..], &["--id"])?;
            let id = crate::required(&options, "--id")?;
            resolve(&store, id)?;
            store.default_source_id = Some(id.to_string());
            write_store(&path, &store)?;
            Ok(json!({"ok":true,"defaultSourceId":id}))
        }
        "show" => {
            let options = crate::options(&args[1..], &["--id"])?;
            let id = crate::required(&options, "--id")?;
            let source = resolve(&store, id)?;
            Ok(json!({"ok":true,"source":source}))
        }
        "analyze" => {
            let options = crate::options(&args[1..], &["--url"])?;
            let result =
                source_analyzer::analyze(crate::required(&options, "--url")?, None).await?;
            Ok(
                json!({"ok":true,"urlTemplate":result.url_template,"suggestedName":result.suggested_name,
                "suggestedMaxZoom":result.suggested_max_zoom,"testOk":result.test_ok,
                "statusCode":result.status_code,"tileFormat":result.tile_format,"message":result.message}),
            )
        }
        "probe" => {
            let options = crate::options(&args[1..], &["--id", "--zoom", "--x", "--y"])?;
            let source = resolve(&store, crate::required(&options, "--id")?)?;
            let z = optional_u8(options.get("--zoom"), "--zoom", 0)?;
            if z > source.max_zoom {
                return Err(format!(
                    "Source {} supports up to zoom {}",
                    source.id, source.max_zoom
                ));
            }
            let x = options
                .get("--x")
                .map(|s| {
                    s.parse::<u32>()
                        .map_err(|_| "--x must be an integer".to_string())
                })
                .unwrap_or(Ok(0))?;
            let y = options
                .get("--y")
                .map(|s| {
                    s.parse::<u32>()
                        .map_err(|_| "--y must be an integer".to_string())
                })
                .unwrap_or(Ok(0))?;
            if z > 22 || u64::from(x) >= (1u64 << z) || u64::from(y) >= (1u64 << z) {
                return Err("Tile coordinates outside zoom level".into());
            }
            let url = TileDownloader::new_preview(source.clone(), None)?
                .get_tile_url_public(&TileCoord { x, y, z });
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?;
            let mut response = client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("Tile probe failed: {e}"))?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!("Tile probe returned HTTP {}", status.as_u16()));
            }
            let mime = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                if bytes.len() + chunk.len() > tile_payload::MAX_TILE_BYTES {
                    return Err("Tile probe exceeded 16 MiB".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            tile_payload::validate(&bytes, mime.as_deref())?;
            let image = image::load_from_memory(&bytes)
                .map_err(|_| "Source returned a non-raster tile".to_string())?;
            if image.width() != 256 || image.height() != 256 {
                return Err("Source tile must be 256x256 pixels".into());
            }
            Ok(
                json!({"ok":true,"id":source.id,"zoom":z,"x":x,"y":y,"bytes":bytes.len(),"width":256,"height":256}),
            )
        }
        _ => Err(format!("Unknown sources command: {action}")),
    }
}
