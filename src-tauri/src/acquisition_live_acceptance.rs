//! Explicit bounded network acceptance, with an isolated cache and QA output.
use crate::{config::TileSource,downloader::TileDownloader,tianditu_tokens::TiandituTokens,tile::TileCoord};
use std::{sync::Arc,io::{Read,Write}};
#[tokio::test]
#[ignore="Requires real Amap; publishes nothing and changes no ordinary user settings"]
async fn live_amap_layers_keep_native_diagnostics(){
 let root=std::path::PathBuf::from(std::env::var("GEOD_LEGACY_QA_OUTPUT").unwrap());std::fs::create_dir_all(&root).unwrap();
 crate::tile_cache::set_config(crate::tile_cache::CacheConfig{enabled:false,root_dir:root.join("isolated-cache"),max_total_bytes:1024*1024});
 let make=|id:&str,style:u8|TileSource{id:id.into(),name:id.into(),url:format!("https://webst01.is.autonavi.com/appmaptile?style={style}&size=1&scale=1&x={{x}}&y={{y}}&z={{z}}"),subdomains:vec![],max_zoom:22,attribution:"Amap".into(),headers:Default::default()};
 let mut observations=vec![];let tile=TileCoord{x:13489,y:6208,z:14};
 for refused in [false,true]{
  let label=if refused{"controlled-overlay-403"}else{"real-amap-delivery"};let dir=root.join(label);std::fs::create_dir_all(&dir).unwrap();
  let base=make(&format!("qa-base-{label}"),6);let mut overlay=make(&format!("qa-overlay-{label}"),8);
  let fixture=if refused{let socket=std::net::TcpListener::bind("127.0.0.1:0").unwrap();overlay.url=format!("http://{}/{{z}}/{{x}}/{{y}}",socket.local_addr().unwrap());Some(std::thread::spawn(move||{let(mut s,_)=socket.accept().unwrap();let mut bytes=[0;4096];let _=s.read(&mut bytes);s.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();}))}else{None};
  let pool=Arc::new(TiandituTokens::new(vec![],Arc::new(|_|{})));pool.configure_diagnostic_sources(&[base.clone(),overlay.clone()]);pool.set_storage_diagnostics(crate::acquisition_storage::snapshot(&dir.join("delivered.png"),&dir,1,1));
  let mut error=None;
  for(index,source)in [base,overlay].into_iter().enumerate(){
   pool.set_stage(if index==0{"base_download"}else{"overlay_download"},false);pool.select_diagnostic_source(index);
   let path=dir.join(if index==0{"base"}else{"overlay"});std::fs::create_dir_all(&path).unwrap();
   let result=TileDownloader::new(source,None).unwrap().with_tianditu_tokens(pool.clone()).download_tiles(vec![tile.clone()],1,&path,None,None,|_|{}).await;
   match result{Ok(files)=>{assert_eq!(files.len(),1);let merged=crate::merger::merge_tiles(&files,tile.x,tile.y,tile.x,tile.y);merged.save(dir.join(if index==0{"base.png"}else{"overlay.png"})).unwrap();},Err(message)=>{pool.record_failure(&message);error=Some(message);break;}}
  }
  if let Some(fixture)=fixture{fixture.join().unwrap();}
  if refused{assert!(error.is_some());}else{assert!(error.is_none());pool.record_completed();}
  let diagnostic=pool.diagnostics();assert_eq!(diagnostic.configured_tokens,0);let rich=serde_json::to_value(&diagnostic.acquisition).unwrap();assert_eq!(rich["sources"][0]["http_status"],200);assert!(rich["storage"].as_array().unwrap().iter().all(|v|v["available_bytes"].is_u64()));
  if refused{assert_eq!(rich["error_http_status"],403);assert_eq!(rich["failed_source"],1);assert_eq!(rich["phase"],"overlay_download");}else{assert_eq!(rich["sources"][1]["http_status"],200);}
  observations.push(serde_json::json!({"id":label,"created_at":chrono::Utc::now().to_rfc3339(),"status":if refused{"failed"}else{"completed"},"error":error,"download_diagnostics":diagnostic}));
 }
 std::fs::write(root.join("native-results.json"),serde_json::to_vec_pretty(&observations).unwrap()).unwrap();
}
