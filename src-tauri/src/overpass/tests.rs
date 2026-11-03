use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const VALID: &str = r#"{"elements":[{"type":"node","id":1,"lat":52.5,"lon":13.3}]}"#;
const QUERY: &str =
    "[out:json];way[\"highway\"](52.516,13.376,52.518,13.380);out body;>;out skel qt;";
enum Reply {
    Json(u16, &'static str),
    RateLimited(&'static str),
    Disconnect,
    Stalled,
    Truncated,
}
struct Mock {
    url: String,
    count: Arc<AtomicUsize>,
    request: Arc<Mutex<String>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn mock(reply: Reply) -> Mock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api/interpreter", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let request = Arc::new(Mutex::new(String::new()));
    let captured = request.clone();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut buffer = [0; 4096];
            let n = socket.read(&mut buffer).await.unwrap();
            if n == 0 {
                return;
            }
            bytes.extend_from_slice(&buffer[..n]);
            let text = String::from_utf8_lossy(&bytes);
            if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|s| s.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if body.len() >= length {
                    break;
                }
            }
        }
        *captured.lock().unwrap() = String::from_utf8(bytes).unwrap();
        observed.fetch_add(1, Ordering::SeqCst);
        match reply {
            Reply::Disconnect => (),
            Reply::Stalled => tokio::time::sleep(Duration::from_secs(20)).await,
            Reply::Truncated => {
                let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 9999\r\nConnection: close\r\n\r\n{\"elements\":[").await;
            }
            Reply::RateLimited(wait) => {
                let _ = socket.write_all(format!("HTTP/1.1 429 Too Many Requests\r\nRetry-After: {wait}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await;
            }
            Reply::Json(code, body) => {
                let _ = socket.write_all(format!("HTTP/1.1 {code} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            }
        }
    });
    Mock {
        url,
        count,
        request,
        task,
    }
}
fn policy() -> Policy {
    Policy {
        request: Duration::from_millis(150),
        total: Duration::from_secs(3),
        rate_limit_wait: Duration::from_millis(20),
    }
}
fn client() -> Client {
    Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn healthy_primary_sends_encoded_query_once_without_contacting_backup() {
    let a = mock(Reply::Json(200, VALID)).await;
    let b = mock(Reply::Json(200, VALID)).await;
    let result = query_with_client(QUERY, &client(), &[&a.url, &b.url], policy(), |_| {})
        .await
        .unwrap();
    assert_eq!(result["elements"][0]["id"], 1);
    assert_eq!(a.count.load(Ordering::SeqCst), 1);
    assert_eq!(b.count.load(Ordering::SeqCst), 0);
    assert!(a
        .request
        .lock()
        .unwrap()
        .ends_with(&format!("data={}", urlencoding::encode(QUERY))));
}

#[tokio::test]
async fn transient_failures_switch_to_backup_and_keep_attempt_diagnostics() {
    for reply in [
        Reply::Disconnect,
        Reply::Stalled,
        Reply::Truncated,
        Reply::Json(503, "unavailable"),
        Reply::Json(200, "<html>gateway error</html>"),
        Reply::Json(200, "{}"),
    ] {
        let a = mock(reply).await;
        let b = mock(Reply::Json(200, VALID)).await;
        let mut events = Vec::new();
        let result = query_with_client(QUERY, &client(), &[&a.url, &b.url], policy(), |m| {
            events.push(m)
        })
        .await
        .unwrap();
        assert_eq!(result["elements"].as_array().unwrap().len(), 1);
        assert_eq!(a.count.load(Ordering::SeqCst), 1);
        assert_eq!(b.count.load(Ordering::SeqCst), 1);
        assert!(events.iter().any(|m| m.starts_with("OVERPASS_ERROR:")));
        assert!(events.iter().any(|m| m == "OVERPASS_FALLBACK:2:2"));
    }
}

#[tokio::test]
async fn rate_limit_waits_for_retry_after_before_one_backup_attempt() {
    let a = mock(Reply::RateLimited("1")).await;
    let b = mock(Reply::Json(200, VALID)).await;
    let start = Instant::now();
    let mut events = Vec::new();
    query_with_client(QUERY, &client(), &[&a.url, &b.url], policy(), |m| {
        events.push(m)
    })
    .await
    .unwrap();
    assert!(start.elapsed() >= Duration::from_secs(1));
    assert!(events.iter().any(|m| m == "OVERPASS_WAIT:1"));
    assert_eq!(b.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn long_retry_after_stops_instead_of_ignoring_server_cooldown() {
    let a = mock(Reply::RateLimited("3600")).await;
    let b = mock(Reply::Json(200, VALID)).await;
    let error = query_with_client(QUERY, &client(), &[&a.url, &b.url], policy(), |_| {})
        .await
        .unwrap_err();
    assert!(error.contains("冷却时间超过"));
    assert_eq!(b.count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn query_rejection_and_partial_results_never_trigger_repeated_expensive_queries() {
    for (reply, code) in [
        (Reply::Json(400, "invalid query"), "OSM_REQUEST_REJECTED:"),
        (
            Reply::Json(
                200,
                r#"{"elements":[{"type":"node","id":1}],"remark":"runtime error: Query timed out"}"#,
            ),
            "OSM_QUERY_INCOMPLETE:",
        ),
    ] {
        let a = mock(reply).await;
        let b = mock(Reply::Json(200, VALID)).await;
        let error = query_with_client(QUERY, &client(), &[&a.url, &b.url], policy(), |_| {})
            .await
            .unwrap_err();
        assert!(error.starts_with(code));
        assert_eq!(b.count.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn valid_empty_results_are_success_and_all_failed_endpoints_stay_failed() {
    let empty = mock(Reply::Json(200, r#"{"elements":[]}"#)).await;
    let result = query_with_client(QUERY, &client(), &[&empty.url], policy(), |_| {})
        .await
        .unwrap();
    assert!(result["elements"].as_array().unwrap().is_empty());
    let a = mock(Reply::Disconnect).await;
    let b = mock(Reply::Json(502, "bad gateway")).await;
    let error = query_with_client(QUERY, &client(), &[&a.url, &b.url], policy(), |_| {})
        .await
        .unwrap_err();
    assert!(error.starts_with("OSM_SERVICE_UNAVAILABLE:"));
    assert!(error.contains("HTTP 502"));
    assert!(error.contains("未生成输出文件"));
}

#[tokio::test]
async fn total_deadline_and_cancellation_prevent_later_requests() {
    let a = mock(Reply::Stalled).await;
    let b = mock(Reply::Json(200, VALID)).await;
    let error = query_with_client(
        QUERY,
        &client(),
        &[&a.url, &b.url],
        Policy {
            total: Duration::from_millis(40),
            ..policy()
        },
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(error.starts_with("OSM_SERVICE_UNAVAILABLE:"));
    assert_eq!(b.count.load(Ordering::SeqCst), 0);
    let a = mock(Reply::RateLimited("1")).await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let endpoints = [&a.url[..], &b.url[..]];
    let client = client();
    let result = tokio::select! {
        value = query_with_client(QUERY, &client, &endpoints, policy(), |m| { if m.starts_with("OVERPASS_WAIT:") { cancel.cancel(); } }) => Some(value),
        _ = cancel.cancelled() => None,
    };
    assert!(result.is_none());
    assert_eq!(b.count.load(Ordering::SeqCst), 0);
}

#[test]
fn retry_after_accepts_seconds_and_http_dates() {
    assert_eq!(retry_after("120"), Some(Duration::from_secs(120)));
    let future = (chrono::Utc::now() + chrono::Duration::seconds(90))
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    assert!(retry_after(&future).unwrap() >= Duration::from_secs(88));
    assert_eq!(retry_after("bad"), None);
}

#[tokio::test]
#[ignore = "Explicit small real Overpass query; writes only the named QA artifact directory"]
async fn live_small_roads_query_writes_verified_geojson() {
    let directory = std::path::PathBuf::from(
        std::env::var("GEOD_OVERPASS_QA_OUTPUT").expect("Set an isolated QA output directory"),
    );
    std::fs::create_dir_all(&directory).unwrap();
    let proxy = std::env::var("GEOD_OVERPASS_QA_PROXY").ok();
    let mut events = Vec::new();
    let start = Instant::now();
    let result = crate::admin::download_osm_features_with_progress(
        52.516,
        13.376,
        52.518,
        13.380,
        "highway",
        proxy.as_deref(),
        None,
        |message| {
            println!("{message}");
            events.push(message);
        },
    )
    .await;
    let mut proof = serde_json::json!({"events":events,"elapsed_seconds":start.elapsed().as_secs_f64(),
        "bounds":{"south":52.516,"west":13.376,"north":52.518,"east":13.380}});
    match result {
        Ok(geojson) => {
            let count = geojson["features"].as_array().unwrap().len();
            assert!(count > 0);
            let path = directory.join("berlin-roads.geojson");
            let bytes = crate::osm_output::write_geojson(&path, &geojson, || false).unwrap();
            crate::osm_output::require_output_file(&path).unwrap();
            let readback: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(readback["features"].as_array().unwrap().len(), count);
            proof["success"] = true.into();
            proof["feature_count"] = count.into();
            proof["bytes"] = bytes.into();
        }
        Err(error) => {
            proof["success"] = false.into();
            proof["error"] = error.into();
        }
    }
    std::fs::write(
        directory.join("live-result.json"),
        serde_json::to_vec_pretty(&proof).unwrap(),
    )
    .unwrap();
    assert_eq!(proof["success"], true, "{proof}");
}
