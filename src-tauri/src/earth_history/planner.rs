use super::{
    catalog::{self, Catalog},
    decoder::{self, Node},
    raster,
    transport::{self, Evidence, Transport, ROOT},
    Result,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::Cursor,
    sync::{Arc, OnceLock},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    pub path: String,
    pub node_epoch: u32,
    pub imagery_epoch: u32,
    pub packet_date: String,
    pub packed_date: u32,
    pub native_lod: u8,
    pub url: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    #[serde(default = "selection_policy")]
    pub selection_policy: String,
    pub id: String,
    pub catalog_id: String,
    pub bounds: [f64; 4],
    pub requested_date: String,
    pub output_zoom: u8,
    pub contents: Vec<Content>,
    pub metadata: Vec<Evidence>,
    pub unavailable_nodes: usize,
    pub tile_count: usize,
    pub fallback_occurred: bool,
    pub effective_date_status: String,
    pub protocol_version: String,
}
fn selection_policy() -> String {
    "on_or_before".into()
}
impl Plan {
    fn identity(&self) -> String {
        transport::sha(
            &serde_json::to_vec(&(
                &self.catalog_id,
                self.bounds,
                &self.requested_date,
                self.output_zoom,
                &self.contents,
                "earth-history-v1",
            ))
            .unwrap(),
        )
    }
    pub fn load(id: &str) -> Result<Self> {
        super::validate_id(id)?;
        let data = std::fs::read(transport::directory()?.join(format!("plan-{id}.json")))
            .map_err(|_| "EARTH_PLAN: frozen plan unavailable; query the region again")?;
        let result: Self =
            serde_json::from_slice(&data).map_err(|_| "EARTH_PLAN: invalid frozen plan")?;
        if result.id != id
            || result.identity() != id
            || result.selection_policy != "on_or_before"
            || result.protocol_version != "earth-history-v1"
        {
            return Err("EARTH_PLAN: frozen plan hash mismatch".into());
        }
        Ok(result)
    }
    pub fn source(&self) -> crate::config::TileSource {
        let credits = transport::directory()
            .ok()
            .and_then(|dir| std::fs::read(dir.join(format!("data-{}.json", self.id))).ok())
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|value| value.get("copyrights").and_then(|v| v.as_array()).cloned())
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_default();
        let credits = credits
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        crate::config::TileSource {
            id: format!("earth_history_{}", self.id),
            name: format!("Google Earth 历史影像 {}", self.requested_date),
            url: format!("earth-history://{}/{{z}}/{{x}}/{{y}}", self.id),
            subdomains: vec![],
            max_zoom: self.output_zoom,
            attribution: format!(
                "© Google Earth; {credits}; requested {}; actual acquisition date unknown",
                self.requested_date
            ),
        }
    }
}
fn active() -> &'static std::sync::Mutex<HashMap<String, crate::config::TileSource>> {
    static ACTIVE: OnceLock<std::sync::Mutex<HashMap<String, crate::config::TileSource>>> =
        OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}
pub fn active_sources() -> HashMap<String, crate::config::TileSource> {
    active().lock().unwrap_or_else(|p| p.into_inner()).clone()
}
pub fn activate(plan: &Plan) {
    active()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(plan.source().id.clone(), plan.source());
}
pub fn source(id: &str) -> Result<crate::config::TileSource> {
    let hash = id
        .strip_prefix("earth_history_")
        .ok_or("EARTH_PLAN: source identity")?;
    Ok(Plan::load(hash)?.source())
}
pub fn prepare(catalog_id: &str, date: &str) -> Result<Plan> {
    let catalog = Catalog::load(catalog_id)?;
    if !catalog.catalog_complete {
        return Err(
            "EARTH_BUDGET: date discovery is incomplete; narrow the region or lower detail".into(),
        );
    }
    let date_key = catalog::pack_date(date)?;
    let b = catalog.bounds;
    let bounds = crate::tile::Bounds {
        west: b[0],
        south: b[1],
        east: b[2],
        north: b[3],
    };
    let tile_count = crate::tile::get_tiles_in_bounds(&bounds, catalog.output_zoom).len();
    if tile_count > 128 {
        return Err(format!(
            "EARTH_BUDGET: {tile_count} output tiles exceed this plan's 128-tile working budget"
        ));
    }
    let mut contents = Vec::new();
    let mut unavailable = 0;
    for node in &catalog.nodes {
        let version = node
            .versions
            .iter()
            .filter(|v| v.supported && v.packed <= date_key)
            .max_by_key(|v| v.packed);
        let Some(v) = version else {
            unavailable += 1;
            continue;
        };
        contents.push(Content {
            path: node.path.clone(),
            node_epoch: node.node_epoch,
            imagery_epoch: v.imagery_epoch,
            packet_date: v.date.clone(),
            packed_date: v.packed,
            native_lod: node.native_lod,
            url: format!(
                "{ROOT}NodeData/pb=!1m2!1s{}!2u{}!2e1!3u{}!4b0!5i{}",
                node.path, node.node_epoch, v.imagery_epoch, v.packed
            ),
        });
    }
    if contents.is_empty() {
        if catalog.nodes.iter().any(|node| {
            node.versions
                .iter()
                .any(|v| v.packed <= date_key && !v.supported)
        }) {
            return Err("EARTH_UNSUPPORTED: the available historical date records use an unverified variant".into());
        }
        return Err(
            "EARTH_NO_DATA: no historical packets are available on or before this date".into(),
        );
    }
    let mut plan = Plan {
        selection_policy: selection_policy(),
        id: String::new(),
        catalog_id: catalog.id,
        bounds: b,
        requested_date: date.into(),
        output_zoom: catalog.output_zoom,
        fallback_occurred: contents.iter().any(|c| c.packet_date != date),
        contents,
        metadata: catalog.metadata,
        unavailable_nodes: unavailable,
        tile_count,
        effective_date_status: "unknown".into(),
        protocol_version: "earth-history-v1".into(),
    };
    plan.id = plan.identity();
    std::fs::write(
        transport::directory()?.join(format!("plan-{}.json", plan.id)),
        serde_json::to_vec(&plan).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    activate(&plan);
    Ok(plan)
}

type CachedNodes = VecDeque<(String, Arc<Vec<Node>>)>;
fn decoded_cache() -> &'static tokio::sync::Mutex<CachedNodes> {
    static CACHE: OnceLock<tokio::sync::Mutex<CachedNodes>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}
pub async fn nodes(plan: &Plan, client: reqwest::Client) -> Result<Arc<Vec<Node>>> {
    let mut cache = decoded_cache().lock().await;
    if let Some((_, nodes)) = cache.iter().find(|(id, _)| id == &plan.id) {
        return Ok(nodes.clone());
    }
    let mut transport = Transport::with_client(client, 128, 128 * 1024 * 1024);
    let mut decoded = Vec::new();
    let mut evidence = Vec::new();
    let mut missing = Vec::new();
    let mut allocated = 0usize;
    for content in &plan.contents {
        let packet = match transport.get(&content.url).await {
            Ok(packet) => packet,
            Err(error) if error.starts_with("EARTH_NO_DATA:") => {
                missing.push(content.path.clone());
                continue;
            }
            Err(error) => return Err(error),
        };
        let node = decoder::decode(&packet.bytes)?;
        allocated += node
            .meshes
            .iter()
            .map(|m| m.texture.as_raw().len() + m.positions.len() * 40 + m.triangles.len() * 24)
            .sum::<usize>();
        if allocated > 128 * 1024 * 1024 {
            return Err("EARTH_BUDGET: decoded geometry and textures exceed 128 MiB".into());
        }
        evidence.push(packet.evidence);
        decoded.push(node);
    }
    let evidence_path = transport::directory()?.join(format!("data-{}.json", plan.id));
    let previous = std::fs::read(&evidence_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    let mut copyrights = Vec::new();
    let mut copyright_evidence = None;
    let ids: std::collections::HashSet<_> = decoded
        .iter()
        .flat_map(|node| node.copyrights.iter().copied())
        .collect();
    if let Some(old) = previous
        .as_ref()
        .filter(|v| v.get("copyrightEvidence").is_some_and(|e| !e.is_null()))
    {
        copyrights = old
            .get("copyrights")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        copyright_evidence = old.get("copyrightEvidence").cloned();
    } else if let Ok(packet) = transport.get(&format!("{ROOT}Copyrights/pb=")).await {
        let fields = super::wire::parse(&packet.bytes)?;
        for body in super::wire::repeated(&fields, 1) {
            let f = super::wire::parse(body)?;
            let id = super::wire::int(&f, 1).unwrap_or(0);
            if ids.contains(&id) {
                let text = super::wire::bytes(&f, 2)
                    .and_then(|b| std::str::from_utf8(b).ok())
                    .unwrap_or("");
                copyrights.push(serde_json::json!({"id":id,"text":text}));
            }
        }
        copyright_evidence = Some(serde_json::to_value(packet.evidence).unwrap());
    }
    std::fs::write(
        evidence_path,
        serde_json::to_vec(
            &serde_json::json!({"packets":evidence,"missingNodes":missing,
        "copyrightIds":ids,"copyrights":copyrights,"copyrightEvidence":copyright_evidence}),
        )
        .unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let nodes = Arc::new(decoded);
    cache.push_back((plan.id.clone(), nodes.clone()));
    while cache.len() > 2 {
        cache.pop_front();
    }
    Ok(nodes)
}
pub fn parse_tile_url(raw: &str) -> Result<(String, u8, u32, u32)> {
    let url = reqwest::Url::parse(raw).map_err(|_| "EARTH_PLAN: invalid provider URI")?;
    if url.scheme() != "earth-history"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("EARTH_PLAN: invalid provider URI".into());
    }
    let id = url.host_str().ok_or("EARTH_PLAN: missing plan identity")?;
    super::validate_id(id)?;
    let parts: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
    if parts.len() != 3 {
        return Err("EARTH_PLAN: tile coordinates missing".into());
    }
    let z: u8 = parts[0].parse().map_err(|_| "EARTH_PLAN: tile level")?;
    let x: u32 = parts[1].parse().map_err(|_| "EARTH_PLAN: tile column")?;
    let y: u32 = parts[2].parse().map_err(|_| "EARTH_PLAN: tile row")?;
    if z > 22 || u64::from(x) >= 1u64 << z || u64::from(y) >= 1u64 << z {
        return Err("EARTH_PLAN: tile outside grid".into());
    }
    Ok((id.into(), z, x, y))
}
pub async fn read_tile(raw: &str, client: reqwest::Client) -> Result<Vec<u8>> {
    let (id, z, x, y) = parse_tile_url(raw)?;
    let plan = Plan::load(&id)?;
    if z > plan.output_zoom {
        return Err("EARTH_PLAN: tile exceeds frozen output detail".into());
    }
    let tile = crate::tile::tile_to_latlng(x, y, z);
    let b = plan.bounds;
    if tile.east <= b[0] || tile.west >= b[2] || tile.north <= b[1] || tile.south >= b[3] {
        return Err("EARTH_NO_DATA: outside planned region".into());
    }
    let nodes = nodes(&plan, client).await?;
    let image = tokio::task::spawn_blocking(move || {
        raster::render(&nodes, raster::grid_bounds(z, x, y), 256, 256)
    })
    .await
    .map_err(|_| "EARTH_RASTER: worker stopped")??;
    if image.pixels().all(|pixel| pixel[3] == 0) {
        return Err("EARTH_NO_DATA: no historical coverage in this block".into());
    }
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(png.into_inner())
}
pub fn write_manifest(path: &std::path::Path, source_id: &str) -> Result<()> {
    write_manifest_impl(path, source_id, None)
}
pub fn write_manifest_for_grid(
    path: &std::path::Path,
    source_id: &str,
    bounds: &crate::tile::TileBounds,
    width: u32,
    height: u32,
    zoom: u8,
) -> Result<()> {
    let project = |lon: f64, lat: f64| {
        [
            6378137. * lon.to_radians(),
            6378137.
                * (std::f64::consts::PI / 4. + lat.to_radians() / 2.)
                    .tan()
                    .ln(),
        ]
    };
    let low = project(bounds.west, bounds.south);
    let high = project(bounds.east, bounds.north);
    let grid = serde_json::json!({"crs":"EPSG:3857","zoom":zoom,"width":width,"height":height,
        "bounds":[low[0],low[1],high[0],high[1]],"transform":[low[0],(high[0]-low[0])/width as f64,0.,high[1],0.,-(high[1]-low[1])/height as f64]});
    write_manifest_impl(path, source_id, Some(grid))
}
fn write_manifest_impl(
    path: &std::path::Path,
    source_id: &str,
    output_grid: Option<serde_json::Value>,
) -> Result<()> {
    let id = source_id
        .strip_prefix("earth_history_")
        .ok_or("EARTH_PLAN: identity")?;
    let plan = Plan::load(id)?;
    let data = std::fs::read(transport::directory()?.join(format!("data-{id}.json")))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    let manifest = serde_json::json!({"provider":"google_earth_history","root":ROOT,"plan":plan,"contentEvidence":data,"outputGrid":output_grid,
        "effectiveDateStatus":"unknown","assetType":"processed_map_imagery","earthEngineLoaded":false,
        "coordinateBasis":"Original Earth spherical angular coordinates projected to EPSG:3857",
        "resampling":"Radial triangle intersection and nearest-neighbour texture sampling",
        "fallbackEvidence":"Per-node packet dates compared with the requested date; capture-date fallback is unknown"});
    std::fs::write(
        path.with_extension("earth-history.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
