use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::io::AsyncReadExt;

pub(super) enum Reply {
    Pages,
    Repeat,
    Empty,
    Malformed,
    Slow,
}
pub(super) struct Mock {
    pub(super) source: Source,
    pub(super) cache: tempfile::TempDir,
    pub(super) count: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub(super) async fn mock(reply: Reply) -> Mock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/wfs", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            seen.fetch_add(1, Ordering::SeqCst);
            if matches!(reply, Reply::Slow) {
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            let request = String::from_utf8_lossy(&bytes);
            let path = request.split_whitespace().nth(1).unwrap();
            let url = reqwest::Url::parse(&format!("http://local{path}")).unwrap();
            let start = url
                .query_pairs()
                .find(|(k, _)| k == "startIndex")
                .unwrap()
                .1
                .parse::<usize>()
                .unwrap();
            let features = if matches!(reply, Reply::Empty) {
                vec![]
            } else {
                (if matches!(reply,Reply::Repeat){0}else{start}..if matches!(reply,Reply::Repeat){2}else{(start+2).min(3)}).map(|i|json!({"type":"Feature","id":format!("sample.{i}"),"geometry":{"type":"Point","coordinates":[116.3+i as f64/100.,39.9]},"properties":{"NAME":format!("真实协议样例{i}")}})).collect::<Vec<_>>()
            };
            let body = if matches!(reply, Reply::Malformed) {
                b"<Exception>not JSON</Exception>".to_vec()
            } else {
                serde_json::to_vec(&json!({"type":"FeatureCollection","numberMatched":3,"features":features,"crs":{"properties":{"name":"urn:ogc:def:crs:EPSG::4326"}}})).unwrap()
            };
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&body).await;
        }
    });
    let cache = tempfile::tempdir().unwrap();
    let source = Source {
        client: Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap(),
        endpoint,
        cache: cache.path().into(),
        page_size: 2,
        cache_read: true,
    };
    Mock {
        source,
        cache,
        count,
        task,
    }
}
fn bounds() -> Bounds {
    Bounds {
        west: 116.2,
        south: 39.7,
        east: 116.6,
        north: 40.1,
    }
}

#[tokio::test]
async fn bounded_preview_reports_truncation_and_reuses_only_valid_pages() {
    let m = mock(Reply::Pages).await;
    let cancel = CancellationToken::new();
    let p = preview(&m.source, Layer::Settlements, bounds(), 2, &cancel)
        .await
        .unwrap();
    assert!(p.truncated);
    assert_eq!(p.feature_count, 2);
    assert_eq!(m.count.load(Ordering::SeqCst), 1);
    let p = preview(&m.source, Layer::Settlements, bounds(), 10, &cancel)
        .await
        .unwrap();
    assert!(!p.truncated);
    assert_eq!(p.feature_count, 3);
    assert_eq!((p.cache_hits, p.network_pages), (1, 1));
    let p = preview(&m.source, Layer::Settlements, bounds(), 10, &cancel)
        .await
        .unwrap();
    assert_eq!((p.cache_hits, p.network_pages), (2, 0));
    assert_eq!(m.count.load(Ordering::SeqCst), 2);
    assert!(m.cache.path().read_dir().unwrap().count() > 0);
}
#[tokio::test]
async fn export_is_complete_streamed_and_preserves_old_output_on_pagination_failure_or_cancel() {
    let m = mock(Reply::Pages).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("水系和道路.geojson");
    let result = export(
        &m.source,
        &[Layer::Water, Layer::Roads],
        bounds(),
        &path,
        &CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(result.features, 6);
    let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(value["features"].as_array().unwrap().len(), 6);
    assert_eq!(value["geod:provenance"]["crs"], "EPSG:4326");
    for reply in [Reply::Repeat, Reply::Empty, Reply::Malformed, Reply::Pages] {
        let cancel_after_page = matches!(reply, Reply::Pages);
        let bad = mock(reply).await;
        std::fs::write(&path, b"existing file").unwrap();
        let cancel = CancellationToken::new();
        let stopping = cancel.clone();
        assert!(export(
            &bad.source,
            &[Layer::Water],
            bounds(),
            &path,
            &cancel,
            |_| {
                if cancel_after_page {
                    stopping.cancel();
                }
            }
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"existing file");
        assert_eq!(dir.path().read_dir().unwrap().count(), 1);
    }
}
#[tokio::test]
async fn cancellation_drops_the_network_wait_and_cleans_request_registration() {
    let m = mock(Reply::Slow).await;
    let id = uuid::Uuid::new_v4().to_string();
    let (guard, token) = register(&id).unwrap();
    let stopping = token.clone();
    let cancelling = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        stopping.cancel();
    });
    let result = tokio::time::timeout(
        Duration::from_millis(500),
        preview(&m.source, Layer::Water, bounds(), 10, &token),
    )
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), cancelled());
    cancelling.await.unwrap();
    drop(guard);
    assert!(!REQUESTS.get().unwrap().lock().unwrap().contains_key(&id));
    assert!(register("invalid").is_err());
}
#[test]
fn rejects_invalid_bounds_crs_and_malformed_feature_collections() {
    assert!(validate_bounds(Bounds {
        west: f64::NAN,
        ..bounds()
    })
    .is_err());
    assert!(validate_bounds(Bounds {
        west: 120.,
        east: 110.,
        ..bounds()
    })
    .is_err());
    for value in [
        json!({"type":"ExceptionReport"}),
        json!({"type":"FeatureCollection","features":[],"crs":{"properties":{"name":"EPSG:3857"}}}),
        json!({"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":null}]}),
    ] {
        assert!(parse_page(value, 500, 0).is_err());
    }
}
#[test]
fn early_cancel_and_retry_after_are_not_lost() {
    let id = uuid::Uuid::new_v4().to_string();
    foundation_cancel(id.clone());
    assert!(matches!(register(&id),Err(error) if error==cancelled()));
    assert_eq!(parse_retry_after("45"), Some(45));
    assert_eq!(parse_retry_after("bad"), None);
    assert!(!valid_feature(
        &json!({"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[999,39]}})
    ));
}

#[tokio::test]
#[ignore = "Isolated UI bridge for CUA acceptance; localhost only, fixed WFS and QA output"]
async fn serve_ui_bridge() {
    let out = PathBuf::from(std::env::var("GEOD_FOUNDATION_QA_OUTPUT").unwrap());
    std::fs::create_dir_all(&out).unwrap();
    let output = out.canonicalize().unwrap();
    assert!(output.starts_with(
        PathBuf::from("G:/code/tif-downloader/artifacts")
            .canonicalize()
            .unwrap()
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:1434")
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
    println!("Foundation native QA bridge listening on 127.0.0.1:1434");
    loop {
        let (mut socket, _) = tokio::select! {_ = tokio::time::sleep_until(deadline)=>break,r=listener.accept()=>r.unwrap()};
        let output = output.clone();
        tokio::spawn(async move {
            let mut bytes = Vec::new();
            let (headers, body) = loop {
                let mut buffer = [0; 4096];
                let n = socket.read(&mut buffer).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                bytes.extend_from_slice(&buffer[..n]);
                if bytes.len() > 65536 {
                    return;
                }
                if let Some(i) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let text = String::from_utf8_lossy(&bytes[..i]);
                    let len = text
                        .lines()
                        .find_map(|v| {
                            v.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= i + 4 + len {
                        break (text.to_string(), bytes[i + 4..i + 4 + len].to_vec());
                    }
                }
            };
            let path = headers.split_whitespace().nth(1).unwrap_or("");
            let args: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
            let result: Result<Value, String> = async {
                if path == "/cancel" {
                    foundation_cancel(args["requestId"].as_str().unwrap_or_default().into());
                    return Ok(Value::Null);
                }
                if path == "/osm-load" {
                    return serde_json::to_value(osm_preview::osm_preview_load(
                        args["requestId"].as_str().ok_or("missing request")?.into(),
                        serde_json::from_value(args["bounds"].clone()).map_err(|_| "bad bounds")?,
                        args["featureType"].as_str().ok_or("missing type")?.into(), None,
                        serde_json::from_value(args.get("polygon").cloned().unwrap_or(Value::Null)).map_err(|_| "bad polygon")?,
                    ).await?).map_err(|e| e.to_string());
                }
                if path == "/osm-remove" {
                    osm_preview::osm_preview_remove(args["id"].as_str().unwrap_or_default().into());
                    return Ok(Value::Null);
                }
                if path == "/osm-tile" {
                    return serde_json::to_value(osm_preview::osm_preview_tile(
                        args["requestId"].as_str().ok_or("missing request")?.into(),
                        args["id"].as_str().ok_or("missing snapshot")?.into(),
                        serde_json::from_value(args["config"].clone()).map_err(|_| "bad config")?,
                        args["z"].as_u64().ok_or("bad zoom")?.try_into().map_err(|_| "bad zoom")?,
                        args["x"].as_u64().ok_or("bad x")?.try_into().map_err(|_| "bad x")?,
                        args["y"].as_u64().ok_or("bad y")?.try_into().map_err(|_| "bad y")?,
                    ).await?).map_err(|e| e.to_string());
                }
                let id = args["requestId"].as_str().ok_or("request ID missing")?;
                let (_guard, cancel) = register(id)?;
                let mut source = Source::new(None)?;
                source.cache = output.join("ui-cache");
                source.cache_read = !args["refresh"].as_bool().unwrap_or(false);
                if path == "/raster" {
                    let config: raster::RasterConfig =
                        serde_json::from_value(args["config"].clone())
                            .map_err(|_| "bad raster config")?;
                    let z = args["z"]
                        .as_u64()
                        .and_then(|v| u8::try_from(v).ok())
                        .ok_or("bad zoom")?;
                    let x = args["x"]
                        .as_u64()
                        .and_then(|v| u32::try_from(v).ok())
                        .ok_or("bad x")?;
                    let y = args["y"]
                        .as_u64()
                        .and_then(|v| u32::try_from(v).ok())
                        .ok_or("bad y")?;
                    return Ok(serde_json::to_value(
                        raster::tile(source, config, z, x, y, &cancel).await?,
                    )
                    .unwrap());
                }
                let bounds: Bounds =
                    serde_json::from_value(args["bounds"].clone()).map_err(|_| "bad bounds")?;
                if path == "/preview" {
                    let layer: Layer =
                        serde_json::from_value(args["layer"].clone()).map_err(|_| "bad layer")?;
                    Ok(serde_json::to_value(
                        preview(&source, layer, bounds, PREVIEW_LIMIT, &cancel).await?,
                    )
                    .unwrap())
                } else if path == "/export" {
                    let layers: Vec<Layer> =
                        serde_json::from_value(args["layers"].clone()).map_err(|_| "bad layers")?;
                    Ok(serde_json::to_value(
                        export(
                            &source,
                            &layers,
                            bounds,
                            &output.join("ui-export.geojson"),
                            &cancel,
                            |_| {},
                        )
                        .await?,
                    )
                    .unwrap())
                } else {
                    Err("unknown QA route".into())
                }
            }
            .await;
            let response = match result {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error}),
            };
            let bytes = serde_json::to_vec(&response).unwrap();
            let header=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len());
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&bytes).await;
        });
    }
}
#[tokio::test]
#[ignore = "Small real WFS acceptance; no credentials, no publication or user settings"]
async fn live_four_layers_and_full_export() {
    let out = PathBuf::from(std::env::var("GEOD_FOUNDATION_QA_OUTPUT").unwrap());
    std::fs::create_dir_all(&out).unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut source = Source::new(None).unwrap();
    source.cache = cache.path().into();
    let small = Bounds {
        west: 116.35,
        south: 39.85,
        east: 116.45,
        north: 39.95,
    };
    let mut proof = Vec::new();
    for layer in [
        Layer::Water,
        Layer::Roads,
        Layer::Railways,
        Layer::Settlements,
    ] {
        let p = preview(
            &source,
            layer,
            small,
            PREVIEW_LIMIT,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(p.feature_count > 0);
        assert!(!p.truncated);
        std::fs::write(
            out.join(format!("{}.json", layer.id())),
            serde_json::to_vec(&p).unwrap(),
        )
        .unwrap();
        proof.push(json!({"layer":layer,"count":p.feature_count,"networkPages":p.network_pages}));
    }
    let result = export(
        &source,
        &[
            Layer::Water,
            Layer::Roads,
            Layer::Railways,
            Layer::Settlements,
        ],
        small,
        &out.join("foundation.geojson"),
        &CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap();
    assert!(result.features > 0);
    std::fs::write(
        out.join("acceptance.json"),
        serde_json::to_vec_pretty(&json!({"layers":proof,"export":result,"credentialsUsed":false}))
            .unwrap(),
    )
    .unwrap();
}
