use super::super::{transport::sha, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock, Weak},
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub url: String,
    pub wire_sha256: String,
    pub bytes: usize,
    pub checked_at: i64,
}
pub fn directory() -> Result<PathBuf> {
    let dir = super::super::transport::directory()?.join("keyhole-v1");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
pub fn write(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.map_err(|e: std::io::Error| e.to_string())
}
pub fn allowed(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        if u.scheme() != "https"
            || u.host_str() != Some("khmdb.google.com")
            || u.port_or_known_default() != Some(443)
            || !u.username().is_empty()
            || u.password().is_some()
            || u.fragment().is_some()
        {
            return false;
        }
        if u.path() == "/dbRoot.v5" {
            return u.query() == Some("db=tm&hl=en&gl=us&output=proto");
        }
        if u.path() != "/flatfile" {
            return false;
        }
        let Some(tail) = u.query().and_then(|q| q.strip_prefix("db=tm&")) else {
            return false;
        };
        let parts: Vec<_> = tail.split('-').collect();
        if parts.len() != 3 && parts.len() != 4 {
            return false;
        }
        if !super::valid_path(parts[1]) {
            return false;
        }
        let positive = |s: &str| s.parse::<u32>().is_ok_and(|n| n > 0);
        if parts[0] == "qp" && parts.len() == 3 {
            return parts[2].strip_prefix("q.").is_some_and(positive);
        }
        parts[0] == "f1"
            && parts.len() == 4
            && parts[2].strip_prefix("i.").is_some_and(positive)
            && !parts[3].is_empty()
            && parts[3].len() <= 8
            && parts[3].bytes().all(|b| b.is_ascii_hexdigit())
    })
}
type Gate = tokio::sync::Mutex<()>;
pub fn gate(key: &str) -> Arc<Gate> {
    static GATES: OnceLock<Mutex<HashMap<String, Weak<Gate>>>> = OnceLock::new();
    let mut map = GATES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if let Some(value) = map.get(key).and_then(Weak::upgrade) {
        return value;
    }
    map.retain(|_, v| v.strong_count() > 0);
    let value = Arc::new(Gate::new(()));
    map.insert(key.into(), Arc::downgrade(&value));
    value
}
pub fn network() -> &'static tokio::sync::Semaphore {
    static S: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    S.get_or_init(|| tokio::sync::Semaphore::new(6))
}
pub async fn fetch(
    client: &reqwest::Client,
    url: &str,
    fresh: bool,
) -> Result<(Vec<u8>, Evidence)> {
    if !allowed(url) {
        return Err("EARTH_NETWORK: invalid Keyhole destination".into());
    }
    let guard = gate(url);
    let _guard = guard.lock().await;
    static MISSING: OnceLock<Mutex<HashMap<String, std::time::Instant>>> = OnceLock::new();
    let missing = MISSING.get_or_init(Default::default);
    if missing
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(url)
        .is_some_and(|t| t.elapsed().as_secs() < 30)
    {
        return Err("EARTH_NO_DATA: Keyhole packet unavailable".into());
    }
    let dir = directory()?;
    let reference = dir.join(format!("{}.ref", sha(url.as_bytes())));
    if let Ok(data) = std::fs::read(&reference) {
        if let Ok(e) = serde_json::from_slice::<Evidence>(&data) {
            if e.url == url
                && e.bytes <= 4 * 1024 * 1024
                && super::super::validate_id(&e.wire_sha256).is_ok()
                && (!fresh || chrono::Utc::now().timestamp() - e.checked_at < 300)
            {
                if let Ok(raw) = std::fs::read(dir.join(format!("{}.packet", e.wire_sha256))) {
                    if raw.len() == e.bytes && sha(&raw) == e.wire_sha256 {
                        return Ok((raw, e));
                    }
                }
            }
        }
    }
    let _permit = network()
        .acquire()
        .await
        .map_err(|_| "EARTH_NETWORK: queue closed")?;
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|e| format!("EARTH_NETWORK: {}", e.without_url()))?;
    if response.status().as_u16() == 404 {
        let mut map = missing.lock().unwrap_or_else(|p| p.into_inner());
        map.retain(|_, t| t.elapsed().as_secs() < 30);
        if map.len() < 4096 {
            map.insert(url.into(), std::time::Instant::now());
        }
        return Err("EARTH_NO_DATA: Keyhole packet unavailable".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "EARTH_NETWORK: Keyhole HTTP {}",
            response.status().as_u16()
        ));
    }
    let mut raw = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| e.without_url().to_string())?
    {
        if raw.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("EARTH_BUDGET: Keyhole packet size".into());
        }
        raw.extend_from_slice(&chunk);
    }
    let e = Evidence {
        url: url.into(),
        wire_sha256: sha(&raw),
        bytes: raw.len(),
        checked_at: chrono::Utc::now().timestamp(),
    };
    write(&dir.join(format!("{}.packet", e.wire_sha256)), &raw)?;
    write(&reference, &serde_json::to_vec(&e).unwrap())?;
    prune_packets_later(dir);
    Ok((raw, e))
}
fn prune_packets_later(dir: PathBuf) {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    static WRITES: AtomicUsize = AtomicUsize::new(0);
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if WRITES.fetch_add(1, Ordering::Relaxed) % 32 != 0 || RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        let mut files = Vec::new();
        let mut total = 0u64;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !entry.file_type().is_ok_and(|t| t.is_file())
                    || path.extension().and_then(|s| s.to_str()) != Some("packet")
                    || !path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| super::super::validate_id(s).is_ok())
                {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    total += meta.len();
                    files.push((meta.modified().ok(), meta.len(), path));
                }
            }
        }
        files.sort_by_key(|(modified, _, _)| *modified);
        for (_, size, path) in files {
            if total <= 512 * 1024 * 1024 {
                break;
            }
            if std::fs::remove_file(path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
        RUNNING.store(false, Ordering::Release);
    });
}
pub fn decrypt(raw: &[u8], key: &[u8]) -> Result<Vec<u8>> {
    if key.len() < 24 || key.len() % 8 != 0 || key.len() > 64 * 1024 {
        return Err("EARTH_PROTOCOL: legacy encoding key length".into());
    }
    let mut output = raw.to_vec();
    let mut offset = 16;
    for byte in &mut output {
        *byte ^= key[offset];
        offset += 1;
        if offset & 7 == 0 {
            offset += 16;
        }
        if offset >= key.len() {
            offset = (offset + 8) % 24;
        }
    }
    Ok(output)
}
pub fn unpack(raw: &[u8]) -> Result<Vec<u8>> {
    if raw.len() < 8 {
        return Err("EARTH_PROTOCOL: legacy compression header".into());
    }
    let magic = u32::from_le_bytes(raw[..4].try_into().unwrap());
    let size = match magic {
        0x7468dead => u32::from_le_bytes(raw[4..8].try_into().unwrap()),
        0xadde6874 => u32::from_be_bytes(raw[4..8].try_into().unwrap()),
        _ => return Err("EARTH_PROTOCOL: legacy compression magic".into()),
    } as usize;
    if size > 32 * 1024 * 1024 {
        return Err("EARTH_BUDGET: legacy expanded size".into());
    }
    let mut reader = flate2::read::ZlibDecoder::new(&raw[8..]);
    let mut bytes = Vec::new();
    (&mut reader)
        .take(size as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "EARTH_PROTOCOL: legacy zlib")?;
    if bytes.len() != size || reader.total_in() != raw.len() as u64 - 8 {
        return Err("EARTH_PROTOCOL: legacy expanded length".into());
    }
    Ok(bytes)
}
pub struct Memory<T> {
    entries: VecDeque<(String, Arc<T>, usize)>,
    bytes: usize,
    limit: usize,
}
impl<T> Memory<T> {
    pub fn new(limit: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            bytes: 0,
            limit,
        }
    }
    pub fn get(&mut self, id: &str) -> Option<Arc<T>> {
        let i = self.entries.iter().position(|(key, _, _)| key == id)?;
        let e = self.entries.remove(i)?;
        let value = e.1.clone();
        self.entries.push_back(e);
        Some(value)
    }
    pub fn put(&mut self, id: String, value: Arc<T>, bytes: usize) {
        if bytes > self.limit {
            return;
        }
        while self.bytes + bytes > self.limit {
            if let Some((_, _, n)) = self.entries.pop_front() {
                self.bytes -= n;
            } else {
                break;
            }
        }
        self.bytes += bytes;
        self.entries.push_back((id, value, bytes));
    }
}
