use super::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf, time::Duration};

pub const ROOT: &str = "https://kh.google.com/rt/tm/earth/";
pub fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn directory() -> Result<PathBuf> {
    let path = dirs::data_local_dir()
        .ok_or("EARTH_CACHE: local data directory unavailable")?
        .join("geo-downloader/earth-history/v1");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
pub fn allowed(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("kh.google.com")
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && [
                "PlanetoidMetadata",
                "BulkMetadata/pb=",
                "NodeData/pb=",
                "Copyrights/pb=",
            ]
            .iter()
            .any(|prefix| {
                url.path()
                    .strip_prefix("/rt/tm/earth/")
                    .is_some_and(|tail| {
                        if *prefix == "PlanetoidMetadata" {
                            tail == *prefix
                        } else {
                            tail.starts_with(prefix)
                        }
                    })
            })
    })
}
pub fn decode_body(raw: &[u8]) -> Result<Vec<u8>> {
    if raw.len() > 16 * 1024 * 1024 {
        return Err("EARTH_BUDGET: response exceeds 16 MiB".into());
    }
    let mut output = Vec::new();
    if raw.starts_with(&[0x1f, 0x8b]) {
        flate2::read::GzDecoder::new(raw)
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut output)
            .map_err(|_| "EARTH_PROTOCOL: invalid gzip response")?;
    } else {
        output.extend_from_slice(raw);
    }
    if output.len() > 32 * 1024 * 1024 {
        return Err("EARTH_BUDGET: expanded packet exceeds 32 MiB".into());
    }
    Ok(output)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub url: String,
    pub wire_sha256: String,
    pub decoded_sha256: String,
    pub wire_bytes: usize,
    pub decoded_bytes: usize,
    pub checked_at: i64,
}
pub struct Packet {
    pub bytes: Vec<u8>,
    pub evidence: Evidence,
}
pub struct Transport {
    client: reqwest::Client,
    pub requests: usize,
    pub wire_bytes: usize,
    max_requests: usize,
    max_bytes: usize,
}
impl Transport {
    pub fn client(&self) -> reqwest::Client {
        self.client.clone()
    }
    pub fn with_client(client: reqwest::Client, max_requests: usize, max_bytes: usize) -> Self {
        Self {
            client,
            requests: 0,
            wire_bytes: 0,
            max_requests,
            max_bytes,
        }
    }
    pub fn new(proxy: Option<&str>, max_requests: usize, max_bytes: usize) -> Result<Self> {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(7))
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::none())
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .user_agent(concat!("GeoD/", env!("CARGO_PKG_VERSION")));
        if let Some(value) = proxy.filter(|s| !s.trim().is_empty()) {
            builder = builder
                .proxy(reqwest::Proxy::all(value).map_err(|_| "EARTH_NETWORK: invalid proxy")?);
        }
        Ok(Self {
            client: builder.build().map_err(|e| e.without_url().to_string())?,
            requests: 0,
            wire_bytes: 0,
            max_requests,
            max_bytes,
        })
    }
    pub async fn get(&mut self, url: &str) -> Result<Packet> {
        if !allowed(url) {
            return Err(
                "EARTH_NETWORK: destination is outside the historical imagery protocol".into(),
            );
        }
        let dir = directory()?;
        let key = sha(url.as_bytes());
        let reference = dir.join(format!("{key}.json"));
        if let Ok(data) = std::fs::read(&reference) {
            if let Ok(evidence) = serde_json::from_slice::<Evidence>(&data) {
                let fresh = !(url.ends_with("PlanetoidMetadata")
                    || url.ends_with("Copyrights/pb="))
                    || chrono::Utc::now().timestamp() - evidence.checked_at < 300;
                if fresh
                    && evidence.url == url
                    && evidence.wire_bytes <= 16 * 1024 * 1024
                    && super::validate_id(&evidence.wire_sha256).is_ok()
                    && super::validate_id(&evidence.decoded_sha256).is_ok()
                {
                    let object = dir.join(format!("{}.packet", evidence.wire_sha256));
                    if let Ok(raw) = std::fs::metadata(&object)
                        .ok()
                        .filter(|m| m.len() == evidence.wire_bytes as u64)
                        .ok_or(())
                        .and_then(|_| std::fs::read(object).map_err(|_| ()))
                    {
                        if raw.len() == evidence.wire_bytes && sha(&raw) == evidence.wire_sha256 {
                            let bytes = decode_body(&raw)?;
                            if sha(&bytes) == evidence.decoded_sha256 {
                                return Ok(Packet { bytes, evidence });
                            }
                        }
                    }
                }
            }
        }
        if self.requests >= self.max_requests {
            return Err(
                "EARTH_BUDGET: request budget reached; narrow the region or lower output detail"
                    .into(),
            );
        }
        self.requests += 1;
        let mut response = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT_ENCODING, "gzip")
            .header(
                reqwest::header::USER_AGENT,
                concat!("GeoD/", env!("CARGO_PKG_VERSION")),
            )
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        if response.status().as_u16() == 404 && url.contains("/NodeData/") {
            return Err("EARTH_NO_DATA: historical packet is unavailable".into());
        }
        if !response.status().is_success() {
            return Err(format!(
                "EARTH_NETWORK: HTTP {}",
                response.status().as_u16()
            ));
        }
        let encoding = response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if response
            .headers()
            .get("x-safety-encoding")
            .is_some_and(|v| !v.as_bytes().is_empty())
        {
            return Err("EARTH_UNSUPPORTED: safety encoding".into());
        }
        if !["", "identity", "gzip"].contains(&encoding.as_str()) {
            return Err("EARTH_UNSUPPORTED: content encoding".into());
        }
        let mut raw = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| e.without_url().to_string())?
        {
            if raw.len() + chunk.len() > 16 * 1024 * 1024
                || self.wire_bytes + chunk.len() > self.max_bytes
            {
                return Err("EARTH_BUDGET: transfer size exceeded".into());
            }
            self.wire_bytes += chunk.len();
            raw.extend_from_slice(&chunk);
        }
        if encoding == "gzip" && !raw.starts_with(&[0x1f, 0x8b]) {
            return Err("EARTH_PROTOCOL: gzip header/body mismatch".into());
        }
        let bytes = decode_body(&raw)?;
        super::wire::parse(&bytes)?;
        let evidence = Evidence {
            url: url.into(),
            wire_sha256: sha(&raw),
            decoded_sha256: sha(&bytes),
            wire_bytes: raw.len(),
            decoded_bytes: bytes.len(),
            checked_at: chrono::Utc::now().timestamp(),
        };
        std::fs::write(dir.join(format!("{}.packet", evidence.wire_sha256)), &raw)
            .map_err(|e| e.to_string())?;
        std::fs::write(reference, serde_json::to_vec(&evidence).unwrap())
            .map_err(|e| e.to_string())?;
        Ok(Packet { bytes, evidence })
    }
}
