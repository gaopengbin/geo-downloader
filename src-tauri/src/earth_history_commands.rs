//! Desktop transport boundary for the shared Earth historical imagery adapter.
use crate::{
    earth_history::{catalog, planner, transport},
    tile::Bounds,
};
use base64::Engine;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use tokio_util::sync::CancellationToken;
fn work() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static WORK: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    WORK.get_or_init(Default::default)
}
struct WorkGuard(String);
fn early_cancels()->&'static Mutex<HashMap<String,std::time::Instant>>{static CANCELS:OnceLock<Mutex<HashMap<String,std::time::Instant>>>=OnceLock::new();CANCELS.get_or_init(Default::default)}
impl Drop for WorkGuard {
    fn drop(&mut self) {
        work()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.0);
    }
}
async fn cancellable<T, F>(id: String, future: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    if id.len() > 80 || id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("EARTH_REQUEST: invalid operation identity".into());
    }
    let token = CancellationToken::new();
    if early_cancels().lock().unwrap_or_else(|p|p.into_inner()).remove(&id).is_some_and(|at|at.elapsed().as_secs()<60){return Err("EARTH_CANCELLED".into());}
    {
        let mut jobs = work().lock().unwrap_or_else(|p| p.into_inner());
        if jobs.len() >= 256 || jobs.contains_key(&id) {
            return Err("EARTH_BUSY: cancel an existing operation first".into());
        }
        jobs.insert(id.clone(), token.clone());
    }
    let _guard = WorkGuard(id);
    tokio::select! {_ = token.cancelled()=>Err("EARTH_CANCELLED".into()),result=future=>result}
}

fn keyhole_client() -> Result<reqwest::Client,String> {
    static CLIENT:OnceLock<Mutex<Option<(Option<String>,reqwest::Client)>>> = OnceLock::new();
    let settings=crate::settings::SettingsManager::new()?.get()?;
    let proxy=settings.proxy_enabled.then_some(settings.proxy_url).filter(|s|!s.trim().is_empty());
    let mut cached=CLIENT.get_or_init(Default::default).lock().unwrap_or_else(|p|p.into_inner());
    if let Some((previous,client))=cached.as_ref(){if *previous==proxy{return Ok(client.clone());}}
    let client=transport::Transport::new(proxy.as_deref(),128,128*1024*1024)?.client();
    *cached=Some((proxy,client.clone()));Ok(client)
}
#[tauri::command]
pub async fn keyhole_history_dates(longitude:f64,latitude:f64,zoom:u8,request_id:String)->Result<serde_json::Value,String>{
    let client=keyhole_client()?;
    cancellable(request_id,crate::earth_history::keyhole::dates(longitude,latitude,zoom,client)).await
}
#[tauri::command]
pub fn keyhole_history_session(root_id:String,date:String)->Result<serde_json::Value,String>{
    let context=crate::earth_history::keyhole::session(&root_id,&date)?;
    Ok(serde_json::json!({"id":context.id,"requestedDate":context.requested_date,"source":context.source()}))
}
#[tauri::command]
pub async fn keyhole_history_plan(source_key:String,bounds:Bounds,zoom:u8,request_id:String)->Result<serde_json::Value,String>{
    let client=keyhole_client()?;
    cancellable(request_id,async move{
        let context=crate::earth_history::keyhole::plan(&source_key,[bounds.west,bounds.south,bounds.east,bounds.north],zoom,client).await?;
        Ok(serde_json::json!({"id":context.id,"requestedDate":context.requested_date,"source":context.source(),"tileCount":context.tiles.as_ref().map(|t|t.len()).unwrap_or(0)}))
    }).await
}
#[tauri::command]
pub fn keyhole_history_status(source_key:String)->crate::earth_history::keyhole::Status{crate::earth_history::keyhole::status(&source_key)}
pub async fn keyhole_protocol(uri:&str)->Result<Vec<u8>,String>{
    let url=reqwest::Url::parse(uri).map_err(|_|"EARTH_REQUEST: invalid local tile URL")?;
    let (source,z,x,y)=crate::tile_cache::parse_gdcache_uri(uri).ok_or("EARTH_REQUEST: invalid local tile coordinates")?;
    let id=url.query_pairs().find_map(|(k,v)|(k=="request").then_some(v.into_owned())).ok_or("EARTH_REQUEST: missing tile operation")?;
    let client=keyhole_client()?;
    let result=cancellable(id,crate::earth_history::keyhole::read_tile(&source,z,x,y,client)).await;
    if result.as_ref().is_err_and(|e|!e.contains("CANCELLED")){crate::earth_history::keyhole::note_error(&source);}
    result
}
pub async fn keyhole_response(uri:&str)->tauri::http::Response<Vec<u8>> {
    let(status,mime,bytes)=match keyhole_protocol(uri).await{Ok(bytes)=>(200,"image/png",bytes),Err(error)=>(if error.contains("CANCELLED"){499}else{502},"text/plain",error.into_bytes())};
    tauri::http::Response::builder().status(status).header("Content-Type",mime).header("Access-Control-Allow-Origin","*").header("Cache-Control","no-store").body(bytes).expect("Keyhole tile response")
}
#[tauri::command]
pub fn earth_history_cancel(request_id: String) -> bool {
    let cancelled=work()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&request_id)
        .is_some_and(|token| {
            token.cancel();
            true
        });
    if !cancelled && request_id.len()<=80 {let mut early=early_cancels().lock().unwrap_or_else(|p|p.into_inner());early.retain(|_,at|at.elapsed().as_secs()<60);if early.len()<512{early.insert(request_id,std::time::Instant::now());}}
    cancelled
}

#[tauri::command]
pub async fn earth_history_catalog(
    bounds: Bounds,
    zoom: u8,
    proxy: Option<String>,
    request_id: String,
) -> Result<serde_json::Value, String> {
    cancellable(request_id,async move{
    let result=catalog::discover([bounds.west,bounds.south,bounds.east,bounds.north],zoom,proxy.as_deref()).await?;
    Ok(serde_json::json!({"id":result.id,"bounds":result.bounds,"outputZoom":result.output_zoom,"dates":result.dates,
        "catalogComplete":result.catalog_complete,"scope":result.scope,"nodeCount":result.nodes.len(),"metadataRequests":result.metadata_requests}))
    }).await
}
#[tauri::command]
pub async fn earth_history_prepare(
    catalog_id: String,
    date: String,
    proxy: Option<String>,
    request_id: String,
) -> Result<serde_json::Value, String> {
    cancellable(request_id,async move{
    let plan=planner::prepare(&catalog_id,&date)?;
    let client=transport::Transport::new(proxy.as_deref(),128,128*1024*1024)?.client();
    let nodes=planner::nodes(&plan,client).await?;
    if nodes.is_empty(){return Err("EARTH_NO_DATA: no historical imagery could be decoded for this region and date".into());}
    planner::activate(&plan);
    Ok(serde_json::json!({"id":plan.id,"catalogId":plan.catalog_id,"source":plan.source(),"bounds":plan.bounds,"requestedDate":plan.requested_date,
        "outputZoom":plan.output_zoom,"tileCount":plan.tile_count,"fallbackOccurred":plan.fallback_occurred,
        "effectiveDateStatus":plan.effective_date_status,"unavailableNodes":plan.unavailable_nodes}))
    }).await
}
#[tauri::command]
pub async fn earth_history_preview_tile(
    source_key: String,
    z: u8,
    x: u32,
    y: u32,
) -> Result<String, String> {
    let source = planner::source(&source_key)?;
    let url = source
        .url
        .replace("{z}", &z.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y.to_string());
    let settings = crate::settings::SettingsManager::new()?.get()?;
    let proxy = if settings.proxy_enabled {
        Some(settings.proxy_url.as_str())
    } else {
        None
    };
    let client = transport::Transport::new(proxy, 128, 128 * 1024 * 1024)?.client();
    let bytes = match planner::read_tile(&url, client).await {
        Ok(bytes) => bytes,
        Err(error) if error.starts_with("EARTH_NO_DATA:") => {
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::RgbaImage::new(256, 256)
                .write_to(&mut bytes, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            bytes.into_inner()
        }
        Err(error) => return Err(error),
    };
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelling_an_operation_stops_its_future_and_releases_its_identity() {
        let id = format!(
            "earth-cancel-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        );
        let running_id = id.clone();
        let operation =
            tokio::spawn(
                async move { cancellable::<(), _>(running_id, std::future::pending()).await },
            );
        tokio::task::yield_now().await;
        assert!(earth_history_cancel(id.clone()));
        assert_eq!(operation.await.unwrap().unwrap_err(), "EARTH_CANCELLED");
        assert!(!earth_history_cancel(id));
    }
    #[tokio::test]
    async fn tile_cancel_before_protocol_registration_prevents_network_work(){
        let id=format!("early-{}",uuid::Uuid::new_v4());assert!(!earth_history_cancel(id.clone()));
        let result=cancellable(id,async{panic!("cancelled tile must not start");#[allow(unreachable_code)]Ok::<(),String>(())}).await;
        assert_eq!(result.unwrap_err(),"EARTH_CANCELLED");
    }
}
