//! GeoD account authorization for CLI imagery downloads above zoom 5.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use geod_core::pipeline::{self, Request};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};

const ISSUER: &str = "https://laogao.xyz/geod-mcp";
const RESOURCE: &str = "https://laogao.xyz/geod-mcp/mcp";
pub const FREE_MAX_ZOOM: u8 = 5;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}

fn secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn file() -> Result<PathBuf, String> {
    Ok(crate::sources::home()?.join("account.json"))
}
fn load() -> Result<Option<Session>, String> {
    let path = file()?;
    if !path.exists() {
        return Ok(None);
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 8192 {
        return Err("Invalid GeoD account session".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|_| "Invalid GeoD account session; run geod auth login".into())
}
fn save(session: &Session) -> Result<(), String> {
    let path = file()?;
    fs::create_dir_all(path.parent().ok_or("Invalid account path")?).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let data = serde_json::to_vec(session).map_err(|e| e.to_string())?;
    fs::write(&temporary, data).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

async fn token(input: &[(&str, &str)]) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!("{ISSUER}/oauth/token"))
        .form(input)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "GeoD account service is unavailable".to_string())?;
    if !response.status().is_success() {
        return Err("LOGIN_REQUIRED: GeoD login expired; run geod auth login".into());
    }
    response
        .json()
        .await
        .map_err(|_| "Invalid GeoD account response".into())
}
async fn active_session() -> Result<bool, String> {
    let Some(mut session) = load()? else {
        return Ok(false);
    };
    if session.expires_at <= now() + 60 {
        let value = match token(&[
            ("grant_type", "refresh_token"),
            ("client_id", &session.client_id),
            ("refresh_token", &session.refresh_token),
            ("resource", RESOURCE),
        ])
        .await
        {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        session.access_token = value["access_token"]
            .as_str()
            .ok_or("Invalid GeoD access token")?
            .to_owned();
        session.refresh_token = value["refresh_token"]
            .as_str()
            .ok_or("Invalid GeoD refresh token")?
            .to_owned();
        session.expires_at = now() + value["expires_in"].as_u64().unwrap_or(3600);
        save(&session)?;
    }
    let response = reqwest::Client::new()
        .get(format!("{ISSUER}/oauth/session"))
        .bearer_auth(&session.access_token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "GeoD account service is unavailable".to_string())?;
    Ok(response.status().is_success())
}

pub async fn require_zoom(zoom: u8) -> Result<(), String> {
    if zoom <= FREE_MAX_ZOOM || std::env::var("GEOD_SERVER_AUTHENTICATED").as_deref() == Ok("1") {
        return Ok(());
    }
    if active_session().await? {
        Ok(())
    } else {
        Err("LOGIN_REQUIRED: Downloading zoom 6 or higher requires a GeoD account. Run geod auth login and complete authorization in your browser".into())
    }
}
pub async fn require_request(request: &Request) -> Result<(), String> {
    if let Some(imagery) = &request.imagery {
        let highest = pipeline::selected_zooms(imagery)?
            .into_iter()
            .max()
            .unwrap_or(0);
        require_zoom(highest).await?;
    }
    Ok(())
}

async fn login() -> Result<Value, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Cannot open local OAuth callback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let client = reqwest::Client::new();
    let registration = client.post(format!("{ISSUER}/oauth/register"))
        .json(&json!({"client_name":"GeoD CLI","redirect_uris":[redirect],"token_endpoint_auth_method":"none"}))
        .timeout(Duration::from_secs(15)).send().await.map_err(|_| "GeoD authorization service is unavailable".to_string())?;
    if !registration.status().is_success() {
        return Err("GeoD authorization registration failed".into());
    }
    let registration: Value = registration
        .json()
        .await
        .map_err(|_| "Invalid GeoD authorization response")?;
    let client_id = registration["client_id"]
        .as_str()
        .ok_or("Missing GeoD OAuth client ID")?;
    let verifier = secret();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = secret();
    let mut url =
        reqwest::Url::parse(&format!("{ISSUER}/oauth/authorize")).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("scope", "geod:tools")
        .append_pair("resource", RESOURCE);
    eprintln!("Complete GeoD login in your browser: {url}");
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(url.as_str())
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(url.as_str())
            .spawn();
    }
    let (mut stream, _) = timeout(Duration::from_secs(600), listener.accept())
        .await
        .map_err(|_| "GeoD login timed out; run geod auth login again".to_string())?
        .map_err(|e| e.to_string())?;
    let mut request = [0u8; 8192];
    let count = timeout(Duration::from_secs(10), stream.read(&mut request))
        .await
        .map_err(|_| "GeoD login callback timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let first = std::str::from_utf8(&request[..count])
        .map_err(|_| "Invalid GeoD login callback")?
        .lines()
        .next()
        .unwrap_or("");
    let target = first
        .strip_prefix("GET ")
        .and_then(|v| v.split_once(' ').map(|(path, _)| path))
        .ok_or("Invalid GeoD login callback")?;
    let callback = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{target}"))
        .map_err(|_| "Invalid GeoD login callback")?;
    let query: std::collections::HashMap<_, _> = callback.query_pairs().into_owned().collect();
    let valid = callback.path() == "/callback" && query.get("state") == Some(&state);
    let page = if valid {
        "GeoD authorization received. You can close this tab."
    } else {
        "GeoD authorization failed. Return to the terminal and retry."
    };
    let reply = format!("HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", if valid { "200 OK" } else { "400 Bad Request" }, page.len(), page);
    let _ = stream.write_all(reply.as_bytes()).await;
    if !valid {
        return Err("GeoD login callback did not match this request".into());
    }
    let code = query.get("code").ok_or("GeoD login was not approved")?;
    let value = token(&[
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("redirect_uri", &redirect),
        ("code", code),
        ("code_verifier", &verifier),
        ("resource", RESOURCE),
    ])
    .await?;
    let session = Session {
        client_id: client_id.to_owned(),
        access_token: value["access_token"]
            .as_str()
            .ok_or("Missing GeoD access token")?
            .to_owned(),
        refresh_token: value["refresh_token"]
            .as_str()
            .ok_or("Missing GeoD refresh token")?
            .to_owned(),
        expires_at: now() + value["expires_in"].as_u64().unwrap_or(3600),
    };
    save(&session)?;
    Ok(
        json!({"ok":true,"authenticated":true,"message":"GeoD account connected. Zoom 6 and higher downloads are available."}),
    )
}

pub async fn run(args: &[String]) -> Result<Value, String> {
    match args {
        [action] if action == "login" => login().await,
        [action] if action == "status" => Ok(
            json!({"ok":true,"authenticated":active_session().await?,"anonymousMaxZoom":FREE_MAX_ZOOM}),
        ),
        [action] if action == "logout" => {
            let path = file()?;
            if path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
            Ok(json!({"ok":true,"authenticated":false}))
        }
        _ => Err("Use geod auth login|status|logout".into()),
    }
}
