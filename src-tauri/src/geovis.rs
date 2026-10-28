//! Geovis credentials and entitlement probes. Public source URLs never contain a token.
use crate::config::TileSource;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, time::Duration};

const SERVICE: &str = "xyz.laogao.geod.sources";
const ACCOUNT: &str = "geovis-token";
const ORIGIN: &str = "https://api.open.geovisearth.com";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Capability {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub code: Option<i64>,
    pub message: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GeovisStatus {
    pub configured: bool,
    pub checked_at: Option<String>,
    pub capabilities: Vec<Capability>,
}

fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| "无法访问系统凭据库".into())
}

pub fn get_token() -> Result<Option<String>, String> {
    match credential()?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取星图 Key，请检查系统凭据库".into()),
    }
}

fn status_path() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|p| p.join("geo-downloader").join("geovis-access.json"))
        .ok_or_else(|| "无法获取应用数据目录".into())
}

fn clear_status() -> Result<(), String> {
    let path = status_path()?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法清除旧星图权限记录".into()),
    }
}

pub fn geovis_set_token(token: String) -> Result<(), String> {
    let value = token.trim();
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("请输入有效的星图 Key".into());
    }
    // Invalidate the old account's grants before changing credentials.
    clear_status()?;
    credential()?
        .set_password(value)
        .map_err(|_| "无法保存星图 Key 到系统凭据库".into())
}

pub fn geovis_delete_token() -> Result<(), String> {
    clear_status()?;
    match credential()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法删除星图 Key".into()),
    }
}

pub fn geovis_status() -> Result<GeovisStatus, String> {
    let configured = get_token()?.is_some();
    if !configured {
        return Ok(GeovisStatus::default());
    }
    let mut status = status_path()
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<GeovisStatus>(&b).ok())
        .unwrap_or_default();
    status.configured = true;
    Ok(status)
}

pub fn source(id: &str) -> Option<TileSource> {
    let (name, path) = match id {
        "geovis_2025" => ("星图 2025 影像", "2025"),
        "geovis_2021" => ("星图 2021 历史影像", "2021/img"),
        "geovis_2022" => ("星图 2022 历史影像", "2022/img"),
        _ => return None,
    };
    Some(TileSource {
        headers: Default::default(),
        id: id.into(),
        name: name.into(),
        url: format!("{ORIGIN}/pj/base/v1/{path}/{{z}}/{{x}}/{{y}}?format=webp&tmsIds=w"),
        subdomains: vec![],
        max_zoom: 18,
        attribution: "© 中科星图 / Geovis Earth".into(),
    })
}

pub fn available_sources() -> HashMap<String, TileSource> {
    geovis_status()
        .ok()
        .into_iter()
        .flat_map(|s| s.capabilities)
        .filter(|c| c.available)
        .filter_map(|c| source(&c.id).map(|s| (s.id.clone(), s)))
        .collect()
}

pub fn is_geovis_url(raw: &str) -> bool {
    reqwest::Url::parse(raw).ok().is_some_and(|u| {
        u.scheme() == "https"
            && u.host_str() == Some("api.open.geovisearth.com")
            && u.port_or_known_default() == Some(443)
            && u.username().is_empty()
            && u.password().is_none()
            && u.fragment().is_none()
            && (u.path().starts_with("/pj/base/v1/") || u.path() == "/v2/history/years/city")
    })
}

fn authenticated_url(raw: &str, token: &str) -> Result<reqwest::Url, String> {
    if !is_geovis_url(raw) {
        return Err("星图鉴权仅支持官方 HTTPS 接口".into());
    }
    let mut url = reqwest::Url::parse(raw).map_err(|_| "星图服务地址错误")?;
    if url
        .query_pairs()
        .any(|(key, _)| key.eq_ignore_ascii_case("token"))
    {
        return Err("星图图源地址不能包含 Key，请在星图授权中单独保存".into());
    }
    url.query_pairs_mut().append_pair("token", token);
    Ok(url)
}

/// Attach the native credential only to known provider endpoints. Callers must disable redirects.
pub fn request(client: &reqwest::Client, raw: &str) -> Result<reqwest::RequestBuilder, String> {
    if !is_geovis_url(raw) {
        return Ok(client.get(raw));
    }
    let token = get_token()?.ok_or("TILE_ACCESS_DENIED: 请先在图源管理中保存星图 Key")?;
    Ok(client.get(authenticated_url(raw, &token)?))
}

pub fn business_error(bytes: &[u8]) -> Option<(i64, String)> {
    let json: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let code = json
        .get("code")?
        .as_i64()
        .or_else(|| json.get("code")?.as_str()?.parse().ok())?;
    let message = match code {
        102 => "星图 Key 无效或不存在，请更新 Key".to_string(),
        128 => "当前 Key 未开通此星图接口，请先开通对应接口权益，再为 Key 勾选 API".to_string(),
        _ => format!("星图接口返回业务错误 {code}，请检查接口权益、额度及服务状态"),
    };
    // Never echo arbitrary provider text: it can contain request URLs or tokens.
    Some((code, format!("TILE_ACCESS_DENIED: {message}")))
}

pub fn validate_tile(bytes: &[u8]) -> Result<(), String> {
    if let Some((_, message)) = business_error(bytes) {
        return Err(message);
    }
    let image = image::load_from_memory(bytes).map_err(|_| "星图返回的内容不是有效影像")?;
    if image.width() != 256 || image.height() != 256 {
        return Err("星图瓦片尺寸异常".into());
    }
    Ok(())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("GeoD/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "无法创建星图连接".into())
}

async fn bounded_body(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("星图 HTTP {}", response.status().as_u16()));
    }
    const MAX: usize = 4 * 1024 * 1024;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| e.without_url().to_string())?
    {
        if chunk.len() > MAX.saturating_sub(bytes.len()) {
            return Err("星图响应超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub async fn fetch_tile(id: &str, z: u8, x: u32, y: u32) -> Result<Vec<u8>, String> {
    let source = source(id).ok_or("未知星图图源")?;
    if z > source.max_zoom || x >= (1u32 << z) || y >= (1u32 << z) {
        return Err("星图瓦片坐标或级别超出范围".into());
    }
    let url = source
        .url
        .replace("{z}", &z.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y.to_string());
    let response = request(&client()?, &url)?
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    let bytes = bounded_body(response).await?;
    validate_tile(&bytes)?;
    Ok(bytes)
}

pub async fn geovis_preview_tile(
    source_key: String,
    z: u8,
    x: u32,
    y: u32,
) -> Result<String, String> {
    let bytes = fetch_tile(&source_key, z, x, y).await?;
    Ok(format!(
        "data:image/webp;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

pub async fn geovis_probe_access() -> Result<GeovisStatus, String> {
    get_token()?.ok_or("请先保存星图 Key")?;
    let http = client()?;
    let mut capabilities = Vec::new();
    for (id, name, url, is_tile) in [
        (
            "geovis_2025",
            "2025 影像",
            format!("{ORIGIN}/pj/base/v1/2025/17/107151/53824?format=webp&tmsIds=w"),
            true,
        ),
        (
            "geovis_2021",
            "2021 历史影像",
            format!("{ORIGIN}/pj/base/v1/2021/img/17/107151/53824?format=webp&tmsIds=w"),
            true,
        ),
        (
            "geovis_2022",
            "2022 历史影像",
            format!("{ORIGIN}/pj/base/v1/2022/img/17/107151/53824?format=webp&tmsIds=w"),
            true,
        ),
        (
            "geovis_city_history",
            "城市历史查询",
            format!("{ORIGIN}/v2/history/years/city?cityname=hefei"),
            false,
        ),
    ] {
        let result = async {
            let response = request(&http, &url)?
                .send()
                .await
                .map_err(|e| e.without_url().to_string())?;
            bounded_body(response).await
        }
        .await;
        let (available, code, message) = match result {
            Err(message) => (false, None, message),
            Ok(bytes) => match business_error(&bytes) {
                Some((code, message)) => (
                    false,
                    Some(code),
                    message.trim_start_matches("TILE_ACCESS_DENIED: ").into(),
                ),
                None if is_tile => match validate_tile(&bytes) {
                    Ok(()) => (true, None, "真实影像瓦片验证通过".into()),
                    Err(message) => (false, None, message),
                },
                None => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                    Ok(value) if value.get("hefei").is_some_and(|v| v.is_array()) => {
                        (true, None, "城市历史目录验证通过".into())
                    }
                    _ => (false, None, "星图历史目录响应格式不符合预期".into()),
                },
            },
        };
        capabilities.push(Capability {
            id: id.into(),
            name: name.into(),
            available,
            code,
            message,
        });
    }
    let status = GeovisStatus {
        configured: true,
        checked_at: Some(chrono::Utc::now().to_rfc3339()),
        capabilities,
    };
    let path = status_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "无法创建星图权限记录目录")?;
    }
    crate::fs_util::atomic_write(
        &path,
        &serde_json::to_vec_pretty(&status).map_err(|_| "无法编码星图权限记录")?,
    )
    .map_err(|_| "无法保存星图权限记录")?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_only_go_to_exact_https_origin_and_are_never_in_public_sources() {
        for raw in [
            "https://api.open.geovisearth.com.evil.test/pj/base/v1/x",
            "http://api.open.geovisearth.com/pj/base/v1/x",
            "https://api.open.geovisearth.com:8443/pj/base/v1/x",
            "https://user@api.open.geovisearth.com/pj/base/v1/x",
            "https://api.open.geovisearth.com/other",
        ] {
            assert!(!is_geovis_url(raw));
            assert!(authenticated_url(raw, "test-secret").is_err());
        }
        for id in ["geovis_2025", "geovis_2021", "geovis_2022"] {
            let source = source(id).unwrap();
            assert!(!source.url.contains("token"));
            let url = authenticated_url(&source.url, "test-secret").unwrap();
            assert_eq!(url.query_pairs().filter(|(k, _)| k == "token").count(), 1);
            assert!(
                authenticated_url(&format!("{}&token=inline", source.url), "test-secret").is_err()
            );
        }
    }

    #[test]
    fn business_errors_are_terminal_and_do_not_echo_provider_secrets() {
        for code in [102, 128, 999] {
            let json = format!(r#"{{"code":{code},"msg":"https://example.test/?token=secret"}}"#);
            let (_, error) = business_error(json.as_bytes()).unwrap();
            assert!(crate::tile_policy::is_terminal_download_error(&error));
            assert!(!error.contains("secret"));
            assert!(validate_tile(json.as_bytes()).is_err());
        }
        assert!(validate_tile(b"<html>login</html>").is_err());
    }
}
