//! Socket-level scheduler regressions. Opt-in volume test never contacts a provider.
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
#[ignore = "2048 real loopback tile transfers, one injected 429; about two minutes"]
async fn two_tasks_share_a_smooth_budget_recover_and_resume_without_requests() {
    let _lock = tcache::CACHE_TEST_LOCK.lock().unwrap();
    let old = tcache::get_config();
    struct Restore(tcache::CacheConfig);
    impl Drop for Restore { fn drop(&mut self) { tcache::set_config(self.0.clone()); } }
    let _restore = Restore(old);
    let dir = tempfile::tempdir().unwrap();
    tcache::set_config(tcache::CacheConfig { enabled: false, root_dir: dir.path().join("cache"), max_total_bytes: 0 });
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(256, 256).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let bytes = Arc::new(png.into_inner());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let received = starts.clone(); let payload = bytes.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let payload = payload.clone(); let received = received.clone();
            tokio::spawn(async move {
                let mut request = [0; 8192]; let n = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..n]);
                assert!(request.contains("tk=scheduler-regression"));
                let limited = {
                    let mut starts = received.lock().unwrap();
                    starts.push(std::time::Instant::now()); starts.len() == 129
                };
                let response = if limited {
                    b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
                } else {
                    let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len()).into_bytes();
                    response.extend_from_slice(&payload); response
                };
                socket.write_all(&response).await.unwrap();
            });
        }
    });
    let mut a = crate::config::get_tile_sources(Some("scheduler-regression"))["tianditu_satellite"].clone();
    a.url = format!("http://t0.tianditu.gov.cn:{}/img_w/wmts?LAYER=img&TILEMATRIXSET=w&tk=scheduler-regression&TILEROW={{y}}&TILECOL={{x}}&TILEMATRIX={{z}}", address.port());
    let mut b = a.clone(); b.url = b.url.replace("t0.", "t7.");
    let make = |source| {
        let mut downloader = TileDownloader::new(source, None).unwrap();
        downloader.client = Client::builder().no_proxy().resolve("t0.tianditu.gov.cn", address)
            .resolve("t7.tianditu.gov.cn", address).build().unwrap();
        downloader.with_tianditu_tokens(Arc::new(TiandituTokens::new(vec!["scheduler-regression".into()], Arc::new(|_| {}))))
    };
    let a = make(a); let b = make(b);
    let coords = |start| (start..start + 1024).map(|x| TileCoord { x, y: 1, z: 16 }).collect::<Vec<_>>();
    let path_a = dir.path().join("a"); let path_b = dir.path().join("b");
    let started = std::time::Instant::now();
    let (a_result, b_result) = tokio::join!(
        a.download_tiles(coords(0), 30, &path_a, None, None, |_| {}),
        b.download_tiles(coords(1024), 30, &path_b, None, None, |_| {}));
    assert_eq!(a_result.unwrap().len(), 1024); assert_eq!(b_result.unwrap().len(), 1024);
    let recorded = starts.lock().unwrap().clone(); assert_eq!(recorded.len(), 2049);
    // The first burst is prevented across both tasks/subdomains, not per task.
    assert!(recorded[1].duration_since(recorded[0]) >= Duration::from_millis(50));
    assert!(recorded[129].duration_since(recorded[128]) >= Duration::from_millis(950));
    for (folder, begin) in [(&path_a, 0), (&path_b, 1024)] {
        for x in begin..begin + 1024 {
            assert_eq!(tokio::fs::read(folder.join(x.to_string()).join("1.png")).await.unwrap(), *bytes);
        }
    }
    assert!(!a.tianditu_tokens.as_ref().unwrap().diagnostics().tokens_exhausted);
    assert!(!b.tianditu_tokens.as_ref().unwrap().diagnostics().tokens_exhausted);
    let resumed = a.download_tiles(coords(0), 30, &path_a, None, None, |_| {}).await.unwrap();
    assert_eq!(resumed.len(), 1024); assert_eq!(starts.lock().unwrap().len(), 2049);
    println!("scheduler-loopback: 2048 verified files; 2049 requests; 1 injected 429; both tasks completed; resume 0 requests; {:.3}s", started.elapsed().as_secs_f64());
    server.abort();
}

#[tokio::test]
async fn cooling_is_visible_and_cancellation_drops_queued_requests() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicU32::new(0)); let received = count.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 8192]; let _ = socket.read(&mut request).await.unwrap();
            received.fetch_add(1, Ordering::SeqCst);
            socket.write_all(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 10\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let mut source = crate::config::get_tile_sources(Some("cooling-regression"))["tianditu_satellite"].clone();
    source.url = format!("http://t0.tianditu.gov.cn:{}/cia_w/wmts?tk=cooling-regression&TILEROW={{y}}&TILECOL={{x}}", address.port());
    let mut downloader = TileDownloader::new(source, None).unwrap();
    downloader.client = Client::builder().no_proxy().resolve("t0.tianditu.gov.cn", address).build().unwrap();
    let cancel = CancellationToken::new(); let signal = cancel.clone();
    let mut visible = false;
    let result = tokio::time::timeout(Duration::from_secs(5), downloader.download_tiles(
        vec![TileCoord { x: 1, y: 2, z: 16 }], 30, dir.path(), Some(&cancel), None,
        |progress| if progress.status.contains("自动冷却") { visible = true; signal.cancel(); })).await.unwrap();
    assert!(visible); assert_eq!(result.unwrap_err(), "任务已取消");
    assert_eq!(count.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server.abort();
}
