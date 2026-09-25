//! Synthetic HTTP imagery plus real polygon geometry exercises the complete
//! clipping/export contract without relying on a live map provider.
use geod_core::{exporter, pipeline};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use serde_json::{json, Value};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

static JOBS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const TILE_COLOR: [u8; 3] = [46, 112, 69];

struct ImageService {
    address: SocketAddr,
    stopped: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    worker: Option<JoinHandle<()>>,
}

impl ImageService {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let mut body = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(RgbImage::from_pixel(256, 256, Rgb(TILE_COLOR)))
            .write_to(&mut body, ImageFormat::Png)
            .unwrap();
        let body = body.into_inner();
        let worker = thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                let (mut stream, _) = match listener.accept() {
                    Ok(stream) => stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_millis(500)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_millis(500)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while request.len() < 8192 && !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(length) => request.extend_from_slice(&buffer[..length]),
                    }
                }
                let request = String::from_utf8_lossy(&request);
                let route = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1));
                count.fetch_add(1, Ordering::Relaxed);
                let (status, bytes): (&str, &[u8]) = if route == Some("/2/2/1.png") {
                    ("200 OK", &body)
                } else {
                    ("404 Not Found", b"")
                };
                let header = format!("HTTP/1.1 {status}\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len());
                if stream.write_all(header.as_bytes()).is_ok() {
                    let _ = stream.write_all(bytes);
                }
            }
        });
        Self {
            address,
            stopped,
            requests,
            worker: Some(worker),
        }
    }

    fn request(&self, format: &str) -> pipeline::Request {
        serde_json::from_value(json!({
            "schemaVersion":"1.0",
            "name":"Synthetic administrative polygon clipping fixture",
            // Entire AOI falls in tile z=2,x=2,y=1. Raster footprint is still
            // the whole 0..90 longitude / 0..66.513 latitude tile after masking.
            "bounds":[1.0,1.0,89.0,65.0],
            "imagery":{
                "url":format!("http://{}/{{z}}/{{x}}/{{y}}.png",self.address),
                "source":"local-clipping-test-fixture",
                "attribution":"Synthetic pixels for tests only",
                "zoom":2,"format":format,"concurrency":1,
                "clipToLayer":"boundary"
            },
            "vector":{"input":"boundary.geojson"},
            "limits":{"maxTiles":1,"maxPixels":65536,"timeoutSeconds":10}
        }))
        .unwrap()
    }
}

impl Drop for ImageService {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn write_boundaries(directory: &Path) -> Value {
    let data = json!({"type":"FeatureCollection","features":[
        {"type":"Feature","properties":{"layer":"boundary","name":"Mainland with lake","class":"test"},
         "geometry":{"type":"Polygon","coordinates":[
             [[10,10],[70,10],[70,50],[10,50],[10,10]],
             [[30,20],[30,35],[50,35],[50,20],[30,20]]
         ]}},
        {"type":"Feature","properties":{"layer":"boundary","name":"Separate island","class":"test"},
         "geometry":{"type":"MultiPolygon","coordinates":[[
             [[75,40],[80,40],[80,45],[75,45],[75,40]]
         ]]}},
        // This full-tile polygon must not leak into the boundary mask.
        {"type":"Feature","properties":{"layer":"landuse","name":"Non-mask layer","class":"test"},
         "geometry":{"type":"Polygon","coordinates":[
             [[1,1],[89,1],[89,65],[1,65],[1,1]]
         ]}}
    ]});
    fs::write(
        directory.join("boundary.geojson"),
        serde_json::to_vec(&data).unwrap(),
    )
    .unwrap();
    data
}

// Independent slippy-map projection: deliberately does not use the clipping
// module or tile helpers under test. Coordinates are well away from ring edges.
fn pixel_at(lon: f64, lat: f64) -> (u32, u32) {
    let latitude = lat.to_radians();
    let world_x = (lon + 180.0) / 360.0 * 1024.0;
    let world_y =
        (1.0 - (latitude.tan() + 1.0 / latitude.cos()).ln() / std::f64::consts::PI) * 512.0;
    (
        (world_x - 512.0).floor() as u32,
        (world_y - 256.0).floor() as u32,
    )
}

fn assert_masked_pixels(image: &RgbaImage) {
    assert_eq!(image.dimensions(), (256, 256));
    for (lon, lat, alpha) in [
        (15.0, 15.0, 255), // Inside mainland.
        (40.0, 28.0, 0),   // Inside the polygon's hole.
        (80.0, 15.0, 0),   // Outside target layer, inside non-mask landuse.
        (77.0, 43.0, 255), // Separate polygon in the same layer is included.
        (2.0, 2.0, 0),     // Outside every boundary polygon.
    ] {
        let (x, y) = pixel_at(lon, lat);
        let pixel = image.get_pixel(x, y).0;
        assert_eq!(pixel[3], alpha, "wrong alpha at lon={lon},lat={lat}");
        if alpha == 255 {
            assert_eq!(
                &pixel[..3],
                &TILE_COLOR,
                "interior pixels must retain source color"
            );
        }
    }
    let transparent = image.pixels().filter(|pixel| pixel[3] == 0).count();
    let opaque = image.pixels().filter(|pixel| pixel[3] == 255).count();
    assert!(transparent > 1000 && opaque > 1000);
}

#[tokio::test]
async fn clipping_survives_http_acquisition_geotiff_and_png_export_with_holes() {
    let _guard = JOBS.lock().await;
    let service = ImageService::start();
    let directory = tempfile::tempdir().unwrap();
    let original = write_boundaries(directory.path());
    for format in ["geotiff", "png"] {
        let output = directory.path().join(format);
        let manifest = tokio::time::timeout(
            Duration::from_secs(15),
            pipeline::fetch(service.request(format), directory.path(), &output),
        )
        .await
        .expect("bounded clipping job must finish")
        .unwrap();
        assert_eq!(manifest.quality.status, "complete");
        assert_eq!(manifest.quality.missing_tiles, 0);
        let saved = pipeline::inspect(&output).unwrap();
        let raster = saved.assets.iter().find(|a| a.id == "imagery").unwrap();
        let preview_asset = saved
            .assets
            .iter()
            .find(|a| a.id == "imagery-preview")
            .unwrap();
        assert_eq!(raster.crs, "EPSG:3857");
        assert_eq!((raster.width, raster.height), (Some(256), Some(256)));
        assert_eq!(raster.bounds, preview_asset.bounds);
        assert_eq!(&raster.bounds[..3], &[0.0, 0.0, 90.0]);
        assert!((raster.bounds[3] - 66.51326044311186).abs() < 1e-9);

        let preview = image::open(output.join(&preview_asset.path)).unwrap();
        assert_eq!(
            preview.color(),
            image::ColorType::Rgba8,
            "preview must carry real alpha"
        );
        assert_masked_pixels(&preview.to_rgba8());
        if format == "geotiff" {
            let mut decoder =
                Decoder::new(fs::File::open(output.join(&raster.path)).unwrap()).unwrap();
            assert_eq!(decoder.dimensions().unwrap(), (256, 256));
            assert_eq!(decoder.get_tag_u32(Tag::SamplesPerPixel).unwrap(), 4);
            assert_eq!(
                decoder.get_tag_u32(Tag::ExtraSamples).unwrap(),
                2,
                "RGBA TIFF needs explicit unassociated alpha, not an unspecified fourth band"
            );
            assert_eq!(decoder.colortype().unwrap(), tiff::ColorType::RGBA(8));
            let keys = decoder.get_tag_u16_vec(Tag::GeoKeyDirectoryTag).unwrap();
            assert!(keys[4..]
                .chunks_exact(4)
                .any(|key| key == [3072, 0, 1, 3857]));
            let scale = decoder.get_tag_f64_vec(Tag::ModelPixelScaleTag).unwrap();
            let tie = decoder.get_tag_f64_vec(Tag::ModelTiepointTag).unwrap();
            let quarter_world = std::f64::consts::PI * 6_378_137.0 / 2.0;
            assert!((scale[0] - quarter_world / 256.0).abs() < 1e-6);
            assert!((scale[1] - quarter_world / 256.0).abs() < 1e-6);
            assert!(tie[3].abs() < 1e-6);
            assert!((tie[4] - quarter_world).abs() < 1e-6);
            let DecodingResult::U8(pixels) = decoder.read_image().unwrap() else {
                panic!("expected RGBA8 GeoTIFF");
            };
            assert_masked_pixels(&RgbaImage::from_raw(256, 256, pixels).unwrap());
        } else {
            let png = image::open(output.join(&raster.path)).unwrap();
            assert_eq!(png.color(), image::ColorType::Rgba8);
            assert_masked_pixels(&png.to_rgba8());
        }

        // clipToLayer controls imagery only: all supplied vector features and
        // their full ring coordinates must still be present for later editing.
        let vectors: Value =
            serde_json::from_slice(&fs::read(output.join("data.geojson")).unwrap()).unwrap();
        assert_eq!(vectors["features"].as_array().unwrap().len(), 3);
        for (saved, source) in vectors["features"]
            .as_array()
            .unwrap()
            .iter()
            .zip(original["features"].as_array().unwrap())
        {
            assert_eq!(saved["geometry"], source["geometry"]);
        }
    }
    assert_eq!(service.requests.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn jpeg_cannot_silently_discard_requested_transparency() {
    let _guard = JOBS.lock().await;
    let service = ImageService::start();
    let directory = tempfile::tempdir().unwrap();
    write_boundaries(directory.path());
    let output = directory.path().join("jpeg-must-not-publish");
    let error = pipeline::fetch(service.request("jpeg"), directory.path(), &output)
        .await
        .unwrap_err();
    assert!(error.to_lowercase().contains("jpeg"), "{error}");
    assert!(!output.exists());
    assert_eq!(
        service.requests.load(Ordering::Relaxed),
        0,
        "reject lossy alpha choices before requesting imagery"
    );
}

#[test]
fn rgba_tiff_encoders_declare_straight_alpha_for_each_compression_mode() {
    let mut image = RgbaImage::from_pixel(2, 1, Rgba([200, 100, 40, 0]));
    image.put_pixel(1, 0, Rgba([200, 100, 40, 128]));
    for compression in ["lzw", "deflate", "none"] {
        let bytes = exporter::export_rgba_tiff_bytes(&image, None, compression).unwrap();
        let mut decoder = Decoder::new(Cursor::new(bytes)).unwrap();
        assert_eq!(
            decoder.get_tag_u32(Tag::ExtraSamples).unwrap(),
            2,
            "missing straight-alpha semantics for {compression}"
        );
        let DecodingResult::U8(decoded) = decoder.read_image().unwrap() else {
            panic!("expected RGBA8");
        };
        assert_eq!(decoded, image.as_raw().as_slice());
    }
}
