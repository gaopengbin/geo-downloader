use super::*;
use image::{ImageFormat, Rgba, RgbaImage};
use std::{collections::HashMap, io::Cursor};

#[test]
fn date_encoding_is_calendar_checked_and_matches_observed_requests() {
    assert_eq!(catalog::pack_date("2026-03-06").unwrap(), 1_037_414);
    assert_eq!(catalog::pack_date("2026-07-14").unwrap(), 1_037_550);
    assert!(catalog::pack_date("2024-02-29").is_ok());
    for invalid in [
        "2025-02-29",
        "2026-00-01",
        "2026-03-32",
        "2026-3-06",
        "0001-01-01",
    ] {
        assert!(catalog::pack_date(invalid).is_err());
    }
}
#[test]
fn protocol_framing_and_destination_reject_error_documents_and_aliases() {
    for invalid in [
        &b"<html>error</html>"[..],
        &[0],
        &[0x0a, 100, 1],
        &[0x08, 0xff],
        &[0xff; 12],
    ] {
        assert!(wire::parse(invalid).is_err());
        assert!(decoder::decode(invalid).is_err());
    }
    assert!(transport::allowed(
        "https://kh.google.com/rt/tm/earth/PlanetoidMetadata"
    ));
    for url in [
        "http://kh.google.com/rt/tm/earth/PlanetoidMetadata",
        "https://kh.google.com/rt/earth/PlanetoidMetadata",
        "https://kh.google.com.evil.test/rt/tm/earth/NodeData/pb=x",
        "https://user@kh.google.com/rt/tm/earth/PlanetoidMetadata",
        "https://kh.google.com/rt/tm/earth/PlanetoidMetadata?token=private",
    ] {
        assert!(!transport::allowed(url));
    }
    assert!(planner::parse_tile_url(&format!("earth-history://{}/17/1/2", "a".repeat(64))).is_ok());
    assert!(planner::parse_tile_url("earth-history://../../0/0/0").is_err());
    assert!(planner::parse_tile_url(&format!("earth-history://{}/2/4/0", "a".repeat(64))).is_err());
}
#[test]
fn decompression_is_single_pass_and_has_an_expansion_bound() {
    use std::io::Write;
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&[8, 1]).unwrap();
    let raw = gzip.finish().unwrap();
    assert_eq!(transport::decode_body(&raw).unwrap(), vec![8, 1]);
    assert!(transport::decode_body(&raw[..raw.len() - 3]).is_err());
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let block = vec![0u8; 1024 * 1024];
    for _ in 0..33 {
        gzip.write_all(&block).unwrap();
    }
    assert!(transport::decode_body(&gzip.finish().unwrap()).is_err());
}
#[test]
fn provider_coverage_alpha_survives_geotiff_png_and_polygon_cropping() {
    let mut image = RgbaImage::from_pixel(256, 256, Rgba([30, 80, 120, 255]));
    image.put_pixel(128, 128, Rgba([255, 20, 30, 0]));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Png).unwrap();
    let files = HashMap::from([(
        (0, 0),
        crate::merger::TileSource::from_bytes(bytes.into_inner()),
    )]);
    let bounds = crate::tile::TileBounds {
        west: 0.,
        south: 0.,
        east: 1.,
        north: 1.,
    };
    let polygon = vec![vec![
        crate::merger::PolygonPoint { lat: 0., lng: 0. },
        crate::merger::PolygonPoint { lat: 1., lng: 0. },
        crate::merger::PolygonPoint { lat: 1., lng: 1. },
        crate::merger::PolygonPoint { lat: 0., lng: 1. },
    ]];
    let dir = tempfile::tempdir().unwrap();
    let tiff = dir.path().join("coverage.tif");
    let png = dir.path().join("coverage.png");
    crate::streaming_tiff::merge_and_export_streaming(
        &files,
        0,
        0,
        0,
        0,
        &bounds,
        &tiff,
        "lzw",
        Some(&polygon),
    )
    .unwrap();
    crate::streaming_raster::merge_and_export_streaming_png(
        &files,
        0,
        0,
        0,
        0,
        &bounds,
        &png,
        Some(&polygon),
    )
    .unwrap();
    let png = image::open(png).unwrap().to_rgba8();
    assert_eq!(png.get_pixel(128, 128).0, [0, 0, 0, 0]);
    assert_eq!(png.get_pixel(100, 100)[3], 255);
    let mut reader = tiff::decoder::Decoder::new(std::fs::File::open(tiff).unwrap()).unwrap();
    let tiff::decoder::DecodingResult::U8(data) = reader.read_image().unwrap() else {
        panic!("not byte RGBA")
    };
    assert_eq!(
        &data[(128 * 256 + 128) * 4..(128 * 256 + 128) * 4 + 4],
        &[0, 0, 0, 0]
    );
    assert_eq!(data[(100 * 256 + 100) * 4 + 3], 255);
}
