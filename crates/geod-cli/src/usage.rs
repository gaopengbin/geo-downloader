//! Optional, bounded observations. No operation arguments or raw errors leave this module.
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

const ENDPOINT: &str = "https://laogao.xyz/geod-mcp/usage";
const OPERATIONS: &[&str] = &[
    "plan",
    "fetch",
    "inspect",
    "sources",
    "geostyle-import",
    "auth",
];
const MAX_PENDING: usize = 2000;

fn id() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let h: String = b.iter().map(|n| format!("{n:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}
fn load_json(path: &std::path::Path) -> Option<Value> {
    if fs::metadata(path).ok()?.len() > 8192 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
fn enabled(home: &std::path::Path) -> bool {
    match std::env::var("GEOD_TELEMETRY").as_deref() {
        Ok("0") => false,
        Ok("1") => true,
        _ => load_json(&home.join("telemetry.json"))
            .is_some_and(|c| c["schemaVersion"] == 1 && c["enabled"] == true),
    }
}
fn pending_name(name: &str) -> bool {
    name.len() == 41
        && name.ends_with(".json")
        && name[..36]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
}
pub fn configure(args: &[String]) -> Result<Value, String> {
    let [action] = args else {
        return Err("Use telemetry enable|disable|status".into());
    };
    let home = crate::sources::home()?;
    if action == "enable" || action == "disable" {
        fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        fs::write(
            home.join("telemetry.json"),
            json!({"schemaVersion":1,"enabled":action == "enable"}).to_string(),
        )
        .map_err(|e| e.to_string())?;
        if action == "disable" {
            if let Ok(entries) = fs::read_dir(home.join("usage-outbox")) {
                for e in entries.flatten() {
                    if pending_name(&e.file_name().to_string_lossy()) {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
        }
    } else if action != "status" {
        return Err("Use telemetry enable|disable|status".into());
    }
    Ok(
        json!({"ok":true,"enabled":enabled(&home),"message":"Optional statistics: tool types, random installation ID and outcomes only. No arguments, paths, coordinates, source URLs or keys. Disabling clears pending statistics."}),
    )
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Event {
    schema_version: u8,
    event_id: String,
    attempt_id: String,
    occurred_at: String,
    product: String,
    transport: String,
    kind: String,
    operation: String,
    state: String,
    reason: String,
    is_test: bool,
    installation_id: String,
    version: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Queued {
    event: Event,
    session_binding: Option<String>,
}
fn valid_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        && bytes[14] == b'4'
        && b"89abAB".contains(&bytes[19])
}
fn valid_event(e: &Event) -> bool {
    let now = chrono::Utc::now();
    let valid_time = chrono::DateTime::parse_from_rfc3339(&e.occurred_at).is_ok_and(|at| {
        at <= now + chrono::Duration::minutes(5) && at >= now - chrono::Duration::days(90)
    });
    e.schema_version == 1
        && valid_uuid(&e.event_id)
        && valid_uuid(&e.attempt_id)
        && valid_uuid(&e.installation_id)
        && valid_time
        && e.version.len() <= 32
        && e.version.starts_with(|c: char| c.is_ascii_digit())
        && e.version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".+_-".contains(&b))
        && ((e.product == "cli" && e.transport == "cli")
            || (e.product == "mcp" && e.transport == "stdio"))
        && ((e.kind == "tool"
            && ["started", "succeeded", "failed", "cancelled"].contains(&e.state.as_str()))
            || (e.kind == "download"
                && ["fetch", "geod_fetch"].contains(&e.operation.as_str())
                && [
                    "started",
                    "completed",
                    "partial",
                    "failed",
                    "cancelled",
                    "interrupted",
                ]
                .contains(&e.state.as_str())))
}
fn session_binding(home: &std::path::Path) -> Option<String> {
    let value = load_json(&home.join("account.json"))?;
    Some(format!(
        "{:x}",
        Sha256::digest(value["clientId"].as_str()?.as_bytes())
    ))
}
#[derive(Clone)]
pub struct Usage {
    home: PathBuf,
    endpoint: String,
    installation: String,
    attempt: String,
    operation: String,
    is_test: bool,
    sending: Arc<AtomicBool>,
    download_started: Arc<AtomicBool>,
    binding: Option<String>,
}
pub fn reason(message: &str) -> &'static str {
    let s = message.to_uppercase();
    if s.contains("CANCEL") || s.contains("ABORT") {
        "cancelled"
    } else if s.contains("INTERRUPTED") {
        "interrupted"
    } else if ["TIMEOUT", "TIMED OUT", "DEADLINE"]
        .iter()
        .any(|w| s.contains(w))
    {
        "timeout"
    } else if [
        "LOGIN_REQUIRED",
        "UNAUTH",
        "TOKEN_REQUIRED",
        "HTTP 401",
        "HTTP 403",
    ]
    .iter()
    .any(|w| s.contains(w))
    {
        "auth"
    } else if ["SOURCE_NOT_ALLOWED", "OFFLINE_FORBIDDEN"]
        .iter()
        .any(|w| s.contains(w))
    {
        "source_policy"
    } else if ["PERMISSION", "ACCESS DENIED"]
        .iter()
        .any(|w| s.contains(w))
    {
        "permission"
    } else if ["DISK", "STORAGE", "NO SPACE"]
        .iter()
        .any(|w| s.contains(w))
    {
        "disk"
    } else if [
        "NETWORK", "CONNECT", "DNS", "HTTP", "DOWNLOAD", "FETCH", "TLS",
    ]
    .iter()
    .any(|w| s.contains(w))
    {
        "network"
    } else if ["INVALID", "ARGUMENT", "SCHEMA"]
        .iter()
        .any(|w| s.contains(w))
    {
        "invalid_request"
    } else {
        "unknown"
    }
}
impl Usage {
    pub fn start(operation: &str) -> Option<Self> {
        if !OPERATIONS.contains(&operation)
            || std::env::var("GEOD_USAGE_PARENT").as_deref() == Ok("mcp")
        {
            return None;
        }
        let usage = Self::prepare(operation)?;
        usage.emit("tool", "started", "none");
        Some(usage)
    }
    fn prepare(operation: &str) -> Option<Self> {
        let home = crate::sources::home().ok()?;
        if !enabled(&home) {
            return None;
        }
        let endpoint = std::env::var("GEOD_USAGE_ENDPOINT").unwrap_or_else(|_| ENDPOINT.into());
        let url = reqwest::Url::parse(&endpoint).ok()?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !(endpoint == ENDPOINT
                || (url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))))
        {
            return None;
        }
        fs::create_dir_all(home.join("usage-outbox")).ok()?;
        let install_file = home.join("usage-installation.json");
        if let Ok(mut file) = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&install_file)
        {
            let _ = file.write_all(json!({"id":id()}).to_string().as_bytes());
        }
        let installation = load_json(&install_file)?["id"].as_str()?.to_string();
        if installation.len() != 36 {
            return None;
        }
        let binding = session_binding(&home);
        let usage = Self {
            home,
            endpoint,
            installation,
            attempt: id(),
            operation: operation.into(),
            binding,
            is_test: std::env::var("GEOD_USAGE_TEST").as_deref() == Ok("1"),
            sending: Arc::new(AtomicBool::new(false)),
            download_started: Arc::new(AtomicBool::new(false)),
        };
        Some(usage)
    }
    // A detached, bounded worker can finish HTTPS after a short command exits.
    // It emits no events, performs no product operation and never logs in.
    pub async fn flush_pending() {
        let Some(usage) = Self::prepare("flush") else { return };
        let lock = usage.home.join("usage-flush.lock");
        if fs::metadata(&lock).ok().and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(30)) {
            let _ = fs::remove_file(&lock);
        }
        let Ok(guard) = fs::OpenOptions::new().write(true).create_new(true).open(&lock) else { return };
        let _ = tokio::time::timeout(Duration::from_secs(12), async {
            // Different authorization bindings must never share a request.
            for _ in 0..4 {
                if !enabled(&usage.home) { break; }
                let count = usage.pending_count();
                if count == 0 { break; }
                usage.send_batch().await;
                if usage.pending_count() >= count { break; }
            }
        }).await;
        drop(guard);
        let _ = fs::remove_file(lock);
    }
    fn pending_count(&self) -> usize {
        fs::read_dir(self.home.join("usage-outbox")).map(|r|
            r.flatten().filter(|e| pending_name(&e.file_name().to_string_lossy())).take(MAX_PENDING).count()
        ).unwrap_or(0)
    }
    fn handoff_pending(&self) {
        if !enabled(&self.home) || self.pending_count() == 0 { return; }
        let Ok(exe) = std::env::current_exe() else { return };
        let mut command = std::process::Command::new(exe);
        command.arg("__usage-flush").stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let _ = command.spawn();
    }
    pub fn download_started(&self) {
        if !self.download_started.swap(true, Ordering::SeqCst) {
            self.emit("download", "started", "none");
        }
    }
    fn emit(&self, kind: &str, state: &str, reason: &str) {
        if !enabled(&self.home) {
            return;
        }
        // Small bounded local writes; network is never on the command's critical path.
        let out = self.home.join("usage-outbox");
        if fs::read_dir(&out)
            .map(|e| e.take(MAX_PENDING).count())
            .unwrap_or(MAX_PENDING)
            >= MAX_PENDING
        {
            return;
        }
        let event = Event {
            schema_version: 1,
            event_id: id(),
            attempt_id: self.attempt.clone(),
            occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            product: "cli".into(),
            transport: "cli".into(),
            kind: kind.into(),
            operation: self.operation.clone(),
            state: state.into(),
            reason: reason.into(),
            is_test: self.is_test,
            installation_id: self.installation.clone(),
            version: env!("CARGO_PKG_VERSION").into(),
        };
        let target = out.join(format!("{}.json", event.event_id));
        let temporary = out.join(format!("{}.tmp", event.event_id));
        let queued = Queued {
            event,
            session_binding: self.binding.clone(),
        };
        if let (Ok(data), Ok(mut file)) = (
            serde_json::to_vec(&queued),
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary),
        ) {
            let written = file.write_all(&data).is_ok();
            drop(file);
            if written && fs::rename(temporary, target).is_ok() {
                let copy = self.clone();
                tokio::spawn(async move {
                    copy.send().await;
                });
            }
        }
    }
    async fn send(&self) {
        if self
            .sending
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        self.send_batch().await;
        self.sending.store(false, Ordering::SeqCst);
    }
    async fn send_batch(&self) {
        if !enabled(&self.home) {
            return;
        }
        let out = self.home.join("usage-outbox");
        let Ok(entries) = fs::read_dir(&out) else {
            return;
        };
        let mut events = Vec::new();
        let mut paths = Vec::new();
        let mut binding: Option<Option<String>> = None;
        for item in entries
            .flatten()
            .filter(|e| pending_name(&e.file_name().to_string_lossy()))
            .take(50)
        {
            let Some(value) = load_json(&item.path()) else {
                let _ = fs::remove_file(item.path());
                continue;
            };
            let Ok(queued) = serde_json::from_value::<Queued>(value) else {
                let _ = fs::remove_file(item.path());
                continue;
            };
            if let Some(ref first) = binding {
                if first != &queued.session_binding {
                    continue;
                }
            } else {
                binding = Some(queued.session_binding.clone());
            }
            let event = queued.event;
            // Do not forward unknown fields or values even if a local outbox is edited.
            if !valid_event(&event) {
                let _ = fs::remove_file(item.path());
                continue;
            }
            let valid_operation = OPERATIONS.contains(&event.operation.as_str())
                || [
                    "geod_capabilities",
                    "geod_sources",
                    "geod_plan",
                    "geod_fetch",
                    "geod_job_status",
                    "geod_cancel_job",
                    "geod_inspect",
                    "geod_get_artifact",
                    "geod_artifact_link",
                ]
                .contains(&event.operation.as_str());
            if !valid_operation
                || !["tool", "download"].contains(&event.kind.as_str())
                || !["cli", "stdio"].contains(&event.transport.as_str())
                || ![
                    "started",
                    "succeeded",
                    "completed",
                    "partial",
                    "failed",
                    "cancelled",
                    "interrupted",
                ]
                .contains(&event.state.as_str())
                || ![
                    "none",
                    "cancelled",
                    "network",
                    "timeout",
                    "auth",
                    "permission",
                    "disk",
                    "invalid_request",
                    "source_policy",
                    "incomplete",
                    "interrupted",
                    "unknown",
                ]
                .contains(&event.reason.as_str())
            {
                let _ = fs::remove_file(item.path());
                continue;
            }
            events.push(event);
            paths.push(item.path());
        }
        if events.is_empty() {
            return;
        }
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
        else {
            return;
        };
        let mut request = client.post(&self.endpoint).json(&json!({"events":events}));
        if let Some(session) = load_json(&self.home.join("account.json")).filter(|_| {
            binding
                .flatten()
                .is_some_and(|b| Some(b) == session_binding(&self.home))
        }) {
            if session["expiresAt"].as_u64().unwrap_or(0) > chrono::Utc::now().timestamp() as u64 {
                if let Some(token) = session["accessToken"].as_str() {
                    request = request.bearer_auth(token);
                }
            }
        }
        if request
            .send()
            .await
            .is_ok_and(|r| r.status().as_u16() == 202)
        {
            for p in paths {
                let _ = fs::remove_file(p);
            }
        }
    }
    pub async fn finish(&self, result: &Result<Value, String>) {
        let (state, why) = match result {
            Ok(v) if v["ok"] != false => ("succeeded", "none"),
            Ok(_) => ("failed", "unknown"),
            Err(e) => (
                if reason(e) == "cancelled" {
                    "cancelled"
                } else {
                    "failed"
                },
                reason(e),
            ),
        };
        self.emit("tool", state, why);
        if self.operation == "fetch" && self.download_started.load(Ordering::SeqCst) {
            let status = if state == "succeeded" {
                match result
                    .as_ref()
                    .ok()
                    .and_then(|v| v["manifest"]["quality"]["status"].as_str())
                {
                    Some("complete") => Some("completed"),
                    Some("partial") => Some("partial"),
                    _ => None,
                }
            } else {
                Some(state)
            };
            if let Some(status) = status {
                self.emit(
                    "download",
                    status,
                    if status == "partial" {
                        "incomplete"
                    } else {
                        why
                    },
                );
            }
        }
        let _ = tokio::time::timeout(Duration::from_millis(200), async {
            while self.sending.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            self.send().await;
        })
        .await;
        self.handoff_pending();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reason_never_returns_raw_text() {
        assert_eq!(
            reason("HTTP 502 https://private.example/?token=secret"),
            "network"
        );
        assert_eq!(reason("LOGIN_REQUIRED: user@example.com"), "auth");
        assert_eq!(reason("CANCELLED: operation interrupted"), "cancelled");
        assert_eq!(reason("unexpected private file"), "unknown");
    }
}
