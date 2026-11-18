//! Explicit bounded Overpass snapshots. Only image tiles cross the preview IPC.
use super::raster::{RasterConfig, RasterTile};
use super::{register, validate_bounds, Bounds};
use crate::commands::PolygonCoord;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

struct Snapshot {
    features: Vec<(Bounds, Value)>,
    bytes: usize,
}
static SNAPSHOTS: OnceLock<Mutex<HashMap<String, Arc<Snapshot>>>> = OnceLock::new();

#[derive(Serialize)]
pub struct PreviewResult {
    pub id: String,
    pub feature_count: usize,
}

fn geometry_bounds(geometry: &Value) -> Option<Bounds> {
    fn visit(value: &Value, result: &mut Bounds) {
        let Some(items) = value.as_array() else {
            return;
        };
        if items.len() >= 2 && items[0].is_number() && items[1].is_number() {
            if let (Some(x), Some(y)) = (items[0].as_f64(), items[1].as_f64()) {
                result.west = result.west.min(x);
                result.east = result.east.max(x);
                result.south = result.south.min(y);
                result.north = result.north.max(y);
            }
        } else {
            for item in items {
                visit(item, result);
            }
        }
    }
    let mut result = Bounds {
        west: f64::INFINITY,
        south: f64::INFINITY,
        east: f64::NEG_INFINITY,
        north: f64::NEG_INFINITY,
    };
    visit(&geometry["coordinates"], &mut result);
    result.west.is_finite().then_some(result)
}

#[tauri::command]
pub async fn osm_preview_load(
    request_id: String,
    bounds: Bounds,
    feature_type: String,
    proxy: Option<String>,
    polygon: Option<Vec<PolygonCoord>>,
) -> Result<PreviewResult, String> {
    validate_bounds(bounds)?;
    let polygon = polygon.map(|points| {
        points
            .into_iter()
            .map(|p| (p.lat, p.lng))
            .collect::<Vec<_>>()
    });
    if let Some(points) = &polygon {
        if points.len() < 3
            || points.len() > 5000
            || points.iter().any(|(lat, lng)| {
                !lat.is_finite() || !lng.is_finite() || lat.abs() > 90. || lng.abs() > 180.
            })
        {
            return Err("OSM_PREVIEW: invalid polygon".into());
        }
    }
    if ![
        "roads",
        "buildings",
        "waterways",
        "landuse",
        "pois",
        "railways",
        "natural",
    ]
    .contains(&feature_type.as_str())
    {
        return Err("OSM_PREVIEW: invalid feature type".into());
    }
    if (bounds.east - bounds.west) * (bounds.north - bounds.south) > 0.04 {
        return Err("预览范围过大，请缩小选区或放大地图后重试".into());
    }
    let (_guard, cancel) = register(&request_id)?;
    let geojson = tokio::select! {
        _ = cancel.cancelled() => return Err(super::cancelled()),
        result = crate::admin::download_osm_features(bounds.south, bounds.west, bounds.north, bounds.east, &feature_type, proxy.as_deref(), polygon.as_deref()) => result?
    };
    let bytes = serde_json::to_vec(&geojson)
        .map_err(|_| "OSM_PREVIEW: invalid data")?
        .len();
    let features = geojson["features"]
        .as_array()
        .ok_or("OSM_PREVIEW: missing features")?;
    if bytes > 32 * 1024 * 1024 || features.len() > 50_000 {
        return Err("预览要素过多，请缩小范围；完整数据可使用下载功能".into());
    }
    let count = features.len();
    let features = features
        .iter()
        .filter_map(|f| geometry_bounds(&f["geometry"]).map(|b| (b, f.clone())))
        .collect();
    let mut snapshots = SNAPSHOTS.get_or_init(Default::default).lock().unwrap();
    if snapshots.len() >= 8
        || snapshots.values().map(|s| s.bytes).sum::<usize>() + bytes > 64 * 1024 * 1024
    {
        return Err("预览缓存已满，请移除已有 OSM 预览后重试".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    snapshots.insert(id.clone(), Arc::new(Snapshot { features, bytes }));
    Ok(PreviewResult {
        id,
        feature_count: count,
    })
}

#[tauri::command]
pub fn osm_preview_remove(id: String) {
    SNAPSHOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(&id);
}

#[tauri::command]
pub async fn osm_preview_tile(
    request_id: String,
    id: String,
    config: RasterConfig,
    z: u8,
    x: u32,
    y: u32,
) -> Result<RasterTile, String> {
    let (_guard, cancel) = register(&request_id)?;
    // Validate before projection and shifts.
    if !(8..=22).contains(&z)
        || x >= 1u32 << (z - 1)
        || y >= 1u32 << (z - 1)
        || config.layers.len() != 1
    {
        return Err("FOUNDATION_BOUNDS: invalid preview tile".into());
    }
    let snapshot = SNAPSHOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("OSM_PREVIEW: preview expired, reload it")?;
    let b = super::raster::bounds(&config, z, x, y);
    let features = snapshot
        .features
        .iter()
        .filter(|(f, _)| {
            f.west <= b.east && f.east >= b.west && f.south <= b.north && f.north >= b.south
        })
        .map(|(_, f)| f.clone())
        .collect();
    super::raster::render_snapshot(&id, config, features, z, x, y, &cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_include_all_polygon_rings_and_points() {
        let b = geometry_bounds(
            &serde_json::json!({"coordinates":[[[1,2],[4,5],[1,2]],[[2,3],[3,4],[2,3]]]}),
        )
        .unwrap();
        assert_eq!((b.west, b.south, b.east, b.north), (1., 2., 4., 5.));
        assert!(geometry_bounds(&serde_json::json!({"coordinates":[]})).is_none());
    }

    #[tokio::test]
    async fn snapshots_render_png_cache_and_release_without_returning_features() {
        use base64::Engine;
        let features = serde_json::json!([
            {"type":"Feature","properties":{"name":"道路"},"geometry":{"type":"LineString","coordinates":[[116.4,39.9],[116.401,39.901]]}},
            {"type":"Feature","properties":{"name":"兴趣点"},"geometry":{"type":"Point","coordinates":[116.4,39.9]}},
            {"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[116.4,39.9],[116.401,39.9],[116.401,39.901],[116.4,39.9]]]}}
        ]);
        let id = uuid::Uuid::new_v4().to_string();
        let items = features
            .as_array()
            .unwrap()
            .iter()
            .map(|f| (geometry_bounds(&f["geometry"]).unwrap(), f.clone()))
            .collect();
        SNAPSHOTS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(
                id.clone(),
                Arc::new(Snapshot {
                    features: items,
                    bytes: 1024,
                }),
            );
        let config = RasterConfig {
            layers: vec![super::super::raster::RasterStyle {
                layer: super::super::Layer::Roads,
                color: "#e89c32".into(),
                width: 2,
                labels: true,
            }],
            font_size: 12,
            gcj: false,
            revision: 0,
        };
        let z = 16;
        let x = ((116.4_f64 + 180.) / 360. * 32768.).floor() as u32;
        let y = ((1. - 39.9_f64.to_radians().tan().asinh() / std::f64::consts::PI) / 2. * 32768.)
            .floor() as u32;
        let first = osm_preview_tile(
            uuid::Uuid::new_v4().to_string(),
            id.clone(),
            config.clone(),
            z,
            x,
            y,
        )
        .await
        .unwrap();
        let png = base64::engine::general_purpose::STANDARD
            .decode(first.data_url.split_once(',').unwrap().1)
            .unwrap();
        let image = tiny_skia::Pixmap::decode_png(&png).unwrap();
        assert_eq!((image.width(), image.height()), (512, 512));
        assert!(image.pixels().iter().any(|p| p.alpha() > 0));
        assert!(!serde_json::to_string(&first)
            .unwrap()
            .contains("FeatureCollection"));
        let next = osm_preview_tile(
            uuid::Uuid::new_v4().to_string(),
            id.clone(),
            config.clone(),
            z,
            x,
            y,
        )
        .await
        .unwrap();
        assert!(next.cache_hit);
        osm_preview_remove(id.clone());
        assert!(
            osm_preview_tile(uuid::Uuid::new_v4().to_string(), id, config, z, x, y)
                .await
                .is_err()
        );
    }
}
