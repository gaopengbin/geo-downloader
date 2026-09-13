//! Exercise actual HTTP acquisition and published files, using an explicitly
//! synthetic XYZ service so these tests do not require external map providers.

use geod_core::pipeline::{self, Manifest, Request};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::json;
use sha2::{Digest, Sha256};
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

// The shared downloader has process-global cache/active-download state.
// Serialize these jobs while still testing them through real async HTTP calls.
static JOBS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const LEFT: [u8; 3] = [40, 90, 130];
const RIGHT: [u8; 3] = [150, 60, 20];

#[derive(Clone, Copy)]
enum Mode {
    Complete,
    MissingRight,
    InvalidRight,
}

struct XyzFixture {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    worker: Option<JoinHandle<()>>,
}

impl XyzFixture {
    fn start(mode: Mode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let requests = Arc::new(AtomicUsize::new(0));
        let request_count = requests.clone();
        let left = png(LEFT);
        let right = png(RIGHT);
        let worker = thread::spawn(move || {
            while !stopping.load(Ordering::Acquire) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                };
                stream.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
                stream.set_write_timeout(Some(Duration::from_millis(500))).unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while request.len() < 8192 && !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buffer[..n]),
                    }
                }
                let request = String::from_utf8_lossy(&request);
                let path = request.lines().next().and_then(|line| line.split_whitespace().nth(1));
                let (status, body): (&str, &[u8]) = match path {
                    Some("/1/0/0.png") => ("200 OK", &left),
                    Some("/1/1/0.png") => match mode {
                        Mode::Complete => ("200 OK", &right),
                        Mode::MissingRight => ("404 Not Found", b""),
                        Mode::InvalidRight => ("200 OK", b"this is an upstream HTML error, not an image"),
                    },
                    _ => ("404 Not Found", b""),
                };
                request_count.fetch_add(1, Ordering::Relaxed);
                let header = format!("HTTP/1.1 {status}\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                if stream.write_all(header.as_bytes()).is_ok() {
                    let _ = stream.write_all(body);
                }
            }
        });
        Self { address, stop, requests, worker: Some(worker) }
    }

    fn request(&self, allow_missing: bool) -> Request {
        serde_json::from_value(json!({
            "schemaVersion": "1.0",
            "name": "Synthetic XYZ integration fixture",
            // Two columns in the northern hemisphere at zoom 1.
            "bounds": [-1.0, 1.0, 1.0, 2.0],
            "imagery": {
                "url": format!("http://{}/{{z}}/{{x}}/{{y}}.png", self.address),
                "source": "deterministic-local-test-fixture",
                "attribution": "Synthetic pixels generated only for automated tests",
                "zoom": 1,
                "format": "geotiff",
                "concurrency": 1,
                "allowMissing": allow_missing
            },
            "limits": {"maxTiles": 2, "maxPixels": 131072, "timeoutSeconds": 10}
        })).unwrap()
    }
}

impl Drop for XyzFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn png(color: [u8; 3]) -> Vec<u8> {
    let mut encoded = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(256, 256, Rgb(color)))
        .write_to(&mut encoded, ImageFormat::Png).unwrap();
    encoded.into_inner()
}

async fn fetch(request: Request, base: &Path, output: &Path) -> Result<Manifest, String> {
    tokio::time::timeout(Duration::from_secs(15), pipeline::fetch(request, base, output))
        .await.expect("fixture job must terminate within 15 seconds")
}

fn assert_no_staging(parent: &Path) {
    for entry in fs::read_dir(parent).unwrap() {
        let name = entry.unwrap().file_name();
        assert!(!name.to_string_lossy().starts_with(".geod-stage-"), "failed/published jobs must clean their stage directory");
    }
}

#[tokio::test]
async fn publishes_hashes_pixels_and_geotiff_mercator_tags() {
    let _guard = JOBS.lock().await;
    let service = XyzFixture::start(Mode::Complete);
    let temp = tempfile::tempdir().unwrap();
    let output = temp.path().join("result");
    let manifest = fetch(service.request(false), temp.path(), &output).await.unwrap();
    assert_eq!(service.requests.load(Ordering::Relaxed), 2);
    assert_eq!(manifest.quality.status, "complete");
    assert_eq!(manifest.quality.missing_tiles, 0);
    assert_eq!(manifest.assets.len(), 2);
    assert_eq!(manifest.bounds, [-1.0, 1.0, 1.0, 2.0]);
    assert_eq!(manifest.provenance[0].source, "deterministic-local-test-fixture");
    for asset in &manifest.assets {
        let bytes = fs::read(output.join(&asset.path)).unwrap();
        assert_eq!(asset.bytes, bytes.len() as u64);
        assert_eq!(asset.sha256, format!("{:x}", Sha256::digest(&bytes)));
    }
    let saved = pipeline::inspect(&output).unwrap();
    assert_eq!(saved.id, manifest.id);
    let raster = saved.assets.iter().find(|asset| asset.id == "imagery").unwrap();
    assert_eq!(raster.crs, "EPSG:3857");
    assert_eq!((raster.width, raster.height), (Some(512), Some(256)));
    assert_eq!(&raster.bounds[..3], &[-180.0, 0.0, 180.0]);
    assert!((raster.bounds[3] - 85.0511287798066).abs() < 1e-9);

    let mut decoder = Decoder::new(fs::File::open(output.join(&raster.path)).unwrap()).unwrap();
    assert_eq!(decoder.dimensions().unwrap(), (512, 256));
    let keys = decoder.get_tag_u16_vec(Tag::GeoKeyDirectoryTag).unwrap();
    assert!(keys[4..].chunks_exact(4).any(|key| key == [3072, 0, 1, 3857]));
    let scale = decoder.get_tag_f64_vec(Tag::ModelPixelScaleTag).unwrap();
    let tie = decoder.get_tag_f64_vec(Tag::ModelTiepointTag).unwrap();
    // Independent expected EPSG:3857 world extent, rather than the same tile
    // conversion helper used by the implementation under test.
    let half_world = std::f64::consts::PI * 6_378_137.0;
    assert!((scale[0] - half_world / 256.0).abs() < 1e-6);
    assert!((scale[1] - half_world / 256.0).abs() < 1e-6);
    assert!((tie[3] + half_world).abs() < 1e-6);
    assert!((tie[4] - half_world).abs() < 1e-6);
    let DecodingResult::U8(pixels) = decoder.read_image().unwrap() else { panic!("expected RGB8 GeoTIFF") };
    assert_eq!(&pixels[..3], &LEFT);
    assert_eq!(&pixels[256 * 3..256 * 3 + 3], &RIGHT);
    let preview = image::open(output.join("imagery-preview.png")).unwrap().to_rgb8();
    assert_eq!(preview.get_pixel(preview.width() / 4, preview.height() / 2).0, LEFT);
    assert_eq!(preview.get_pixel(preview.width() * 3 / 4, preview.height() / 2).0, RIGHT);
    assert_no_staging(temp.path());
}

#[tokio::test]
async fn missing_tiles_fail_without_publishing_a_partial_directory() {
    let _guard = JOBS.lock().await;
    let service = XyzFixture::start(Mode::MissingRight);
    let temp = tempfile::tempdir().unwrap();
    let output = temp.path().join("must-not-exist");
    let error = fetch(service.request(false), temp.path(), &output).await.unwrap_err();
    assert!(error.contains("MISSING_TILES"), "{error}");
    assert!(!output.exists());
    assert_eq!(service.requests.load(Ordering::Relaxed), 2, "404 must not enter the long retry queue");
    assert_no_staging(temp.path());
}

#[tokio::test]
async fn explicit_partial_results_report_white_gaps_and_remain_inspectable() {
    let _guard = JOBS.lock().await;
    let service = XyzFixture::start(Mode::MissingRight);
    let temp = tempfile::tempdir().unwrap();
    let output = temp.path().join("partial");
    let manifest = fetch(service.request(true), temp.path(), &output).await.unwrap();
    assert_eq!(manifest.quality.status, "partial");
    assert_eq!(manifest.quality.missing_tiles, 1);
    assert!(!manifest.quality.warnings.is_empty());
    assert_eq!(pipeline::inspect(&output).unwrap().quality.status, "partial");
    let preview = image::open(output.join("imagery-preview.png")).unwrap().to_rgb8();
    assert_eq!(preview.get_pixel(preview.width() / 4, preview.height() / 2).0, LEFT);
    assert_eq!(preview.get_pixel(preview.width() * 3 / 4, preview.height() / 2).0, [255, 255, 255]);
    assert_no_staging(temp.path());
}

#[tokio::test]
async fn http_success_with_invalid_image_bytes_is_not_a_complete_result() {
    let _guard = JOBS.lock().await;
    let service = XyzFixture::start(Mode::InvalidRight);
    let temp = tempfile::tempdir().unwrap();
    let output = temp.path().join("invalid");
    let error = fetch(service.request(false), temp.path(), &output).await.unwrap_err();
    assert!(error.contains("MISSING_TILES"), "{error}");
    assert!(!output.exists());
    assert_no_staging(temp.path());
}

#[tokio::test]
async fn existing_output_is_preserved_before_any_http_acquisition() {
    let _guard = JOBS.lock().await;
    let service = XyzFixture::start(Mode::Complete);
    let temp = tempfile::tempdir().unwrap();
    let output = temp.path().join("existing");
    fs::create_dir(&output).unwrap();
    fs::write(output.join("user.txt"), b"existing user content").unwrap();
    let error = fetch(service.request(false), temp.path(), &output).await.unwrap_err();
    assert!(error.contains("OUTPUT_EXISTS"), "{error}");
    assert_eq!(fs::read(output.join("user.txt")).unwrap(), b"existing user content");
    assert_eq!(fs::read_dir(&output).unwrap().count(), 1);
    assert_eq!(service.requests.load(Ordering::Relaxed), 0);
    assert_no_staging(temp.path());
}

#[tokio::test]
async fn inspect_detects_same_length_asset_corruption() {
    let _guard = JOBS.lock().await;
    let service = XyzFixture::start(Mode::Complete);
    let temp = tempfile::tempdir().unwrap();
    let output = temp.path().join("corrupted");
    fetch(service.request(false), temp.path(), &output).await.unwrap();
    let path = output.join("imagery-preview.png");
    let mut bytes = fs::read(&path).unwrap();
    let middle = bytes.len() / 2;
    bytes[middle] ^= 1;
    fs::write(path, bytes).unwrap();
    let error = pipeline::inspect(&output).unwrap_err();
    assert!(error.contains("ASSET_MISMATCH"), "{error}");
}

#[tokio::test]
async fn mixed_bundle_preserves_water_and_tourism_roles_from_local_geojson() {
    let _guard = JOBS.lock().await;
    let service = XyzFixture::start(Mode::Complete);
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("input.geojson"), serde_json::to_vec(&json!({
        "type":"FeatureCollection",
        "features":[
            {"type":"Feature","properties":{"name":"Fixture river","waterway":"river"},"geometry":{"type":"LineString","coordinates":[[-0.8,1.4],[0.8,1.4]]}},
            {"type":"Feature","properties":{"name":"Fixture museum","tourism":"museum"},"geometry":{"type":"Point","coordinates":[0.2,1.5]}},
            {"type":"Feature","properties":{"name":"Outside region","tourism":"attraction"},"geometry":{"type":"Point","coordinates":[20.0,20.0]}}
        ]
    })).unwrap()).unwrap();
    let mut request = service.request(false);
    request.vector = Some(serde_json::from_value(json!({"input":"input.geojson","layers":["water","tourism"]})).unwrap());
    let output = temp.path().join("mixed");
    let manifest = fetch(request, temp.path(), &output).await.unwrap();
    assert_eq!(manifest.provenance.len(), 2);
    assert_eq!(manifest.assets.iter().find(|asset| asset.id == "vectors").unwrap().feature_count, Some(2));
    assert!(manifest.layers.iter().any(|layer| layer.id == "waterway"));
    assert!(manifest.layers.iter().any(|layer| layer.id == "poi"));
    assert!(!manifest.layers.iter().any(|layer| layer.id == "transportation"));
    let geojson: serde_json::Value = serde_json::from_slice(&fs::read(output.join("data.geojson")).unwrap()).unwrap();
    assert_eq!(geojson["features"].as_array().unwrap().len(), 2);
    let river = geojson["features"].as_array().unwrap().iter().find(|feature| feature["properties"]["name"] == "Fixture river").unwrap();
    assert_eq!(river["properties"]["layer"], "waterway");
    assert_eq!(river["geometry"]["type"], "LineString");
    pipeline::inspect(&output).unwrap();
}
