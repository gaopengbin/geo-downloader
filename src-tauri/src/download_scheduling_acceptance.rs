//! Explicit socket-level acceptance using the real downloader, no public services.
use super::*;
use crate::download_scheduling::UserPolicy;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn apply(policy: UserPolicy) {
    let mut settings = crate::settings::AppSettings::default();
    settings.download_rate_limit = policy.rate;
    settings.download_batch_size = policy.batch_size;
    settings.download_batch_pause_ms = policy.batch_pause_ms;
    crate::tile_requests::settings_saved(&settings);
}

#[tokio::test]
#[ignore = "Isolated real loopback downloads with process-local scheduling settings; run alone"]
async fn configured_limits_share_between_jobs_and_resume_without_network_requests() {
    let _guard = crate::tile_requests::TEST_GATE_LOCK.lock().await;
    let _lock = tcache::CACHE_TEST_LOCK.lock().unwrap();
    struct Restore {
        policy: UserPolicy,
        cache: tcache::CacheConfig,
    }
    impl Drop for Restore {
        fn drop(&mut self) {
            apply(self.policy);
            tcache::set_config(self.cache.clone());
        }
    }
    let _restore = Restore {
        policy: crate::download_scheduling::current(),
        cache: tcache::get_config(),
    };
    let directory = tempfile::tempdir().unwrap();
    tcache::set_config(tcache::CacheConfig {
        enabled: false,
        root_dir: directory.path().join("cache"),
        max_total_bytes: 0,
    });
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(256, 256)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let payload = Arc::new(png.into_inner());
    let mut proof = Vec::new();
    for (phase, policy, count) in [
        (
            "rate",
            UserPolicy {
                rate: 8,
                batch_size: 0,
                batch_pause_ms: 0,
            },
            24u32,
        ),
        (
            "batch",
            UserPolicy {
                rate: 0,
                batch_size: 3,
                batch_pause_ms: 250,
            },
            18u32,
        ),
    ] {
        apply(policy);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let origin = std::time::Instant::now();
        let records = Arc::new(std::sync::Mutex::new(Vec::<(f64, Option<f64>)>::new()));
        let received = records.clone();
        let png = payload.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let png = png.clone();
                let received = received.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    loop {
                        let mut bytes = [0; 4096];
                        let n = socket.read(&mut bytes).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&bytes[..n]);
                        if request.windows(4).any(|s| s == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let index = {
                        let mut records = received.lock().unwrap();
                        let index = records.len();
                        records.push((origin.elapsed().as_secs_f64() * 1000.0, None));
                        index
                    };
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", png.len()).as_bytes()).await.unwrap();
                    tokio::time::sleep(Duration::from_millis(if index % 3 == 0 { 80 } else { 20 }))
                        .await;
                    socket.write_all(&png).await.unwrap();
                    received.lock().unwrap()[index].1 =
                        Some(origin.elapsed().as_secs_f64() * 1000.0);
                });
            }
        });
        let source = TileSource {
            id: format!("qa-user-{phase}"),
            name: "isolated scheduler QA".into(),
            url: format!("http://{address}/{{z}}/{{x}}/{{y}}.png"),
            subdomains: vec![],
            max_zoom: 20,
            attribution: "Synthetic validation tiles".into(),
            headers: Default::default(),
        };
        let make = || {
            let mut downloader = TileDownloader::new(source.clone(), None).unwrap();
            downloader.client = Client::builder().no_proxy().build().unwrap();
            downloader
        };
        let a = make();
        let b = make();
        let tiles = |start| {
            (start..start + count / 2)
                .map(|x| TileCoord { x, y: 1, z: 10 })
                .collect::<Vec<_>>()
        };
        let a_path = directory.path().join(phase).join("a");
        let b_path = directory.path().join(phase).join("b");
        let (a_result, b_result) = tokio::join!(
            a.download_tiles(tiles(0), 8, &a_path, None, None, |_| {}),
            b.download_tiles(tiles(count / 2), 8, &b_path, None, None, |_| {})
        );
        let a_files = a_result.unwrap();
        let b_files = b_result.unwrap();
        assert_eq!(a_files.len() + b_files.len(), count as usize);
        for file in a_files.values().chain(b_files.values()) {
            let bytes = file.bytes().unwrap();
            assert_eq!(bytes.as_ref(), payload.as_slice());
            assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 256);
        }
        let mut observed = records.lock().unwrap().clone();
        observed.sort_by(|a, b| a.0.total_cmp(&b.0));
        assert_eq!(observed.len(), count as usize);
        if phase == "rate" {
            for (index, item) in observed.iter().enumerate() {
                assert!(
                    observed[index..]
                        .iter()
                        .take_while(|next| next.0 - item.0 < 990.0)
                        .count()
                        <= 8
                );
            }
        } else {
            for batch in 1..observed.len() / 3 {
                let last_finished = observed[(batch - 1) * 3..batch * 3]
                    .iter()
                    .map(|r| r.1.unwrap())
                    .fold(0.0, f64::max);
                assert!(observed[batch * 3].0 - last_finished >= 240.0);
            }
        }
        let resumed = a
            .download_tiles(tiles(0), 8, &a_path, None, None, |_| {})
            .await
            .unwrap();
        assert_eq!(resumed.len(), count as usize / 2);
        assert_eq!(records.lock().unwrap().len(), count as usize);
        proof.push(serde_json::json!({"phase":phase,"requests":observed.len(),"files":count,
            "rate_limit":policy.rate,"batch_size":policy.batch_size,"pause_ms":policy.batch_pause_ms,
            "observed_ms":observed,"elapsed_seconds":origin.elapsed().as_secs_f64(),"resume_extra_requests":0}));
        server.abort();
    }
    if let Ok(path) = std::env::var("GEOD_SCHEDULING_QA_OUTPUT") {
        let path = std::path::PathBuf::from(path);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            path.join("native-http-proof.json"),
            serde_json::to_vec_pretty(&proof).unwrap(),
        )
        .unwrap();
        std::fs::write(path.join("sample-tile.png"), payload.as_slice()).unwrap();
    }
    println!("{}", serde_json::to_string(&proof.iter().map(|p| serde_json::json!({"phase":p["phase"],"files":p["files"],"requests":p["requests"],"elapsed_seconds":p["elapsed_seconds"]})).collect::<Vec<_>>()).unwrap());
}
