//! Real legacy updater transport, isolated downloads only; never launches installers.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, time::{Duration, Instant}};

#[tokio::test]
#[ignore = "Requires an isolated GEOD_LEGACY_PROBE_CONFIG and real public downloads"]
async fn verify_legacy_updater_delivery() {
    let config: Value = serde_json::from_slice(&fs::read(std::env::var("GEOD_LEGACY_PROBE_CONFIG").unwrap()).unwrap()).unwrap();
    let mut results = vec![];
    for case in config["cases"].as_array().unwrap() {
        let url = reqwest::Url::parse(case["url"].as_str().unwrap()).unwrap();
        assert_eq!(url.scheme(), "https");
        assert!(matches!(url.host_str(), Some("laogao.xyz" | "download.laogao.xyz" | "github.com")));
        let start = Instant::now();
        let mut result = json!({"label":case["label"],"installerLaunched":false,"globalProxyChanged":false});
        // Match the old updater's default proxy/connection behavior. Only the
        // whole probe is bounded, so diagnostics cannot leave a hanging test.
        let mut client = reqwest::Client::builder().timeout(Duration::from_secs(45));
        if case["direct"].as_bool().unwrap_or(false) { client = client.no_proxy(); }
        let run = async {
            let mut response = client.build().map_err(|_| "client")?.get(url).header("User-Agent", "GeoDownloader").send().await.map_err(|error| {
                result["failedHost"] = json!(error.url().and_then(|url| url.host_str()));
                result["timeout"] = json!(error.is_timeout());
                result["connectError"] = json!(error.is_connect());
                "headers"
            })?;
            result["status"] = json!(response.status().as_u16());
            result["finalHost"] = json!(response.url().host_str());
            result["peer"] = json!(response.remote_addr().map(|p| p.to_string()));
            result["protocol"] = json!(format!("{:?}", response.version()));
            if response.status().as_u16() != 200 { return Err("status"); }
            if response.content_length() != case["size"].as_u64() { return Err("size_header"); }
            let mut bytes = 0u64; let mut digest = Sha256::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "body")? {
                bytes += chunk.len() as u64;
                if bytes > case["size"].as_u64().unwrap() { return Err("oversize"); }
                digest.update(chunk);
                result["bytes"] = json!(bytes);
            }
            let hash = format!("{:x}", digest.finalize());
            result["sha256"] = json!(hash);
            if bytes != case["size"].as_u64().unwrap() || hash != case["sha256"].as_str().unwrap() { return Err("integrity"); }
            Ok::<(), &str>(())
        }.await;
        result["seconds"] = json!(start.elapsed().as_secs_f64());
        result["passed"] = json!(run.is_ok());
        result["error"] = json!(run.err());
        println!("{}", result); results.push(result);
    }
    let path = PathBuf::from(config["output"].as_str().unwrap());
    fs::write(path, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
    if config["requireAll"].as_bool().unwrap_or(true) {
        assert!(results.iter().all(|r| r["passed"] == true), "A route failed; see isolated result file");
    }
}
