use super::super::tests::{mock, Mock, Reply};
use super::*;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

fn config(labels: bool) -> RasterConfig {
    RasterConfig {
        layers: vec![RasterStyle {
            layer: Layer::Settlements,
            color: "#df6262".into(),
            width: 2,
            labels,
        }],
        font_size: 12,
        gcj: false,
        revision: 0,
    }
}
fn source(mock: &Mock) -> Source {
    Source {
        client: mock.source.client.clone(),
        endpoint: mock.source.endpoint.clone(),
        cache: mock.cache.path().join("wfs"),
        page_size: mock.source.page_size,
        cache_read: true,
    }
}
fn coords(lng: f64, lat: f64, z: u8) -> (u32, u32) {
    let (px, py) = project(lng, lat, z);
    (
        (px / SIZE as f64).floor() as u32,
        (py / SIZE as f64).floor() as u32,
    )
}

#[test]
fn valid_config_projection_and_style_identity() {
    let mut value = config(true);
    let (x, y) = coords(116.3, 39.9, 12);
    value.validate(12, x, y).unwrap();
    assert!(value.validate(7, x, y).is_err());
    assert!(value.validate(12, 1 << 11, y).is_err());
    let mut bad = config(true);
    bad.layers.push(bad.layers[0].clone());
    assert!(bad.validate(12, x, y).is_err());
    for bad_color in ["red", "#fff", "#12345<", "#1234567"] {
        let mut bad = config(true);
        bad.layers[0].color = bad_color.into();
        assert!(bad.validate(12, x, y).is_err());
    }
    let base = wgs_to_gcj(116.397128, 39.916527);
    assert!((base.0 - 116.403372).abs() < 0.000002);
    assert!((base.1 - 39.917931).abs() < 0.000002);
    let original = gcj_to_wgs(base.0, base.1);
    assert!((original.0 - 116.397128).abs() < 1e-8);
    assert!((original.1 - 39.916527).abs() < 1e-8);
    let area = bounds(&value, 12, x, y);
    super::super::validate_bounds(area).unwrap();
    assert!(area.west < 116.3 && area.east > 116.3 && area.south < 39.9 && area.north > 39.9);
}
#[test]
fn png_is_transparent_and_original_vectors_are_unchanged() {
    let c = config(false);
    let (x, y) = coords(116.3, 39.9, 12);
    let (lng, lat) = unproject(
        (x as f64 + 0.5) * SIZE as f64,
        (y as f64 + 0.5) * SIZE as f64,
        12,
    );
    let feature = json!({"type":"Feature","id":"point.1","properties":{"NAME":"任固镇"},"geometry":{"type":"Point","coordinates":[lng,lat]}});
    let input = vec![(c.layers[0].clone(), vec![feature.clone()])];
    let value = draw::render(&input, &c, 12, x, y, &CancellationToken::new()).unwrap();
    assert!(!value.empty);
    let image = tiny_skia::Pixmap::decode_png(&value.png).unwrap();
    assert_eq!((image.width(), image.height()), (512, 512));
    assert_eq!(image.pixel(0, 0).unwrap().alpha(), 0);
    assert!(image.pixel(256, 256).unwrap().red() > image.pixel(256, 256).unwrap().blue());
    assert_eq!(input[0].1[0], feature);
    let mut blue = c.clone();
    blue.layers[0].color = "#3185d6".into();
    let data = vec![(blue.layers[0].clone(), vec![feature])];
    let other = draw::render(&data, &blue, 12, x, y, &CancellationToken::new()).unwrap();
    assert_ne!(value.png, other.png);
    let stop = CancellationToken::new();
    stop.cancel();
    assert!(matches!(draw::render(&input,&c,12,x,y,&stop),Err(error) if error==cancelled()));
}
#[test]
fn neighbouring_tiles_use_the_same_world_line_label_anchors() {
    let c = config(false);
    let (x, y) = coords(116.3, 39.9, 12);
    let a = unproject(
        x as f64 * SIZE as f64 - 1000.,
        y as f64 * SIZE as f64 + 200.,
        12,
    );
    let b = unproject(
        x as f64 * SIZE as f64 + 2000.,
        y as f64 * SIZE as f64 + 200.,
        12,
    );
    let line = json!([[a.0, a.1], [b.0, b.1]]);
    let first = draw::line_anchors(&line, &c, 12, x, y, (SIZE + 2 * PAD) as f32);
    let second = draw::line_anchors(&line, &c, 12, x + 1, y, (SIZE + 2 * PAD) as f32);
    let overlap = first
        .iter()
        .filter(|p| p.0 >= SIZE as f32 && p.0 <= SIZE as f32 + 2. * PAD as f32)
        .collect::<Vec<_>>();
    assert!(!overlap.is_empty());
    for p in overlap {
        assert!(second
            .iter()
            .any(|q| (p.0 - q.0 - SIZE as f32).abs() < 0.05 && (p.1 - q.1).abs() < 0.05));
    }
}
#[tokio::test]
async fn raster_requests_coalesce_cache_and_preserve_paginated_completeness() {
    let mock = mock(Reply::Pages).await;
    let (x, y) = coords(116.3, 39.9, 12);
    let cancel = CancellationToken::new();
    let c = config(false);
    let (a, b) = tokio::join!(
        tile(source(&mock), c.clone(), 12, x, y, &cancel),
        tile(source(&mock), c.clone(), 12, x, y, &cancel)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.data_url, b.data_url);
    assert!(a.cache_hit || b.cache_hit);
    assert_eq!(mock.count.load(Ordering::SeqCst), 2);
    assert!(a.data_url.starts_with("data:image/png;base64,"));
    let reply = serde_json::to_value(&a).unwrap();
    assert!(reply.get("features").is_none() && reply.get("geojson").is_none());
    let disk = mock.cache.path().join("foundation-raster-v1");
    assert_eq!(std::fs::read_dir(&disk).unwrap().count(), 1);
    let other = tile(source(&mock), c, 12, x, y, &cancel).await.unwrap();
    assert!(other.cache_hit);
    assert_eq!(mock.count.load(Ordering::SeqCst), 2);
    let bad = super::super::tests::mock(Reply::Repeat).await;
    assert!(tile(source(&bad), config(false), 12, x, y, &cancel)
        .await
        .is_err());
    assert!(!bad.cache.path().join("foundation-raster-v1").exists());
}
#[tokio::test]
async fn raster_cancellation_stops_waiting_and_does_not_save_a_tile() {
    let mock = mock(Reply::Slow).await;
    let (x, y) = coords(116.3, 39.9, 12);
    let token = CancellationToken::new();
    let stop = token.clone();
    let cancelling = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        stop.cancel();
    });
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        tile(source(&mock), config(false), 12, x, y, &token),
    )
    .await
    .unwrap();
    assert!(matches!(result,Err(error) if error==cancelled()));
    cancelling.await.unwrap();
    assert!(!mock.cache.path().join("foundation-raster-v1").exists());
}
#[test]
fn disk_cache_rejects_corruption_and_does_not_modify_unrecognized_files() {
    let directory = tempfile::tempdir().unwrap();
    let key = "a".repeat(64);
    let path = directory.path().join(format!("{key}.tile"));
    std::fs::write(&path, b"invalid").unwrap();
    assert!(read_disk(directory.path(), &key).is_none());
    let unknown = directory.path().join("user-content.txt");
    std::fs::write(&unknown, b"preserve").unwrap();
    let c = config(false);
    let (x, y) = coords(116.3, 39.9, 12);
    let tile = draw::render(&[], &c, 12, x, y, &CancellationToken::new()).unwrap();
    write_disk(directory.path(), &key, &tile);
    let cached = read_disk(directory.path(), &key).unwrap();
    assert!(cached.empty);
    assert_eq!(cached.png, tile.png);
    assert_eq!(std::fs::read(&unknown).unwrap(), b"preserve");
}
#[tokio::test]
#[ignore = "Real WFS raster acceptance, system CJK font, fixed QA directory; no user settings or publication"]
async fn live_raster_tiles() {
    let out = std::path::PathBuf::from(std::env::var("GEOD_FOUNDATION_QA_OUTPUT").unwrap());
    std::fs::create_dir_all(&out).unwrap();
    let mut c = config(true);
    c.layers = vec![
        RasterStyle {
            layer: Layer::Water,
            color: "#3185d6".into(),
            width: 2,
            labels: true,
        },
        RasterStyle {
            layer: Layer::Roads,
            color: "#e89c32".into(),
            width: 2,
            labels: true,
        },
        RasterStyle {
            layer: Layer::Railways,
            color: "#a17ada".into(),
            width: 2,
            labels: true,
        },
        c.layers[0].clone(),
    ];
    let (x, y) = coords(114.63, 35.95, 12);
    let mut source = Source::new(None).unwrap();
    source.cache = out.join("wfs");
    let started = Instant::now();
    let tile = tile(source, c, 12, x, y, &CancellationToken::new())
        .await
        .unwrap();
    let png = base64::engine::general_purpose::STANDARD
        .decode(tile.data_url.split_once(',').unwrap().1)
        .unwrap();
    std::fs::write(out.join("raster-four-layers.png"), &png).unwrap();
    assert!(!tile.empty);
    assert!(tile.font_available);
    let normal = json!({"z":12,"x":x,"y":y,"bytes":png.len(),"fontAvailable":tile.font_available,"cacheHit":tile.cache_hit,"seconds":started.elapsed().as_secs_f64()});
    let (x, y) = coords(114.63, 35.95, 8);
    let mut source = Source::new(None).unwrap();
    source.cache = out.join("wfs");
    let dense = config(true);
    let area = bounds(&dense, 8, x, y);
    let (page, _) = source
        .page(Layer::Settlements, area, 0, &CancellationToken::new())
        .await
        .unwrap();
    let matched = page.matched;
    let started = Instant::now();
    let image = super::tile(source, dense, 8, x, y, &CancellationToken::new())
        .await
        .unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image.data_url.split_once(',').unwrap().1)
        .unwrap();
    std::fs::write(out.join("raster-dense-points.png"), &bytes).unwrap();
    assert!(!image.empty);
    assert!(image.font_available);
    let dense = json!({"z":8,"x":x,"y":y,"matched":matched,"bytes":bytes.len(),"cacheHit":image.cache_hit,"seconds":started.elapsed().as_secs_f64()});
    std::fs::write(
        out.join("raster-proof.json"),
        serde_json::to_vec_pretty(&json!({"fourLayers":normal,"densePoints":dense})).unwrap(),
    )
    .unwrap();
}
