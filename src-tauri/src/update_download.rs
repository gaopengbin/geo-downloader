//! Verified in-app installer download with bounded, automatic source failover.
use reqwest::{Client, Url};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::{Path, PathBuf}, time::{Duration, Instant}};

const REPOSITORY: &str = "gaopengbin/geo-downloader";
const MAX_INSTALLER_BYTES: u64 = 1024 * 1024 * 1024;
static ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub(crate) struct ActiveUpdate;
impl Drop for ActiveUpdate {
    fn drop(&mut self) { ACTIVE.store(false, std::sync::atomic::Ordering::Release); }
}
pub(crate) fn lock_update() -> Result<ActiveUpdate, String> {
    ACTIVE.compare_exchange(false, true, std::sync::atomic::Ordering::AcqRel, std::sync::atomic::Ordering::Acquire)
        .map(|_| ActiveUpdate).map_err(|_| "更新下载正在进行，请等待当前更新完成".into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Source { Mirror, Github }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Reason { Slow, Timeout, Unavailable, Invalid }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Transfer {
    pub source: Source,
    pub phase: &'static str,
    pub attempt: usize,
    pub progress: u32,
    pub downloaded: u64,
    pub total: u64,
    pub bytes_per_second: f64,
    pub reason: Option<Reason>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Route { Direct, System }
#[derive(Clone)]
struct Candidate { source: Source, route: Route, url: String }
pub(crate) struct Spec {
    filename: String,
    sha256: String,
    size: u64,
    candidates: Vec<Candidate>,
}

impl Spec {
    pub(crate) fn new(url: &str, version: &str, sha256: &str, size: u64) -> Result<Self, String> {
        let core = version.split(['-', '+']).next().unwrap_or_default();
        if version.len() > 64 || core.split('.').count() != 3
            || core.split('.').any(|v| v.is_empty() || !v.bytes().all(|c| c.is_ascii_digit()))
            || !version.bytes().all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c)) {
            return Err("更新版本号无效，请重新检查更新".into());
        }
        let hash = sha256.strip_prefix("sha256:").unwrap_or(sha256).to_ascii_lowercase();
        if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) || size == 0 || size > MAX_INSTALLER_BYTES {
            return Err("安装包校验信息无效，请重新检查更新".into());
        }
        let filename = format!("GeoDownloader_{version}_windows_x64-setup.exe");
        let mirror = format!("https://laogao.xyz/packages/latest/{filename}");
        let github = format!("https://github.com/{REPOSITORY}/releases/download/v{version}/{filename}");
        let parsed = Url::parse(url).map_err(|_| "更新地址无效")?;
        let versioned = format!("https://laogao.xyz/packages/v{version}/{filename}");
        if ![mirror.as_str(), github.as_str(), versioned.as_str()].contains(&parsed.as_str()) {
            return Err("安装包地址与官方版本不匹配，请重新检查更新".into());
        }
        // A system proxy can send the domestic CDN through a much slower overseas
        // route. Prefer direct delivery even when metadata came from GitHub, then
        // retain the system route for networks that require a proxy. Integrity is
        // pinned to this version, regardless of the metadata source or route.
        let candidates = vec![
            Candidate { source: Source::Mirror, route: Route::Direct, url: mirror.clone() },
            Candidate { source: Source::Mirror, route: Route::System, url: mirror },
            Candidate { source: Source::Github, route: Route::System, url: github },
        ];
        Ok(Self { filename, sha256: hash, size, candidates })
    }
}

#[derive(Clone, Copy)]
struct Policy { headers: Duration, idle: Duration, window: Duration, minimum_bps: u64, total: Duration }
impl Default for Policy {
    fn default() -> Self {
        Self { headers: Duration::from_secs(8), idle: Duration::from_secs(5),
            window: Duration::from_secs(8), minimum_bps: 64 * 1024, total: Duration::from_secs(180) }
    }
}

fn official_redirect(url: &Url) -> bool {
    url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.host_str().is_some_and(|host| host == "laogao.xyz" || host == "download.laogao.xyz" || host == "github.com"
            || host.ends_with(".githubusercontent.com"))
}

fn client_builder() -> reqwest::ClientBuilder {
    Client::builder().connect_timeout(Duration::from_secs(5)).user_agent("GeoDownloader")
        .no_gzip().no_brotli().no_deflate().no_zstd()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 6 || !official_redirect(attempt.url()) { attempt.error("更新重定向地址无效") }
            else { attempt.follow() }
        }))
}

fn route_client_builder(route: Route) -> reqwest::ClientBuilder {
    match route {
        Route::Direct => client_builder().no_proxy(),
        Route::System => client_builder(),
    }
}

struct Failure { reason: Reason, message: String }
impl Failure {
    fn new(reason: Reason, message: impl Into<String>) -> Self { Self { reason, message: message.into() } }
}

async fn attempt<F: FnMut(Transfer)>(
    spec: &Spec, candidate: &Candidate, index: usize, path: &Path,
    client: &Client, policy: Policy, notify: &mut F,
) -> Result<(), Failure> {
    let mut response = tokio::time::timeout(policy.headers,
        client.get(&candidate.url).header("Accept-Encoding", "identity").send()).await
        .map_err(|_| Failure::new(Reason::Timeout, "连接响应超时"))?
        .map_err(|_| Failure::new(Reason::Unavailable, "无法连接下载源"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(Failure::new(Reason::Unavailable, format!("HTTP {}", response.status().as_u16())));
    }
    if response.content_length().is_some_and(|size| size != spec.size) {
        return Err(Failure::new(Reason::Invalid, "安装包大小与发布清单不一致"));
    }
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|_| Failure::new(Reason::Invalid, "无法创建安装包临时文件"))?;
    let mut digest = Sha256::new();
    let mut downloaded = 0u64;
    let mut window_start = Instant::now();
    let mut window_bytes = 0u64;
    let mut last_emit = Instant::now();
    while let Some(chunk) = tokio::time::timeout(policy.idle, response.chunk()).await
        .map_err(|_| Failure::new(Reason::Timeout, "下载连接长时间没有收到数据"))?
        .map_err(|_| Failure::new(Reason::Unavailable, "下载连接中断"))? {
        downloaded += chunk.len() as u64;
        if downloaded > spec.size { return Err(Failure::new(Reason::Invalid, "安装包超出清单大小")); }
        file.write_all(&chunk).map_err(|_| Failure::new(Reason::Invalid, "安装包写入失败"))?;
        digest.update(&chunk);
        window_bytes += chunk.len() as u64;
        let elapsed = window_start.elapsed();
        let speed = window_bytes as f64 / elapsed.as_secs_f64().max(0.001);
        if downloaded < spec.size && elapsed >= policy.window {
            if speed < policy.minimum_bps as f64 { return Err(Failure::new(Reason::Slow, "当前下载源持续低速")); }
            window_start = Instant::now(); window_bytes = 0;
        }
        if last_emit.elapsed() >= Duration::from_millis(250) || downloaded == spec.size {
            notify(Transfer { source: candidate.source, phase: "downloading", attempt: index + 1,
                progress: (downloaded * 99 / spec.size) as u32, downloaded, total: spec.size,
                bytes_per_second: speed, reason: None });
            last_emit = Instant::now();
        }
    }
    notify(Transfer { source: candidate.source, phase: "verifying", attempt: index + 1,
        progress: 99, downloaded, total: spec.size, bytes_per_second: 0.0, reason: None });
    if downloaded != spec.size || format!("{:x}", digest.finalize()) != spec.sha256 {
        return Err(Failure::new(Reason::Invalid, "安装包未通过大小或 SHA-256 校验"));
    }
    let mut header = [0u8; 2];
    use std::io::Read;
    fs::File::open(path).and_then(|mut f| f.read_exact(&mut header))
        .map_err(|_| Failure::new(Reason::Invalid, "无法读取安装包"))?;
    if header != *b"MZ" { return Err(Failure::new(Reason::Invalid, "返回内容不是 Windows 安装包")); }
    file.sync_all().map_err(|_| Failure::new(Reason::Invalid, "安装包保存失败"))?;
    Ok(())
}

async fn download_with_clients<F: FnMut(Transfer) + Send>(
    spec: &Spec, directory: &Path, direct: &Client, system: &Client, policy: Policy, mut notify: F,
) -> Result<PathBuf, String> {
    let mut previous = None;
    let mut errors = Vec::new();
    for (index, candidate) in spec.candidates.iter().enumerate() {
        if index > 0 {
            notify(Transfer { source: candidate.source, phase: "switching", attempt: index + 1,
                progress: 0, downloaded: 0, total: spec.size, bytes_per_second: 0.0, reason: previous });
        }
        notify(Transfer { source: candidate.source, phase: "downloading", attempt: index + 1,
            progress: 0, downloaded: 0, total: spec.size, bytes_per_second: 0.0, reason: None });
        let partial = directory.join(format!("installer-{}.part", index + 1));
        let client = match candidate.route { Route::Direct => direct, Route::System => system };
        let result = tokio::time::timeout(policy.total,
            attempt(spec, candidate, index, &partial, client, policy, &mut notify)).await
            .unwrap_or_else(|_| Err(Failure::new(Reason::Timeout, "下载总时长超限")));
        match result {
            Ok(()) => {
                let complete = directory.join(&spec.filename);
                fs::rename(&partial, &complete).map_err(|_| "无法保存已校验安装包")?;
                notify(Transfer { source: candidate.source, phase: "installing", attempt: index + 1,
                    progress: 100, downloaded: spec.size, total: spec.size, bytes_per_second: 0.0, reason: None });
                return Ok(complete);
            }
            Err(error) => {
                let _ = fs::remove_file(&partial);
                previous = Some(error.reason);
                let name = if candidate.source == Source::Mirror { "国内下载源" } else { "官方备用源" };
                errors.push(format!("{name}：{}", error.message));
            }
        }
    }
    log::warn!("Automatic updater exhausted sources: {}", errors.join("; "));
    Err(format!("UPDATE_SOURCES_FAILED: {}", errors.join("；")))
}

pub(crate) async fn download<F: FnMut(Transfer) + Send>(spec: &Spec, directory: &Path, notify: F) -> Result<PathBuf, String> {
    let direct = route_client_builder(Route::Direct).build().map_err(|_| "无法创建更新下载连接")?;
    let system = route_client_builder(Route::System).build().map_err(|_| "无法创建更新下载连接")?;
    download_with_clients(spec, directory, &direct, &system, Policy::default(), notify).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn bytes() -> Vec<u8> { let mut b = vec![42; 64 * 1024]; b[..2].copy_from_slice(b"MZ"); b }
    fn spec(body: &[u8]) -> Spec {
        Spec::new("https://laogao.xyz/packages/latest/GeoDownloader_3.6.24_windows_x64-setup.exe",
            "3.6.24", &format!("{:x}", Sha256::digest(body)), body.len() as u64).unwrap()
    }
    fn policy() -> Policy {
        Policy { headers: Duration::from_millis(150), idle: Duration::from_millis(100),
            window: Duration::from_millis(100), minimum_bps: 64 * 1024, total: Duration::from_secs(3) }
    }
    enum Behavior { Fast, Slow, LateSlow, NoHeaders, Stalled, Truncated, Rejected, Corrupt, WrongSize, NoLength }
    struct Mock { url: String, count: Arc<AtomicUsize>, task: tokio::task::JoinHandle<()> }
    impl Drop for Mock { fn drop(&mut self) { self.task.abort(); } }
    async fn mock(body: Vec<u8>, behavior: Behavior) -> Mock {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/installer", listener.local_addr().unwrap());
        let count = Arc::new(AtomicUsize::new(0)); let observed = count.clone();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096]; socket.read(&mut request).await.unwrap();
            observed.fetch_add(1, Ordering::SeqCst);
            if matches!(behavior, Behavior::NoHeaders) { tokio::time::sleep(Duration::from_secs(5)).await; return; }
            if matches!(behavior, Behavior::Rejected) {
                let _ = socket.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await; return;
            }
            let header = if matches!(behavior, Behavior::NoLength) {
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_owned()
            } else { format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                if matches!(behavior, Behavior::WrongSize) { body.len() - 1 } else { body.len() }) };
            socket.write_all(header.as_bytes()).await.unwrap();
            match behavior {
                Behavior::Stalled => tokio::time::sleep(Duration::from_secs(5)).await,
                Behavior::Truncated => { let _ = socket.write_all(&body[..body.len() / 2]).await; }
                Behavior::Slow | Behavior::LateSlow => {
                    if matches!(behavior, Behavior::LateSlow) { let _ = socket.write_all(&body[..body.len() / 2]).await; }
                    for _ in 0..1000 {
                        if socket.write_all(b"x").await.is_err() { break; }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
                Behavior::Corrupt => { let _ = socket.write_all(&vec![0; body.len()]).await; }
                _ => { let _ = socket.write_all(&body).await; }
            }
        });
        Mock { url, count, task }
    }
    fn candidates(spec: &mut Spec, first: &Mock, second: &Mock) {
        // Never leave a real third candidate in an isolated mock test.
        spec.candidates = vec![
            Candidate { source: Source::Mirror, route: Route::Direct, url: first.url.clone() },
            Candidate { source: Source::Github, route: Route::System, url: second.url.clone() },
        ];
    }
    fn local_client() -> Client { Client::builder().no_proxy().build().unwrap() }
    async fn download_with_client<F: FnMut(Transfer) + Send>(
        spec: &Spec, directory: &Path, client: &Client, policy: Policy, notify: F,
    ) -> Result<PathBuf, String> {
        download_with_clients(spec, directory, client, client, policy, notify).await
    }

    #[test]
    fn candidate_versions_and_integrity_are_fixed_before_network_access() {
        let body = bytes(); let s = spec(&body);
        assert_eq!(s.candidates.len(), 3);
        assert_eq!(s.candidates[0].route, Route::Direct);
        assert_eq!(s.candidates[1].route, Route::System);
        assert_eq!(s.candidates[0].url, s.candidates[1].url);
        assert!(s.candidates[2].url.contains("/releases/download/v3.6.24/GeoDownloader_3.6.24_"));
        let reverse = Spec::new(&s.candidates[2].url, "3.6.24", &s.sha256, s.size).unwrap();
        assert_eq!(reverse.candidates[0].source, Source::Mirror);
        assert_eq!(reverse.candidates[0].route, Route::Direct);
        assert_eq!(reverse.candidates[2].source, Source::Github);
        for url in ["https://laogao.xyz.evil.test/installer.exe", "http://laogao.xyz/packages/latest/installer.exe",
            "https://laogao.xyz/packages/latest/GeoDownloader_3.6.23_windows_x64-setup.exe"] {
            assert!(Spec::new(url, "3.6.24", &s.sha256, s.size).is_err());
        }
        assert!(Spec::new(&s.candidates[0].url, "../../bad", &s.sha256, s.size).is_err());
        assert!(Spec::new(&s.candidates[0].url, "3.6.24", "bad-hash", s.size).is_err());
        assert!(Spec::new(&s.candidates[0].url, "3.6.24", &s.sha256, 0).is_err());
    }

    #[test]
    fn updater_guard_releases_after_failure_or_completion() {
        let guard = lock_update().unwrap();
        assert!(lock_update().is_err());
        drop(guard);
        assert!(lock_update().is_ok());
    }

    #[tokio::test]
    async fn healthy_primary_is_verified_without_contacting_backup() {
        let body = bytes(); let mut s = spec(&body);
        let a = mock(body.clone(), Behavior::Fast).await; let b = mock(body.clone(), Behavior::Fast).await;
        candidates(&mut s, &a, &b); let dir = tempfile::tempdir().unwrap(); let mut events = vec![];
        let path = download_with_client(&s, dir.path(), &local_client(), policy(), |e| events.push(e)).await.unwrap();
        assert_eq!(fs::read(path).unwrap(), body);
        assert_eq!(b.count.load(Ordering::SeqCst), 0);
        assert!(!events.iter().any(|e| e.phase == "switching"));
        assert_eq!(events.last().unwrap().progress, 100);
        assert!(events.iter().filter(|e| e.phase != "installing").all(|e| e.progress < 100));
    }

    #[tokio::test]
    async fn domestic_direct_does_not_contact_the_configured_proxy() {
        let body = bytes(); let mut s = spec(&body);
        let origin = mock(body.clone(), Behavior::Fast).await;
        let proxy = mock(body.clone(), Behavior::Rejected).await;
        s.candidates[0].url = origin.url.clone();
        let system = client_builder().no_proxy().proxy(reqwest::Proxy::all(&proxy.url).unwrap()).build().unwrap();
        let direct = route_client_builder(Route::Direct).build().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = download_with_clients(&s, dir.path(), &direct, &system, policy(), |_| {}).await.unwrap();
        assert_eq!(fs::read(path).unwrap(), body);
        assert_eq!(origin.count.load(Ordering::SeqCst), 1);
        assert_eq!(proxy.count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn failed_direct_recovers_through_proxy_to_the_same_domestic_url() {
        let body = bytes(); let mut s = spec(&body);
        let origin = mock(body.clone(), Behavior::Rejected).await;
        let proxy = mock(body.clone(), Behavior::Fast).await;
        s.candidates[0].url = origin.url.clone(); s.candidates[1].url = origin.url.clone();
        let system = client_builder().no_proxy().proxy(reqwest::Proxy::all(&proxy.url).unwrap()).build().unwrap();
        let dir = tempfile::tempdir().unwrap(); let mut events = vec![];
        let path = download_with_clients(&s, dir.path(), &local_client(), &system, policy(), |e| events.push(e)).await.unwrap();
        assert_eq!(fs::read(path).unwrap(), body);
        assert_eq!(origin.count.load(Ordering::SeqCst), 1);
        assert_eq!(proxy.count.load(Ordering::SeqCst), 1);
        assert!(events.iter().any(|e| e.phase == "switching" && e.source == Source::Mirror && e.attempt == 2));
        assert_eq!(events.last().unwrap().attempt, 2);
    }

    async fn three_routes(backup_behavior: Behavior, succeeds: bool) {
        let body = bytes(); let mut s = spec(&body);
        let origin = mock(body.clone(), Behavior::Rejected).await;
        let domestic_proxy = mock(body.clone(), Behavior::Corrupt).await;
        let github_proxy = mock(body.clone(), backup_behavior).await;
        s.candidates[0].url = origin.url.clone(); s.candidates[1].url = origin.url.clone();
        s.candidates[2].url = "http://github-update.test/installer".into();
        let domestic_url = domestic_proxy.url.clone(); let github_url = github_proxy.url.clone();
        let system = client_builder().no_proxy().proxy(reqwest::Proxy::custom(move |url| {
            Some(if url.host_str() == Some("github-update.test") { github_url.clone() } else { domestic_url.clone() })
        })).build().unwrap();
        let dir = tempfile::tempdir().unwrap(); let mut events = vec![];
        let result = download_with_clients(&s, dir.path(), &local_client(), &system, policy(), |e| events.push(e)).await;
        assert_eq!(origin.count.load(Ordering::SeqCst), 1);
        assert_eq!(domestic_proxy.count.load(Ordering::SeqCst), 1);
        assert_eq!(github_proxy.count.load(Ordering::SeqCst), 1);
        assert!(events.iter().any(|e| e.phase == "switching" && e.source == Source::Github
            && e.attempt == 3 && e.reason == Some(Reason::Invalid)));
        if succeeds {
            assert_eq!(fs::read(result.unwrap()).unwrap(), body);
            assert_eq!(events.last().unwrap().attempt, 3);
            assert_eq!(events.last().unwrap().progress, 100);
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        } else {
            assert!(result.unwrap_err().starts_with("UPDATE_SOURCES_FAILED:"));
            assert!(events.iter().all(|e| e.progress < 100));
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    }

    #[tokio::test]
    async fn github_backup_retains_proxy_after_both_domestic_routes_fail() { three_routes(Behavior::Fast, true).await; }
    #[tokio::test]
    async fn all_three_routes_fail_without_installation_or_partial_files() { three_routes(Behavior::Corrupt, false).await; }

    async fn switches(behavior: Behavior, expected: Reason, p: Policy) {
        let body = bytes(); let mut s = spec(&body);
        let a = mock(body.clone(), behavior).await; let b = mock(body.clone(), Behavior::Fast).await;
        candidates(&mut s, &a, &b); let dir = tempfile::tempdir().unwrap(); let mut events = vec![];
        let path = download_with_client(&s, dir.path(), &local_client(), p, |e| events.push(e)).await.unwrap();
        assert_eq!(fs::read(path).unwrap(), body);
        assert!(events.iter().any(|e| e.phase == "switching" && e.source == Source::Github
            && e.reason == Some(expected) && e.progress == 0));
        assert_eq!(a.count.load(Ordering::SeqCst), 1);
        assert_eq!(b.count.load(Ordering::SeqCst), 1);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        assert_eq!(events.last().unwrap().progress, 100);
    }
    #[tokio::test] async fn low_throughput_switches_automatically() { switches(Behavior::Slow, Reason::Slow, policy()).await; }
    #[tokio::test] async fn http_error_switches_automatically() { switches(Behavior::Rejected, Reason::Unavailable, policy()).await; }
    #[tokio::test] async fn header_timeout_switches_automatically() { switches(Behavior::NoHeaders, Reason::Timeout, policy()).await; }
    #[tokio::test] async fn stalled_body_switches_automatically() { switches(Behavior::Stalled, Reason::Timeout, policy()).await; }
    #[tokio::test] async fn truncated_body_is_not_combined_with_backup() { switches(Behavior::Truncated, Reason::Unavailable, policy()).await; }
    #[tokio::test] async fn checksum_failure_switches_before_installation() { switches(Behavior::Corrupt, Reason::Invalid, policy()).await; }
    #[tokio::test] async fn wrong_response_size_switches_before_writing() { switches(Behavior::WrongSize, Reason::Invalid, policy()).await; }
    #[tokio::test]
    async fn slowdown_after_an_initial_burst_is_detected() {
        let mut p = policy(); p.idle = Duration::from_millis(500); p.window = Duration::from_millis(200);
        switches(Behavior::LateSlow, Reason::Slow, p).await;
    }
    #[tokio::test]
    async fn total_attempt_time_is_bounded() {
        let mut p = policy(); p.idle = Duration::from_secs(2); p.total = Duration::from_millis(300);
        switches(Behavior::Stalled, Reason::Timeout, p).await;
    }
    #[tokio::test]
    async fn both_sources_fail_without_complete_file_or_false_100_percent() {
        let body = bytes(); let mut s = spec(&body);
        let a = mock(body.clone(), Behavior::Corrupt).await; let b = mock(body, Behavior::Corrupt).await;
        candidates(&mut s, &a, &b); let dir = tempfile::tempdir().unwrap(); let mut events = vec![];
        let error = download_with_client(&s, dir.path(), &local_client(), policy(), |e| events.push(e)).await.unwrap_err();
        assert!(error.starts_with("UPDATE_SOURCES_FAILED:"));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        assert!(events.iter().all(|e| e.progress < 100));
    }
    #[tokio::test]
    async fn unknown_content_length_still_requires_correct_hash_and_size() {
        let body = bytes(); let mut s = spec(&body);
        let a = mock(body.clone(), Behavior::NoLength).await; let b = mock(body.clone(), Behavior::Fast).await;
        candidates(&mut s, &a, &b); let dir = tempfile::tempdir().unwrap();
        let path = download_with_client(&s, dir.path(), &local_client(), policy(), |_| {}).await.unwrap();
        assert_eq!(fs::read(path).unwrap(), body);
        assert_eq!(b.count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn redirects_remain_https_and_on_official_delivery_hosts() {
        for url in ["https://github.com/gaopengbin/geo-downloader", "https://release-assets.githubusercontent.com/file", "https://laogao.xyz/packages/file", "https://download.laogao.xyz/agent-updates/windows-x86_64/3.6.24/installer.exe"] {
            assert!(official_redirect(&Url::parse(url).unwrap()));
        }
        for url in ["http://github.com/file", "https://github.com.evil.test/file", "https://127.0.0.1/file", "https://user:secret@github.com/file", "https://github.com:444/file"] {
            assert!(!official_redirect(&Url::parse(url).unwrap()));
        }
    }

    #[tokio::test]
    async fn a_matching_hash_cannot_turn_html_into_an_installer() {
        let body = b"<html>not an installer</html>".to_vec(); let mut s = spec(&body);
        let a = mock(body.clone(), Behavior::Fast).await; let b = mock(body, Behavior::Fast).await;
        candidates(&mut s, &a, &b); let dir = tempfile::tempdir().unwrap(); let mut events = vec![];
        assert!(download_with_client(&s, dir.path(), &local_client(), policy(), |e| events.push(e)).await.is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        assert!(events.iter().all(|e| e.progress < 100));
    }

    #[tokio::test]
    #[ignore = "Bounded real installer route diagnostics; downloads only, never installs or changes proxy settings"]
    async fn diagnose_real_installer_routes() {
        let out = PathBuf::from(std::env::var("GEOD_UPDATE_QA_OUTPUT").expect("Set isolated QA output directory"));
        fs::create_dir_all(&out).unwrap();
        let version = "3.6.26";
        let filename = format!("GeoDownloader_{version}_windows_x64-setup.exe");
        let mirror = format!("https://laogao.xyz/packages/latest/{filename}");
        let origin = format!("https://laogao.xyz/packages/v{version}/{filename}");
        let cdn = format!("https://download.laogao.xyz/agent-updates/windows-x86_64/{version}/{filename}");
        async fn probe(label: &'static str, client: Client, url: String) -> serde_json::Value {
            let started = Instant::now();
            let response = tokio::time::timeout(Duration::from_secs(10), client.get(&url).header("User-Agent", "GeoDownloader").send()).await;
            let mut response = match response {
                Ok(Ok(response)) => response,
                _ => return serde_json::json!({"route":label,"failed":"headers","seconds":started.elapsed().as_secs_f64()}),
            };
            let status = response.status().as_u16(); let protocol = format!("{:?}", response.version());
            let peer = response.remote_addr().map(|value| value.to_string());
            let host = response.url().host_str().map(str::to_owned);
            let expected = response.content_length(); let mut received = 0u64; let mut hash = Sha256::new();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
            loop {
                match tokio::time::timeout_at(deadline, response.chunk()).await {
                    Ok(Ok(Some(bytes))) => { received += bytes.len() as u64; hash.update(&bytes); }
                    _ => break,
                }
            }
            let seconds = started.elapsed().as_secs_f64();
            serde_json::json!({"route":label,"status":status,"protocol":protocol,"peer":peer,"host":host,
                "expected":expected,"received":received,"seconds":seconds,"bytes_per_second":received as f64 / seconds.max(0.001),
                "complete":status==200 && expected==Some(received),"sha256":if status==200 && expected==Some(received){Some(format!("{:x}",hash.finalize()))}else{None},
                "installerLaunched":false,"globalProxyChanged":false})
        }
        let routes = [
            ("legacy-default", Client::new(), mirror.clone()),
            ("updater-default", client_builder().build().unwrap(), mirror.clone()),
            ("updater-direct", client_builder().no_proxy().build().unwrap(), mirror.clone()),
            ("updater-direct-http1", client_builder().no_proxy().http1_only().build().unwrap(), mirror),
            ("cdn-direct-http1", client_builder().no_proxy().http1_only().build().unwrap(), cdn),
            ("origin-direct", client_builder().no_proxy().build().unwrap(), origin),
        ];
        let jobs = routes.into_iter().map(|(label,client,url)| tokio::spawn(probe(label,client,url))).collect::<Vec<_>>();
        let mut results = Vec::new();
        for job in jobs { let result = job.await.unwrap(); println!("{}", result); results.push(result); }
        fs::write(out.join("route-diagnostics.json"), serde_json::to_vec_pretty(&results).unwrap()).unwrap();
    }

    #[tokio::test]
    #[ignore = "Real production downloader with current system proxy; verifies package without launching installer"]
    async fn live_production_route_download_without_installation() {
        let out = PathBuf::from(std::env::var("GEOD_UPDATE_QA_OUTPUT").expect("Set isolated QA output directory"));
        fs::create_dir_all(&out).unwrap();
        let s = if let Ok(manifest) = std::env::var("GEOD_UPDATE_QA_MANIFEST") {
            let data: serde_json::Value=serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
            let version=data["tag_name"].as_str().unwrap().strip_prefix('v').unwrap();
            let asset=data["assets"].as_array().unwrap().iter().find(|asset|asset["name"].as_str().is_some_and(|name|name.ends_with("_windows_x64-setup.exe"))).unwrap();
            Spec::new(asset["browser_download_url"].as_str().unwrap(),version,asset["sha256"].as_str().unwrap(),asset["size"].as_u64().unwrap()).unwrap()
        } else {
            Spec::new("https://laogao.xyz/packages/latest/GeoDownloader_3.6.26_windows_x64-setup.exe",
                "3.6.26", "9ce801593e4331459e4972a9be6fc2595fcb653f46e6e4f65a417ce8976c3307", 10606568).unwrap()
        };
        let dir = tempfile::tempdir().unwrap(); let mut events = vec![]; let started = Instant::now();
        let path = download(&s, dir.path(), |e| events.push(e)).await.unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), s.size);
        assert_eq!(format!("{:x}", Sha256::digest(fs::read(&path).unwrap())), s.sha256);
        assert_eq!(events.last().unwrap().progress, 100);
        let receipt = serde_json::json!({"passed":true,"seconds":started.elapsed().as_secs_f64(),
            "filename":s.filename,"bytes":s.size,"sha256":s.sha256,"events":events,"installerLaunched":false,"globalProxyChanged":false});
        println!("{}", receipt);
        fs::write(out.join("production-route.json"), serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }

    #[tokio::test]
    #[ignore = "Downloads the real public installer through a controlled slow-primary failover; never installs"]
    async fn live_slow_primary_to_verified_official_backup() {
        let out = PathBuf::from(std::env::var("GEOD_UPDATE_QA_OUTPUT").expect("Set isolated QA output directory"));
        fs::create_dir_all(&out).unwrap();
        let mut s = Spec::new("https://laogao.xyz/packages/latest/GeoDownloader_3.6.24_windows_x64-setup.exe",
            "3.6.24", "230762542abecb8856910424be726b326e451947fe0428c9a8ad520af2b41b05", 10505425).unwrap();
        s.candidates.remove(1); // This test specifically exercises domestic -> GitHub.
        let primary = mock(vec![0; s.size as usize], Behavior::Slow).await;
        s.candidates[0].url = primary.url.clone();
        let proxy = std::env::var("GEOD_UPDATE_QA_PROXY").expect("Set the existing local proxy for GitHub, mock stays direct");
        let client = client_builder().proxy(reqwest::Proxy::custom(move |url| {
            if url.host_str() == Some("127.0.0.1") { None } else { Some(proxy.clone()) }
        })).build().unwrap();
        let dir = tempfile::tempdir().unwrap(); let mut events = vec![]; let started = Instant::now();
        let path = download_with_client(&s, dir.path(), &client, Policy::default(), |event| events.push(event)).await.unwrap();
        assert!(events.iter().any(|e| e.phase == "switching" && e.reason == Some(Reason::Slow)));
        assert_eq!(events.last().unwrap().source, Source::Github);
        assert_eq!(fs::metadata(&path).unwrap().len(), s.size);
        fs::copy(&path, out.join("verified-installer.bin")).unwrap();
        fs::write(out.join("native-live.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "passed":true,"seconds":started.elapsed().as_secs_f64(),"sha256":s.sha256,
            "bytes":s.size,"events":events,"primaryRequests":primary.count.load(Ordering::SeqCst),
            "installerLaunched":false,"globalProxyChanged":false,
        })).unwrap()).unwrap();
    }
}
