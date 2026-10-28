//! Independent Keyhole history: point catalog, streaming XYZ and frozen exports.
mod io;
mod protocol;
mod wire;
use super::{catalog::pack_date, transport::sha, Result};
use image::{RgbImage, Rgba, RgbaImage};
pub use protocol::{DateRecord, Engine, Root};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex, OnceLock},
};
const VERSION: &str = "keyhole-raster-v1";
const PREFIX: &str = "earth_keyhole_";
pub fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 21
        && path.starts_with('0')
        && path.bytes().all(|b| (b'0'..=b'3').contains(&b))
}
pub fn path_for(row: u32, col: u32, level: u8) -> String {
    let mut s = String::from("0");
    for bit in (0..level).rev() {
        let r = (row >> bit) & 1;
        let c = (col >> bit) & 1;
        s.push(char::from(b'0' + ((r << 1) | (r ^ c)) as u8));
    }
    s
}
fn row_col(path: &str) -> (u32, u32, u8) {
    let (mut row, mut col) = (0, 0);
    for digit in path.bytes().skip(1) {
        let r = (digit - b'0') >> 1;
        let c = r ^ ((digit - b'0') & 1);
        row = (row << 1) | u32::from(r);
        col = (col << 1) | u32::from(c);
    }
    (row, col, (path.len() - 1) as u8)
}
pub fn subindex(path: &str) -> u32 {
    fn index(path: &str) -> u32 {
        path.bytes()
            .skip(1)
            .fold(0, |n, c| n * 4 + u32::from(c - b'0') + 1)
    }
    if path.len() <= 4 {
        return index(path);
    }
    let tail = &path[((path.len() - 1) / 4) * 4..];
    index(tail) + u32::from(tail.as_bytes()[0] - b'0') * 85 + 1
}
pub fn native_level(z: u8) -> u8 {
    z.saturating_add(1).clamp(1, 20)
}
fn cell(lon: f64, lat: f64, level: u8) -> (u32, u32) {
    let size = 1u32 << level;
    let to = |v: f64| (((v + 180.) / 360. * f64::from(size)).floor().max(0.) as u32).min(size - 1);
    (to(lat), to(lon))
}
fn coordinates(z: u8, x: u32, y: u32) -> Result<()> {
    if z > 22 || u64::from(x) >= 1u64 << z || u64::from(y) >= 1u64 << z {
        return Err("EARTH_PLAN: Keyhole XYZ outside grid".into());
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub cell_path: String,
    pub path: String,
    pub record: DateRecord,
}
impl Selection {
    pub fn url(&self) -> String {
        format!(
            "https://khmdb.google.com/flatfile?db=tm&f1-{}-i.{}-{:x}",
            self.path, self.record.epoch, self.record.packed
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub id: String,
    pub root: Root,
    pub requested_date: String,
    pub version: String,
    pub bounds: Option<[f64; 4]>,
    pub output_zoom: Option<u8>,
    pub tiles: Option<BTreeMap<String, Vec<Selection>>>,
}
impl Context {
    fn identity(&self) -> String {
        sha(&serde_json::to_vec(&(
            &self.root,
            self.requested_date.as_str(),
            self.version.as_str(),
            self.bounds,
            self.output_zoom,
            &self.tiles,
        ))
        .unwrap())
    }
    fn save(mut self) -> Result<Self> {
        self.id = self.identity();
        io::write(
            &io::directory()?.join(format!("context-{}.json", self.id)),
            &serde_json::to_vec(&self).unwrap(),
        )?;
        let mut active = active().lock().unwrap_or_else(|p| p.into_inner());
        let source = self.source();
        active.retain(|s| s.id != source.id);
        active.push_back(source);
        while active.len() > 32 {
            active.pop_front();
        }
        Ok(self)
    }
    pub fn load(id: &str) -> Result<Self> {
        super::validate_id(id)?;
        let bytes = std::fs::read(io::directory()?.join(format!("context-{id}.json")))
            .map_err(|_| "EARTH_PLAN: Keyhole context unavailable; select the date again")?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("EARTH_BUDGET: frozen Keyhole context".into());
        }
        let context: Self =
            serde_json::from_slice(&bytes).map_err(|_| "EARTH_PLAN: invalid Keyhole context")?;
        if context.id != id || context.identity() != id || context.version != VERSION {
            return Err("EARTH_PLAN: Keyhole context identity/version".into());
        }
        Ok(context)
    }
    pub fn source(&self) -> crate::config::TileSource {
        crate::config::TileSource {
            headers: Default::default(),
            id: format!("{PREFIX}{}", self.id),
            name: format!("Google Earth 历史影像 {}", self.requested_date),
            url: format!("keyhole-history://{}/{{z}}/{{x}}/{{y}}", self.id),
            subdomains: vec![],
            max_zoom: self.output_zoom.unwrap_or(22),
            attribution: format!(
                "© Google Earth · selected {} · acquisition date varies/unknown",
                self.requested_date
            ),
        }
    }
}
fn active() -> &'static Mutex<VecDeque<crate::config::TileSource>> {
    static ACTIVE: OnceLock<Mutex<VecDeque<crate::config::TileSource>>> = OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}
pub fn active_sources() -> BTreeMap<String, crate::config::TileSource> {
    active()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .map(|s| (s.id.clone(), s.clone()))
        .collect()
}
pub fn source(id: &str) -> Result<crate::config::TileSource> {
    Ok(Context::load(
        id.strip_prefix(PREFIX)
            .ok_or("EARTH_PLAN: Keyhole source identity")?,
    )?
    .source())
}
pub fn session(root_id: &str, date: &str) -> Result<Context> {
    pack_date(date)?;
    Context {
        id: String::new(),
        root: Root::load(root_id)?,
        requested_date: date.into(),
        version: VERSION.into(),
        bounds: None,
        output_zoom: None,
        tiles: None,
    }
    .save()
}
pub async fn dates(
    lon: f64,
    lat: f64,
    z: u8,
    client: reqwest::Client,
) -> Result<serde_json::Value> {
    if !lon.is_finite()
        || !lat.is_finite()
        || !(-180. ..=180.).contains(&lon)
        || !(-85.051129..=85.051129).contains(&lat)
        || z > 22
    {
        return Err("EARTH_AOI: invalid map centre".into());
    }
    let engine = Engine::open(client).await?;
    let level = native_level(z);
    let (row, col) = cell(lon, lat, level);
    let path = path_for(row, col, level);
    let mut current = path.clone();
    let mut found = Vec::new();
    loop {
        if let Some(node) = engine.node(&current).await? {
            if !node.dates.is_empty() {
                found = node.dates;
                break;
            }
        }
        if current.len() <= 1 {
            break;
        }
        current.pop();
    }
    found.sort_by(|a, b| b.packed.cmp(&a.packed));
    Ok(
        serde_json::json!({"rootId":engine.root.id,"path":path,"level":level,"catalogLevel":current.len()-1,
        "dates":found.iter().map(|d|serde_json::json!({"date":d.date,"supportedNodes":1,"coverageFraction":null})).collect::<Vec<_>>(),
        "scope":"view-centre","catalogComplete":true}),
    )
}
async fn select(engine: &Engine, cell_path: &str, date: u32) -> Result<Option<Selection>> {
    let mut path = cell_path.to_owned();
    loop {
        if let Some(node) = engine.node(&path).await? {
            if let Some(record) = node
                .dates
                .iter()
                .filter(|d| d.packed <= date)
                .max_by_key(|d| d.packed)
            {
                return Ok(Some(Selection {
                    cell_path: cell_path.into(),
                    path,
                    record: record.clone(),
                }));
            }
        }
        if path.len() <= 1 {
            return Ok(None);
        }
        path.pop();
    }
}
async fn selections(engine: &Engine, date: &str, z: u8, x: u32, y: u32) -> Result<Vec<Selection>> {
    coordinates(z, x, y)?;
    let b = crate::tile::tile_to_latlng(x, y, z);
    let level = native_level(z);
    let (r0, c0) = cell(b.west + 1e-10, b.south + 1e-10, level);
    let (r1, c1) = cell(b.east - 1e-10, b.north - 1e-10, level);
    if (r1 - r0 + 1) as u64 * (c1 - c0 + 1) as u64 > 16 {
        return Err("EARTH_BUDGET: Keyhole source cells per tile".into());
    }
    let packed = pack_date(date)?;
    let mut result = Vec::new();
    for row in r0..=r1 {
        for col in c0..=c1 {
            let path = path_for(row, col, level);
            if let Some(selection) = select(engine, &path, packed).await? {
                result.push(selection);
            }
        }
    }
    Ok(result)
}
pub async fn plan(
    source_key: &str,
    bounds: [f64; 4],
    zoom: u8,
    client: reqwest::Client,
) -> Result<Context> {
    plan_with_progress(source_key,bounds,zoom,client,None,|_,_|{}).await
}
pub async fn plan_with_progress<F:FnMut(u32,u32)>(
    source_key:&str,bounds:[f64;4],zoom:u8,client:reqwest::Client,
    pause:Option<&crate::pause_control::PauseControl>,mut progress:F,
) -> Result<Context> {
    super::catalog::validate_bounds(bounds, zoom)?;
    let session = Context::load(
        source_key
            .strip_prefix(PREFIX)
            .ok_or("EARTH_PLAN: Keyhole preview context")?,
    )?;
    let west = ((bounds[0] + 180.) / 360. * (1u64 << zoom) as f64).floor() as u32;
    let east = ((bounds[2] + 180.) / 360. * (1u64 << zoom) as f64)
        .floor()
        .min(((1u64 << zoom) - 1) as f64) as u32;
    let tile_y = |lat: f64| {
        ((1. - lat.to_radians().tan().asinh() / std::f64::consts::PI) / 2. * (1u64 << zoom) as f64)
            .floor() as u32
    };
    let north = tile_y(bounds[3]);
    let south = tile_y(bounds[1]);
    let count = (east - west + 1) as u64 * (south - north + 1) as u64;
    if count > 1024 {
        return Err(format!(
            "EARTH_BUDGET: {count} output tiles; select a smaller region or lower output detail"
        ));
    }
    let engine = Engine {
        client,
        root: session.root.clone(),
    };
    let mut tiles = BTreeMap::new();
    progress(0,count as u32);
    for y in north..=south {
        for x in west..=east {
            if let Some(pause)=pause { pause.wait_if_paused().await; }
            tiles.insert(
                format!("{zoom}/{x}/{y}"),
                selections(&engine, &session.requested_date, zoom, x, y).await?,
            );
            progress(tiles.len() as u32,count as u32);
        }
    }
    if tiles.values().all(Vec::is_empty) {
        return Err(
            "EARTH_NO_DATA: no imagery on or before the selected date in this region".into(),
        );
    }
    Context {
        id: String::new(),
        root: session.root,
        requested_date: session.requested_date,
        version: VERSION.into(),
        bounds: Some(bounds),
        output_zoom: Some(zoom),
        tiles: Some(tiles),
    }
    .save()
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub loaded: u64,
    pub cache_hits: u64,
    pub no_data: u64,
    pub fallback_tiles: u64,
    pub errors: u64,
    pub providers: BTreeSet<String>,
}
fn statuses() -> &'static Mutex<BTreeMap<String, Status>> {
    static STATUS: OnceLock<Mutex<BTreeMap<String, Status>>> = OnceLock::new();
    STATUS.get_or_init(Default::default)
}
pub fn status(id: &str) -> Status {
    statuses()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(id)
        .cloned()
        .unwrap_or_default()
}
pub fn note_error(id: &str) {
    let mut map = statuses().lock().unwrap_or_else(|p| p.into_inner());
    map.entry(id.into()).or_default().errors += 1;
}
fn record(context: &Context, selected: &[Selection], cache: bool, no_data: bool) {
    let mut statuses = statuses().lock().unwrap_or_else(|p| p.into_inner());
    let status = statuses.entry(context.source().id).or_default();
    if cache {
        status.cache_hits += 1;
    } else {
        status.loaded += 1;
    }
    if no_data {
        status.no_data += 1;
    }
    if selected
        .iter()
        .any(|s| s.record.date != context.requested_date || s.path != s.cell_path)
    {
        status.fallback_tiles += 1;
    }
    for s in selected {
        if let Some(provider) = context.root.providers.get(&s.record.provider) {
            status.providers.insert(provider.clone());
        }
    }
}
pub async fn read_tile(
    source_key: &str,
    z: u8,
    x: u32,
    y: u32,
    client: reqwest::Client,
) -> Result<Vec<u8>> {
    coordinates(z, x, y)?;
    let context = Context::load(
        source_key
            .strip_prefix(PREFIX)
            .ok_or("EARTH_PLAN: Keyhole namespace")?,
    )?;
    let tile_key = format!("{z}/{x}/{y}");
    if context.output_zoom.is_some_and(|zoom| zoom != z) {
        return Err("EARTH_PLAN: output zoom differs from the frozen Keyhole grid".into());
    }
    if context
        .tiles
        .as_ref()
        .is_some_and(|t| !t.contains_key(&tile_key))
    {
        return Err("EARTH_PLAN: tile outside frozen Keyhole grid".into());
    }
    let key = crate::tile_cache::SourceKey::new(source_key);
    let coord = crate::tile_cache::TileCoord { z, x, y };
    let gate = io::gate(&format!("xyz:{source_key}/{tile_key}"));
    let _guard = gate.lock().await;
    if let Some(tile) = crate::tile_cache::Store::global().get(&key, coord)? {
        let metadata = std::fs::read(io::directory()?.join(format!(
            "tile-{}.json",
            sha(format!("{source_key}/{tile_key}").as_bytes())
        )))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
        let selected = metadata
            .as_ref()
            .and_then(|v| v.get("selected"))
            .and_then(|v| serde_json::from_value::<Vec<Selection>>(v.clone()).ok())
            .unwrap_or_default();
        record(
            &context,
            &selected,
            true,
            metadata
                .as_ref()
                .and_then(|v| v.get("noData"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        );
        return Ok(tile.bytes);
    }
    let engine = Engine {
        root: context.root.clone(),
        client,
    };
    let chosen = if let Some(tiles) = &context.tiles {
        tiles[&tile_key].clone()
    } else {
        selections(&engine, &context.requested_date, z, x, y).await?
    };
    let mut images = BTreeMap::new();
    for selection in &chosen {
        if !images.contains_key(&selection.path) {
            match engine.image(selection).await {
                Ok(image) => {
                    images.insert(selection.path.clone(), image);
                }
                Err(e) if e.starts_with("EARTH_NO_DATA:") => {}
                Err(e) => return Err(e),
            }
        }
    }
    static RASTER: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = RASTER
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "EARTH_RASTER: queue closed")?;
    let selections = chosen.clone();
    let output = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        render(&selections, &images, z, x, y)
    })
    .await
    .map_err(|_| "EARTH_RASTER: Keyhole worker stopped")??;
    let no_data = output.pixels().all(|p| p[3] == 0);
    let mut png = std::io::Cursor::new(Vec::new());
    output
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let bytes = png.into_inner();
    // Persist per-block provenance even when the normal imagery cache is disabled.
    let evidence = serde_json::json!({"contextId":context.id,"grid":[z,x,y],"selected":chosen,"noData":no_data});
    std::fs::write(
        io::directory()?.join(format!(
            "tile-{}.json",
            sha(format!("{source_key}/{tile_key}").as_bytes())
        )),
        serde_json::to_vec(&evidence).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    crate::tile_cache::Store::global().put(
        &key,
        coord,
        crate::tile_cache::StoredTile {
            bytes: bytes.clone(),
            content_type: "image/png".into(),
        },
        Some(crate::tile_cache::SourceInfo {
            display_name: context.source().name,
            url_template: context.source().url,
            format: "png".into(),
            attribution: Some(context.source().attribution),
            ..Default::default()
        }),
    )?;
    record(&context, &chosen, false, no_data);
    Ok(bytes)
}
fn render(
    selected: &[Selection],
    images: &BTreeMap<String, Arc<RgbImage>>,
    z: u8,
    x: u32,
    y: u32,
) -> Result<RgbaImage> {
    let mut output = RgbaImage::new(256, 256);
    let level = native_level(z);
    let scale = 2f64.powi(z as i32);
    let lookup: BTreeMap<_, _> = selected.iter().map(|s| (s.cell_path.as_str(), s)).collect();
    for py in 0..256 {
        let lat = (std::f64::consts::PI
            * (1. - 2. * (y as f64 + (py as f64 + 0.5) / 256.) / scale))
            .sinh()
            .atan()
            .to_degrees();
        for px in 0..256 {
            let lon = (x as f64 + (px as f64 + 0.5) / 256.) / scale * 360. - 180.;
            let (row, col) = cell(lon, lat, level);
            let path = path_for(row, col, level);
            let Some(selection) = lookup.get(path.as_str()) else {
                continue;
            };
            let Some(image) = images.get(&selection.path) else {
                continue;
            };
            let (r, c, l) = row_col(&selection.path);
            let size = 2f64.powi(l as i32);
            let fx = ((lon + 180.) / 360. * size - c as f64) * 256. - 0.5;
            let fy = (r as f64 + 1. - (lat + 180.) / 360. * size) * 256. - 0.5;
            let ix = fx.floor();
            let iy = fy.floor();
            let tx = fx - ix;
            let ty = fy - iy;
            let get = |dx: f64, dy: f64| {
                image.get_pixel(
                    (ix + dx).clamp(0., 255.) as u32,
                    (iy + dy).clamp(0., 255.) as u32,
                )
            };
            let mut pixel = [0, 0, 0, 255];
            for b in 0..3 {
                pixel[b] = ((1. - ty)
                    * ((1. - tx) * get(0., 0.)[b] as f64 + tx * get(1., 0.)[b] as f64)
                    + ty * ((1. - tx) * get(0., 1.)[b] as f64 + tx * get(1., 1.)[b] as f64))
                    .round() as u8;
            }
            output.put_pixel(px, py, Rgba(pixel));
        }
    }
    Ok(output)
}
pub fn parse_url(url: &str) -> Result<(String, u8, u32, u32)> {
    let url = reqwest::Url::parse(url).map_err(|_| "EARTH_PLAN: Keyhole URI")?;
    if url.scheme() != "keyhole-history"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("EARTH_PLAN: Keyhole URI context".into());
    }
    let id = url.host_str().ok_or("EARTH_PLAN: Keyhole URI identity")?;
    super::validate_id(id)?;
    let v: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
    if v.len() != 3 {
        return Err("EARTH_PLAN: Keyhole URI coordinates".into());
    }
    let z = v[0].parse().map_err(|_| "EARTH_PLAN: Keyhole zoom")?;
    let x = v[1].parse().map_err(|_| "EARTH_PLAN: Keyhole x")?;
    let y = v[2].parse().map_err(|_| "EARTH_PLAN: Keyhole y")?;
    coordinates(z, x, y)?;
    Ok((format!("{PREFIX}{id}"), z, x, y))
}
pub fn validate_request(source:&str,bounds:[f64;4],zooms:&[u8])->Result<()> {
    let context=Context::load(source.strip_prefix(PREFIX).ok_or("EARTH_PLAN: Keyhole request source")?)?;
    if context.tiles.is_some(){return validate_export(source,bounds,zooms);}
    let zoom=*zooms.first().ok_or("EARTH_PLAN: missing output zoom")?;
    super::catalog::validate_bounds(bounds,zoom)?;
    if zooms.iter().any(|z|*z!=zoom){return Err("EARTH_UNSUPPORTED: choose one output level per historical imagery task".into());}
    let count=crate::tile::estimate_tile_count(&crate::tile::Bounds{west:bounds[0],south:bounds[1],east:bounds[2],north:bounds[3]},zoom);
    if count>1024{return Err(format!("EARTH_BUDGET: {count} output tiles; select a smaller region or lower output detail"));}
    Ok(())
}
pub fn validate_export(source: &str, bounds: [f64; 4], zooms: &[u8]) -> Result<()> {
    let context = Context::load(
        source
            .strip_prefix(PREFIX)
            .ok_or("EARTH_PLAN: Keyhole export source")?,
    )?;
    let b = context
        .bounds
        .ok_or("EARTH_PLAN: create a frozen selection before downloading")?;
    if bounds[0] < b[0] - 1e-8
        || bounds[1] < b[1] - 1e-8
        || bounds[2] > b[2] + 1e-8
        || bounds[3] > b[3] + 1e-8
        || zooms.iter().any(|z| Some(*z) != context.output_zoom)
    {
        return Err("EARTH_PLAN: selection or zoom differs from frozen Keyhole export".into());
    }
    Ok(())
}
pub fn manifest(path: &std::path::Path, source_key: &str, grid: serde_json::Value) -> Result<()> {
    let context = Context::load(
        source_key
            .strip_prefix(PREFIX)
            .ok_or("EARTH_PLAN: Keyhole manifest source")?,
    )?;
    let mut sources = BTreeMap::new();
    if let Some(tiles) = &context.tiles {
        for selected in tiles.values() {
            for s in selected {
                let url = s.url();
                if let Ok(bytes) =
                    std::fs::read(io::directory()?.join(format!("{}.ref", sha(url.as_bytes()))))
                {
                    if let Ok(e) = serde_json::from_slice::<io::Evidence>(&bytes) {
                        sources.insert(url, e);
                    }
                }
            }
        }
    }
    let document = serde_json::json!({"provider":"google_earth_history","protocol":"keyhole_legacy","context":context,"outputGrid":grid,"contentEvidence":sources,"selectionPolicy":"on_or_before","effectiveDateStatus":"unknown","assetType":"processed_map_imagery","resampling":"inverse Web Mercator and bilinear sampling","earthEngineLoaded":false});
    std::fs::write(
        path.with_extension("earth-history.json"),
        serde_json::to_vec_pretty(&document).unwrap(),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keyhole_paths_and_packet_indices_are_distinct_from_xyz() {
        assert_eq!(path_for(19823, 5242, 15), "0301320302212323");
        assert_eq!(row_col("0301320302212323"), (19823, 5242, 15));
        assert_eq!(subindex("0301"), 70);
        assert_eq!(subindex("0301320302212323"), 251);
    }
    #[test]
    fn legacy_xor_is_symmetric_and_bounded() {
        let key: Vec<_> = (0..1016).map(|n| n as u8).collect();
        let source = vec![42; 3000];
        assert_eq!(
            io::decrypt(&io::decrypt(&source, &key).unwrap(), &key).unwrap(),
            source
        );
        assert!(io::decrypt(&source, &[0; 7]).is_err());
        assert!(io::unpack(b"<html/>").is_err());
    }
    #[test]
    fn destinations_are_typed_and_dated() {
        assert!(io::allowed(protocol::ROOT_URL));
        assert!(io::allowed(
            "https://khmdb.google.com/flatfile?db=tm&f1-0301320302212323-i.369-fd4ee"
        ));
        for url in [
            "https://evil.test/flatfile?db=tm&qp-0-q.371",
            "https://khmdb.google.com/flatfile?db=tm&qp-0-q.371&token=x",
            "https://khmdb.google.com/flatfile?db=tm&qp-05-q.371",
        ] {
            assert!(!io::allowed(url));
        }
    }
    #[test]
    fn context_identity_separates_date_root_and_frozen_output() {
        let mut context = Context {
            id: String::new(),
            root: Root {
                id: "a".repeat(64),
                epoch: 371,
                key: vec![0; 1016],
                providers: BTreeMap::new(),
            },
            requested_date: "2024-04-30".into(),
            version: VERSION.into(),
            bounds: None,
            output_zoom: None,
            tiles: None,
        };
        let preview = context.identity();
        context.requested_date = "2026-07-14".into();
        assert_ne!(preview, context.identity());
        context.requested_date = "2024-04-30".into();
        context.root.epoch += 1;
        assert_ne!(preview, context.identity());
        context.root.epoch -= 1;
        context.bounds = Some([-123., 37., -122., 38.]);
        context.output_zoom = Some(15);
        context.tiles = Some(BTreeMap::new());
        assert_ne!(preview, context.identity());
    }
}
