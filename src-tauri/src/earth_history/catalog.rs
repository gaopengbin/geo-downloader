use super::{
    transport::{self, Evidence, Transport, ROOT},
    wire::{self, Value},
    Result,
};
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet, VecDeque};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub date: String,
    pub packed: u32,
    pub imagery_epoch: u32,
    pub supported: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRef {
    pub path: String,
    pub node_epoch: u32,
    pub bulk_epoch: u32,
    pub native_lod: u8,
    pub nominal_meters_per_texel: f64,
    pub versions: Vec<Version>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateEntry {
    pub date: String,
    pub supported_nodes: usize,
    pub coverage_fraction: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub id: String,
    pub bounds: [f64; 4],
    pub output_zoom: u8,
    pub dates: Vec<DateEntry>,
    pub catalog_complete: bool,
    pub scope: String,
    pub nodes: Vec<NodeRef>,
    pub metadata: Vec<Evidence>,
    pub metadata_requests: usize,
}
pub fn pack_date(date: &str) -> Result<u32> {
    if date.len() != 10 {
        return Err("EARTH_DATE: use YYYY-MM-DD".into());
    }
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| "EARTH_DATE: invalid calendar date")?;
    if !(2..=9999).contains(&date.year()) {
        return Err("EARTH_DATE: invalid year".into());
    }
    Ok(((date.year() as u32) << 9) | (date.month() << 5) | date.day())
}
fn unpack_date(packed: u32) -> Option<String> {
    let year = (packed >> 9) as i32;
    if year <= 1 {
        return None;
    } // Original sentinel, not a satellite acquisition in year 0001.
    NaiveDate::from_ymd_opt(year, (packed >> 5) & 15, packed & 31)
        .map(|d| d.format("%Y-%m-%d").to_string())
}
fn versions(fields: &[wire::Field<'_>], number: u32) -> Result<Vec<Version>> {
    let mut result = Vec::new();
    for body in wire::repeated(fields, number) {
        if result.len() >= 10_000 {
            return Err("EARTH_BUDGET: historical date-record working limit reached".into());
        }
        let f = wire::parse(body)?;
        let Some(packed) = wire::int(&f, 1).and_then(|n| u32::try_from(n).ok()) else {
            continue;
        };
        let Some(date) = unpack_date(packed) else {
            continue;
        };
        let Some(epoch) = wire::int(&f, 3).and_then(|n| u32::try_from(n).ok()) else {
            continue;
        };
        result.push(Version {
            date,
            packed,
            imagery_epoch: epoch,
            supported: !f.iter().any(|field| ![1, 3].contains(&field.number)),
        });
    }
    Ok(result)
}
fn angle(a: [f64; 3], b: [f64; 3]) -> f64 {
    let na = a.iter().map(|v| v * v).sum::<f64>().sqrt();
    let nb = b.iter().map(|v| v * v).sum::<f64>().sqrt();
    ((0..3).map(|i| a[i] * b[i]).sum::<f64>() / (na * nb))
        .clamp(-1., 1.)
        .acos()
}
fn direction(lon: f64, lat: f64) -> [f64; 3] {
    let lon = lon.to_radians();
    let lat = lat.to_radians();
    [lat.cos() * lon.cos(), lat.cos() * lon.sin(), lat.sin()]
}
fn intersects(center: [f64; 3], radius: f64, aoi: [f64; 4]) -> bool {
    let d = direction((aoi[0] + aoi[2]) / 2., (aoi[1] + aoi[3]) / 2.);
    let ar = [
        (aoi[0], aoi[1]),
        (aoi[0], aoi[3]),
        (aoi[2], aoi[1]),
        (aoi[2], aoi[3]),
    ]
    .iter()
    .map(|&(lon, lat)| angle(d, direction(lon, lat)))
    .fold(0., f64::max);
    let norm = center.iter().map(|v| v * v).sum::<f64>().sqrt();
    norm <= radius || angle(center, d) <= (radius / norm).clamp(0., 1.).asin() + ar + 1e-7
}
pub fn validate_bounds(bounds: [f64; 4], zoom: u8) -> Result<()> {
    if bounds.iter().any(|v| !v.is_finite())
        || bounds[0] >= bounds[2]
        || bounds[1] >= bounds[3]
        || bounds[0] < -180.
        || bounds[2] > 180.
        || bounds[1] < -85.
        || bounds[3] > 85.
        || !(1..=22).contains(&zoom)
    {
        return Err("EARTH_AOI: provide a nonempty longitude/latitude region within Web Mercator and z1–z22".into());
    }
    Ok(())
}
impl Catalog {
    pub fn load(id: &str) -> Result<Self> {
        super::validate_id(id)?;
        let bytes = std::fs::read(transport::directory()?.join(format!("catalog-{id}.json")))
            .map_err(|_| "EARTH_CATALOG: snapshot unavailable; query dates again")?;
        let catalog: Self =
            serde_json::from_slice(&bytes).map_err(|_| "EARTH_CATALOG: invalid snapshot")?;
        let expected = transport::sha(
            &serde_json::to_vec(&(
                catalog.bounds,
                catalog.output_zoom,
                &catalog.nodes,
                &catalog
                    .metadata
                    .iter()
                    .map(|m| &m.decoded_sha256)
                    .collect::<Vec<_>>(),
            ))
            .unwrap(),
        );
        if catalog.id != id || expected != id {
            return Err("EARTH_CATALOG: snapshot identity mismatch".into());
        }
        Ok(catalog)
    }
}

pub async fn discover(bounds: [f64; 4], zoom: u8, proxy: Option<&str>) -> Result<Catalog> {
    validate_bounds(bounds, zoom)?;
    let mut network = Transport::new(proxy, 64, 64 * 1024 * 1024)?;
    let root = network.get(&format!("{ROOT}PlanetoidMetadata")).await?;
    let rf = wire::parse(&root.bytes)?;
    let root_node = wire::parse(wire::bytes(&rf, 1).ok_or("EARTH_PROTOCOL: missing root node")?)?;
    let root_epoch = u32::try_from(
        wire::int(&root_node, 5)
            .or(wire::int(&root_node, 2))
            .ok_or("EARTH_PROTOCOL: missing root epoch")?,
    )
    .map_err(|_| "EARTH_PROTOCOL: root epoch overflow")?;
    let mut metadata = vec![root.evidence];
    let mut queue = VecDeque::from([(String::new(), root_epoch)]);
    let mut seen = HashSet::new();
    let mut nodes = Vec::new();
    let mut complete = true;
    let target_mpt = 156543.03392804097 * ((bounds[1] + bounds[3]) / 2.).to_radians().cos()
        / 2f64.powi(zoom as i32);
    while let Some((head, epoch)) = queue.pop_front() {
        if !seen.insert((head.clone(), epoch)) {
            continue;
        }
        if seen.len() > 64 || nodes.len() >= 128 {
            complete = false;
            break;
        }
        let packet = network
            .get(&format!("{ROOT}BulkMetadata/pb=!1m2!1s{head}!2u{epoch}"))
            .await?;
        let bf = wire::parse(&packet.bytes)?;
        let center = wire::doubles(wire::bytes(&bf, 3).ok_or("EARTH_PROTOCOL: no bulk center")?)?;
        let scales = wire::floats(wire::bytes(&bf, 4).ok_or("EARTH_PROTOCOL: no bulk scales")?)?;
        if center.len() != 3 || scales.len() < 4 {
            return Err("EARTH_PROTOCOL: invalid bulk coordinates".into());
        }
        let inherited = versions(&bf, 9)?;
        let mut local_nodes = Vec::new();
        let mut local_branches = Vec::new();
        metadata.push(packet.evidence);
        for body in wire::repeated(&bf, 1) {
            let f = wire::parse(body)?;
            let mut key = u64::from(
                u32::try_from(wire::int(&f, 1).ok_or("EARTH_PROTOCOL: no node key")?)
                    .map_err(|_| "EARTH_PROTOCOL: node key overflow")?,
            );
            let length = (key & 3) as usize + 1;
            key >>= 2;
            let mut path = head.clone();
            for _ in 0..length {
                path.push(char::from(b'0' + (key & 7) as u8));
                key >>= 3;
            }
            let flags = key as u32;
            let own_mpt = f.iter().find_map(|field| match field.value {
                Value::F32(bits) if field.number == 4 => Some(f32::from_bits(bits) as f64),
                _ => None,
            });
            let mpt = own_mpt.unwrap_or(scales[length - 1] as f64);
            if !mpt.is_finite() || mpt <= 0. {
                return Err("EARTH_PROTOCOL: invalid metadata scale".into());
            }
            let obb = match wire::bytes(&f, 3) {
                Some(value) => value,
                None if flags & 8 != 0 && flags & 4 != 0 => continue,
                None => return Err("EARTH_PROTOCOL: no node bounds".into()),
            };
            if obb.len() != 15 {
                return Err("EARTH_UNSUPPORTED: node bounds encoding".into());
            }
            let c = std::array::from_fn(|i| {
                center[i] + i16::from_le_bytes([obb[i * 2], obb[i * 2 + 1]]) as f64 * mpt
            });
            let radius = ((0..3)
                .map(|i| (obb[6 + i] as f64 * mpt).powi(2))
                .sum::<f64>())
            .sqrt()
                + 4. * mpt;
            if !intersects(c, radius, bounds) {
                continue;
            }
            let node_epoch = u32::try_from(wire::int(&f, 2).unwrap_or(epoch as u64))
                .map_err(|_| "EARTH_PROTOCOL: node epoch overflow")?;
            let bulk_epoch = u32::try_from(wire::int(&f, 5).unwrap_or(epoch as u64))
                .map_err(|_| "EARTH_PROTOCOL: bulk epoch overflow")?;
            let terminal = mpt <= target_mpt * 1.25 || path.len() >= 20 || (flags & 4) != 0;
            if terminal {
                if flags & 8 != 0 {
                    continue;
                }
                let mut dated: BTreeMap<u32, Version> =
                    inherited.iter().cloned().map(|v| (v.packed, v)).collect();
                for v in versions(&f, 11)? {
                    dated.insert(v.packed, v);
                }
                local_nodes.push(NodeRef {
                    native_lod: path.len() as u8,
                    path,
                    node_epoch,
                    bulk_epoch,
                    nominal_meters_per_texel: mpt,
                    versions: dated.into_values().collect(),
                });
            } else if length == 4 {
                local_branches.push((path, bulk_epoch));
            }
        }
        local_nodes.sort_by_key(|node| node.path.len());
        for node in local_nodes {
            if nodes.len() >= 128 {
                complete = false;
                break;
            }
            if !nodes
                .iter()
                .any(|parent: &NodeRef| node.path.starts_with(&parent.path))
            {
                nodes.push(node);
            }
        }
        for (path, epoch) in local_branches {
            if !nodes.iter().any(|parent| path.starts_with(&parent.path)) {
                queue.push_back((path, epoch));
            }
        }
    }
    nodes.sort_by(|a, b| a.path.cmp(&b.path));
    nodes.dedup_by(|a, b| a.path == b.path);
    let mut dates: BTreeMap<String, usize> = BTreeMap::new();
    for node in &nodes {
        for v in &node.versions {
            let count = dates.entry(v.date.clone()).or_default();
            if v.supported {
                *count += 1;
            }
        }
    }
    let id = transport::sha(
        &serde_json::to_vec(&(
            bounds,
            zoom,
            &nodes,
            &metadata
                .iter()
                .map(|m| &m.decoded_sha256)
                .collect::<Vec<_>>(),
        ))
        .unwrap(),
    );
    let catalog = Catalog {
        id,
        bounds,
        output_zoom: zoom,
        dates: dates
            .into_iter()
            .rev()
            .map(|(date, count)| DateEntry {
                date,
                supported_nodes: count,
                coverage_fraction: None,
            })
            .collect(),
        catalog_complete: complete && queue.is_empty(),
        scope: "AOI candidate nodes; date coverage not yet measured".into(),
        nodes,
        metadata,
        metadata_requests: network.requests,
    };
    std::fs::write(
        transport::directory()?.join(format!("catalog-{}.json", catalog.id)),
        serde_json::to_vec(&catalog).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    Ok(catalog)
}
