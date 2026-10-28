//! Per-source HTTP credentials. Values never appear in Debug or validation errors.
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ops::Deref;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SourceHeaders(pub BTreeMap<String, String>);

impl Deref for SourceHeaders {
    type Target = BTreeMap<String, String>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        },
    };

    #[test]
    fn validates_without_echoing_credentials() {
        let headers = SourceHeaders(BTreeMap::from([
            ("Authorization".into(), "Bearer test-only".into()),
            ("Cookie".into(), "a=b; c=d==".into()),
        ]));
        assert_eq!(
            headers.validated().unwrap()["authorization"],
            "Bearer test-only"
        );
        assert!(!format!("{headers:?}").contains("test-only"));
        for pairs in [
            vec![("bad name", "test-only")],
            vec![("Host", "test-only")],
            vec![("Cookie", "test-only\r\nX: injected")],
            vec![("x-test", "one"), ("X-Test", "test-only")],
        ] {
            let invalid = SourceHeaders(
                pairs
                    .into_iter()
                    .map(|(k, v)| (k.into(), v.into()))
                    .collect(),
            );
            let error = invalid.validated().unwrap_err();
            assert!(!error.contains("test-only"));
        }
    }

    #[test]
    fn legacy_sources_default_to_no_headers_and_cache_is_partitioned() {
        let mut source: crate::config::TileSource = serde_json::from_str(
            r#"{"id":"custom_test","name":"test","url":"https://example.test/{z}/{x}/{y}.png","max_zoom":18,"attribution":"","subdomains":[]}"#).unwrap();
        assert!(source.headers.is_empty());
        assert_eq!(source.cache_key(), source.id);
        source
            .headers
            .0
            .insert("authorization".into(), "Bearer test-only".into());
        let first = source.cache_key();
        assert!(!first.contains("test-only"));
        source
            .headers
            .0
            .insert("authorization".into(), "Bearer second-test-only".into());
        assert_ne!(first, source.cache_key());
        source.url.push_str("?style=other");
        assert_ne!(first, source.cache_key());
    }

    pub struct AuthServer {
        pub url: String,
        pub stolen: Arc<AtomicUsize>,
        pub accepted: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for AuthServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(handle) = self.handle.take() {
                handle.join().unwrap();
            }
        }
    }
    pub fn auth_server() -> AuthServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let stolen = Arc::new(AtomicUsize::new(0));
        let leaked = stolen.clone();
        let accepted = Arc::new(AtomicUsize::new(0));
        let authorized = accepted.clone();
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(256, 256, image::Rgba([20, 80, 120, 255]))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let bytes = png.into_inner();
        let handle = std::thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    continue;
                };
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 2048];
                while !request.windows(4).any(|v| v == b"\r\n\r\n") && request.len() < 65536 {
                    let Ok(count) = stream.read(&mut buffer) else {
                        break;
                    };
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                }
                let request = String::from_utf8_lossy(&request).to_ascii_lowercase();
                let path = request.split_whitespace().nth(1).unwrap_or("");
                if path.starts_with("/stolen") {
                    leaked.fetch_add(1, Ordering::SeqCst);
                }
                let (status, extra, body) = if path.starts_with("/cross") {
                    (
                        "302 Found",
                        format!("Location: http://localhost:{}/stolen\r\n", address.port()),
                        Vec::new(),
                    )
                } else if path.starts_with("/same") {
                    (
                        "302 Found",
                        "Location: /tile/1/1/1.png\r\n".into(),
                        Vec::new(),
                    )
                } else if [
                    "authorization: bearer test-only\r\n",
                    "cookie: session=test-only\r\n",
                    "x-api-key: key-test-only\r\n",
                    "referer: https://example.test/map\r\n",
                    "user-agent: geod-header-test\r\n",
                ]
                .iter()
                .all(|v| request.contains(v))
                {
                    authorized.fetch_add(1, Ordering::SeqCst);
                    if path.starts_with("/mvt") {
                        let data = b"\x1a\x07\x0a\x03osm\x78\x02";
                        let body = if path.starts_with("/mvtgzip") {
                            let mut encoder = flate2::write::GzEncoder::new(
                                Vec::new(),
                                flate2::Compression::default(),
                            );
                            encoder.write_all(data).unwrap();
                            encoder.finish().unwrap()
                        } else {
                            data.to_vec()
                        };
                        (
                            "200 OK",
                            "Content-Type: application/x-protobuf\r\n".into(),
                            body,
                        )
                    } else {
                        (
                            "200 OK",
                            "Content-Type: image/png\r\n".into(),
                            bytes.clone(),
                        )
                    }
                } else {
                    (
                        "401 Unauthorized",
                        "Content-Type: text/plain\r\n".into(),
                        b"credential required".to_vec(),
                    )
                };
                let header = format!(
                    "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        AuthServer {
            url: format!("http://{address}"),
            stolen,
            accepted,
            stop,
            handle: Some(handle),
        }
    }
    pub fn auth_source(server: &AuthServer) -> crate::config::TileSource {
        crate::config::TileSource {
            id: format!("headers_test_{}", uuid::Uuid::new_v4()),
            name: "Local authentication fixture".into(),
            url: format!("{}/tile/{{z}}/{{x}}/{{y}}.png", server.url),
            subdomains: vec![],
            max_zoom: 18,
            attribution: "Local test fixture".into(),
            headers: SourceHeaders(
                [
                    ("authorization", "Bearer test-only"),
                    ("cookie", "session=test-only"),
                    ("x-api-key", "key-test-only"),
                    ("referer", "https://example.test/map"),
                    ("user-agent", "GeoD-Header-Test"),
                ]
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
            ),
        }
    }

    #[tokio::test]
    async fn analyzer_and_preview_use_headers_and_reject_cross_origin_redirects() {
        let server = auth_server();
        let source = auth_source(&server);
        let bad = crate::source_analyzer::analyze(&source.url, None)
            .await
            .unwrap();
        assert_eq!(bad.status_code, Some(401));
        assert!(!bad.test_ok);
        let good = crate::source_analyzer::analyze_with_headers(&source.url, None, &source.headers)
            .await
            .unwrap();
        assert!(good.test_ok);
        assert_eq!(good.status_code, Some(200));
        let tile = crate::tile::TileCoord { z: 1, x: 1, y: 1 };
        let preview = crate::downloader::TileDownloader::new_preview(source.clone(), None).unwrap();
        assert!(preview
            .preview_tile(&tile)
            .await
            .unwrap()
            .starts_with(b"\x89PNG"));
        let mut plain = source.clone();
        plain.headers = Default::default();
        assert!(crate::downloader::TileDownloader::new_preview(plain, None)
            .unwrap()
            .preview_tile(&tile)
            .await
            .unwrap_err()
            .contains("401"));
        for (route, success) in [("same", true), ("cross", false)] {
            let mut redirected = source.clone();
            redirected.url = format!("{}/{route}/{{z}}/{{x}}/{{y}}.png", server.url);
            let analysis = crate::source_analyzer::analyze_with_headers(
                &redirected.url,
                None,
                &redirected.headers,
            )
            .await
            .unwrap();
            assert_eq!(analysis.test_ok, success);
            let preview = crate::downloader::TileDownloader::new_preview(redirected, None).unwrap();
            assert_eq!(preview.preview_tile(&tile).await.is_ok(), success);
        }
        assert_eq!(server.stolen.load(Ordering::SeqCst), 0);
        assert!(server.accepted.load(Ordering::SeqCst) >= 4);
        for route in ["mvt", "mvtgzip"] {
            let mut vector = source.clone();
            vector.url = format!("{}/{route}/{{z}}/{{x}}/{{y}}.pbf", server.url);
            let client = crate::downloader::TileDownloader::new_preview(vector, None).unwrap();
            let tile = client.preview_tile_payload(&tile).await.unwrap();
            assert_eq!(tile.content_type, "application/vnd.mapbox-vector-tile");
            assert_eq!(tile.bytes, b"\x1a\x07\x0a\x03osm\x78\x02");
        }
    }
}

impl std::fmt::Debug for SourceHeaders {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceHeaders")
            .field("count", &self.len())
            .finish()
    }
}

impl SourceHeaders {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn validated(&self) -> Result<HeaderMap, String> {
        if self.len() > 64 {
            return Err("自定义请求头最多 64 项".into());
        }
        let mut result = HeaderMap::new();
        let mut total = 0;
        for (index, (name, value)) in self.iter().enumerate() {
            let invalid = || format!("第 {} 项请求头格式无效，请检查名称和单行值", index + 1);
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?;
            if matches!(
                name.as_str(),
                "host"
                    | "content-length"
                    | "connection"
                    | "transfer-encoding"
                    | "upgrade"
                    | "proxy-authorization"
                    | "proxy-connection"
                    | "te"
                    | "trailer"
            ) {
                return Err(format!("第 {} 项是由 HTTP 客户端管理的请求头", index + 1));
            }
            total += name.as_str().len() + value.len();
            if value.len() > 16384 || total > 65536 || result.contains_key(&name) {
                return Err(format!("第 {} 项请求头重复或内容过长", index + 1));
            }
            let mut value = HeaderValue::from_str(value).map_err(|_| invalid())?;
            value.set_sensitive(true);
            result.insert(name, value);
        }
        Ok(result)
    }

    /// Never forward arbitrary credentials to a different origin (including ports).
    pub fn redirect_policy(&self, preview: bool) -> Option<reqwest::redirect::Policy> {
        if self.is_empty() {
            return None;
        }
        Some(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.error("too many redirects");
            }
            if attempt
                .previous()
                .first()
                .is_some_and(|first| first.origin() != attempt.url().origin())
            {
                return attempt.stop();
            }
            if !preview
                && crate::tile_policy::ensure_offline_allowed(attempt.url().as_str()).is_err()
            {
                return attempt.stop();
            }
            attempt.follow()
        }))
    }
}
