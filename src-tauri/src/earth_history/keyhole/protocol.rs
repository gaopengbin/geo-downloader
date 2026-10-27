use super::{
    super::{catalog::pack_date, transport::sha, Result},
    io, wire,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
};
pub const ROOT_URL: &str = "https://khmdb.google.com/dbRoot.v5?db=tm&hl=en&gl=us&output=proto";
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Root {
    pub id: String,
    pub epoch: u32,
    pub key: Vec<u8>,
    pub providers: BTreeMap<u32, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateRecord {
    pub date: String,
    pub packed: u32,
    pub epoch: u32,
    pub provider: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    pub epoch: u32,
    pub dates: Vec<DateRecord>,
}
type Packet = BTreeMap<u32, Node>;
pub struct Engine {
    pub client: reqwest::Client,
    pub root: Root,
}
impl Root {
    pub fn load(id: &str) -> Result<Self> {
        super::super::validate_id(id)?;
        let root: Self = serde_json::from_slice(
            &std::fs::read(io::directory()?.join(format!("root-{id}.json")))
                .map_err(|_| "EARTH_CACHE: Keyhole root unavailable")?,
        )
        .map_err(|_| "EARTH_CACHE: Keyhole root invalid")?;
        if root.id != id {
            return Err("EARTH_CACHE: Keyhole root identity".into());
        }
        Ok(root)
    }
}
impl Engine {
    pub async fn open(client: reqwest::Client) -> Result<Self> {
        let (raw, e) = io::fetch(&client, ROOT_URL, true).await?;
        let encrypted = wire::parse(&raw)?;
        let key = wire::bytes(&encrypted, 2)
            .ok_or("EARTH_PROTOCOL: legacy root encoding")?
            .to_vec();
        let data = io::unpack(&io::decrypt(
            wire::bytes(&encrypted, 3).ok_or("EARTH_PROTOCOL: legacy root data")?,
            &key,
        )?)?;
        let fields = wire::parse(&data)?;
        let version = wire::parse(
            wire::bytes(&fields, 13).ok_or("EARTH_PROTOCOL: legacy database version")?,
        )?;
        let epoch = wire::int(&version, 1)
            .filter(|n| *n > 0)
            .ok_or("EARTH_PROTOCOL: legacy root epoch")?;
        let mut strings = BTreeMap::new();
        for body in wire::repeated(&fields, 8) {
            let f = wire::parse(body)?;
            if let (Some(id), Some(text)) = (wire::int(&f, 1), wire::bytes(&f, 2)) {
                if let Ok(s) = std::str::from_utf8(text) {
                    strings.insert(id, s.to_owned());
                }
            }
        }
        let mut providers = BTreeMap::new();
        for body in wire::repeated(&fields, 3) {
            let f = wire::parse(body)?;
            if let (Some(id), Some(body)) = (wire::int(&f, 1), wire::bytes(&f, 2)) {
                let f = wire::parse(body)?;
                let text = wire::bytes(&f, 2)
                    .and_then(|b| std::str::from_utf8(b).ok())
                    .map(str::to_owned)
                    .or_else(|| wire::int(&f, 1).and_then(|id| strings.get(&id).cloned()));
                if let Some(text) = text {
                    providers.insert(id, text);
                }
            }
        }
        let root = Root {
            id: e.wire_sha256,
            epoch,
            key,
            providers,
        };
        io::write(
            &io::directory()?.join(format!("root-{}.json", root.id)),
            &serde_json::to_vec(&root).unwrap(),
        )?;
        Ok(Self { client, root })
    }
    async fn packet(&self, path: &str, epoch: u32) -> Result<Arc<Packet>> {
        static CACHE: OnceLock<Mutex<io::Memory<Packet>>> = OnceLock::new();
        let cache = CACHE.get_or_init(|| Mutex::new(io::Memory::new(16 * 1024 * 1024)));
        let url = format!("https://khmdb.google.com/flatfile?db=tm&qp-{path}-q.{epoch}");
        let id = sha(format!("{}:{url}", self.root.id).as_bytes());
        if let Some(value) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(&id) {
            return Ok(value);
        }
        let gate = io::gate(&format!("parsed:{id}"));
        let _guard = gate.lock().await;
        if let Some(value) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(&id) {
            return Ok(value);
        }
        let (raw, _) = io::fetch(&self.client, &url, false).await?;
        let data = io::unpack(&io::decrypt(&raw, &self.root.key)?)?;
        let fields = wire::parse(&data)?;
        let mut result = BTreeMap::new();
        let mut bytes = 0;
        for group in &fields {
            if group.number != 2 {
                continue;
            }
            let wire::Value::Group(f) = &group.value else {
                return Err("EARTH_PROTOCOL: expected proto2 group".into());
            };
            let index = wire::int(f, 3).ok_or("EARTH_PROTOCOL: legacy node index")?;
            if index > 400 {
                return Err("EARTH_PROTOCOL: legacy packet index".into());
            }
            let f = wire::parse(wire::bytes(f, 4).ok_or("EARTH_PROTOCOL: legacy node")?)?;
            let mut dates = BTreeMap::new();
            for layer in wire::repeated(&f, 3) {
                let l = wire::parse(layer)?;
                if wire::int(&l, 1) != Some(3) {
                    continue;
                }
                if let Some(body) = wire::bytes(&l, 4) {
                    let d = wire::parse(body)?;
                    for body in wire::repeated(&d, 1) {
                        let r = wire::parse(body)?;
                        if wire::bytes(&r, 4).is_some() {
                            continue;
                        }
                        if let (Some(packed), Some(epoch), Some(provider)) =
                            (wire::int(&r, 1), wire::int(&r, 2), wire::int(&r, 3))
                        {
                            let day = chrono::NaiveDate::from_ymd_opt(
                                (packed >> 9) as i32,
                                (packed >> 5) & 15,
                                packed & 31,
                            );
                            if let Some(day) =
                                day.filter(|_| packed >> 9 > 1 && epoch > 0 && provider > 0)
                            {
                                let date = day.format("%Y-%m-%d").to_string();
                                if pack_date(&date).is_ok() {
                                    dates.insert(
                                        packed,
                                        DateRecord {
                                            date,
                                            packed,
                                            epoch,
                                            provider,
                                        },
                                    );
                                }
                            }
                        }
                        if dates.len() > 10_000 {
                            return Err("EARTH_BUDGET: legacy node date count".into());
                        }
                    }
                }
            }
            let node = Node {
                epoch: wire::int(&f, 2).unwrap_or(0),
                dates: dates.into_values().collect(),
            };
            bytes += 64 + node.dates.len() * 64;
            result.insert(index, node);
        }
        let value = Arc::new(result);
        cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .put(id, value.clone(), bytes);
        Ok(value)
    }
    pub async fn node(&self, path: &str) -> Result<Option<Node>> {
        if !super::valid_path(path) {
            return Err("EARTH_PROTOCOL: legacy node path".into());
        }
        let mut packet = self.packet("0", self.root.epoch).await?;
        for end in (4..path.len()).step_by(4) {
            let prefix = &path[..end];
            let Some(branch) = packet.get(&super::subindex(prefix)) else {
                return Ok(None);
            };
            if branch.epoch == 0 {
                return Ok(None);
            }
            packet = match self.packet(prefix, branch.epoch).await {
                Ok(p) => p,
                Err(e) if e.starts_with("EARTH_NO_DATA:") => return Ok(None),
                Err(e) => return Err(e),
            };
        }
        Ok(packet.get(&super::subindex(path)).cloned())
    }
    pub async fn image(&self, selection: &super::Selection) -> Result<Arc<image::RgbImage>> {
        static CACHE: OnceLock<Mutex<io::Memory<image::RgbImage>>> = OnceLock::new();
        let cache = CACHE.get_or_init(|| Mutex::new(io::Memory::new(64 * 1024 * 1024)));
        let url = selection.url();
        let id = sha(format!("{}:{url}", self.root.id).as_bytes());
        if let Some(image) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(&id) {
            return Ok(image);
        }
        let gate = io::gate(&format!("decoded:{id}"));
        let _guard = gate.lock().await;
        if let Some(image) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(&id) {
            return Ok(image);
        }
        let (raw, _) = io::fetch(&self.client, &url, false).await?;
        let bytes = io::decrypt(&raw, &self.root.key)?;
        let image = tokio::task::spawn_blocking(move || {
            let reader = image::ImageReader::with_format(
                std::io::Cursor::new(&bytes),
                image::ImageFormat::Jpeg,
            );
            let (w, h) = reader
                .into_dimensions()
                .map_err(|_| "EARTH_PROTOCOL: legacy JPEG header")?;
            if w != 256 || h != 256 {
                return Err("EARTH_UNSUPPORTED: legacy JPEG dimensions".to_string());
            }
            image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
                .map(|im| im.to_rgb8())
                .map_err(|_| "EARTH_PROTOCOL: legacy JPEG".into())
        })
        .await
        .map_err(|_| "EARTH_PROTOCOL: image worker stopped")??;
        let image = Arc::new(image);
        cache.lock().unwrap_or_else(|p| p.into_inner()).put(
            id,
            image.clone(),
            image.as_raw().len(),
        );
        Ok(image)
    }
}
