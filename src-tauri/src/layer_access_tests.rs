use crate::{config::TileSource,downloader::{TileDownloader,preflight_layer_access},tianditu_tokens::TiandituTokens,tile::TileCoord};
use std::{sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},io::{Cursor,Read,Write},time::Duration};
fn source(id:&str,url:String)->TileSource{TileSource{id:id.into(),name:id.into(),url,subdomains:vec![],max_zoom:22,attribution:"QA".into(),headers:Default::default()}}
#[test]fn defaults_never_send_an_unrelated_google_referer_and_custom_headers_stay_authoritative(){
 for url in["https://webst01.is.autonavi.com/appmaptile?x={x}","https://example.org/arcgis/{z}/{x}/{y}","https://google.com.example.org/{z}/{x}/{y}"]{
  let d=TileDownloader::new_preview(source("qa",url.into()),None).unwrap();assert!(d.get_headers_public().get("referer").is_none());
 }
 let d=TileDownloader::new_preview(source("google","https://mt0.google.com/vt?x={x}".into()),None).unwrap();assert_eq!(d.get_headers_public()["referer"],"https://www.google.com/maps");
 let mut s=source("private","https://example.org/{z}/{x}/{y}".into());s.headers.0.insert("Referer".into(),"https://authorized.example.org/".into());
 assert_eq!(TileDownloader::new_preview(s,None).unwrap().get_headers_public()["referer"],"https://authorized.example.org/");
}
#[tokio::test]
async fn annotation_rejection_stops_before_bulk_and_recovery_reuses_samples(){
 let _lock=crate::tile_cache::CACHE_TEST_LOCK.lock().unwrap();
 struct Restore(crate::tile_cache::CacheConfig);impl Drop for Restore{fn drop(&mut self){crate::tile_cache::set_config(self.0.clone());}}
 let _restore=Restore(crate::tile_cache::get_config());let dir=tempfile::tempdir().unwrap();crate::tile_cache::set_config(crate::tile_cache::CacheConfig{enabled:false,root_dir:dir.path().join("cache"),max_total_bytes:1024*1024});
 let socket=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=socket.local_addr().unwrap();socket.set_nonblocking(true).unwrap();
 let mut png=Cursor::new(Vec::new());image::DynamicImage::new_rgb8(256,256).write_to(&mut png,image::ImageFormat::Png).unwrap();let bytes=png.into_inner();
 let denied=Arc::new(AtomicBool::new(true));let stop=Arc::new(AtomicBool::new(false));let calls=Arc::new(Mutex::new(Vec::new()));
 let(sd,ss,sc)=(denied.clone(),stop.clone(),calls.clone());let server=std::thread::spawn(move||{while !ss.load(Ordering::Relaxed){
  let(mut stream,_)=match socket.accept(){Ok(v)=>v,Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>{std::thread::sleep(Duration::from_millis(2));continue},Err(e)=>panic!("{e}")};
  stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
  let mut buffer=Vec::new();while !buffer.windows(4).any(|v|v==b"\r\n\r\n"){
   let mut chunk=[0u8;1024];let n=stream.read(&mut chunk).unwrap();if n==0{break;}buffer.extend_from_slice(&chunk[..n]);assert!(buffer.len()<=8192);
  }
  if buffer.is_empty(){continue;}let request=String::from_utf8_lossy(&buffer);let path=request.lines().next().unwrap().split_whitespace().nth(1).unwrap().to_owned();sc.lock().unwrap().push(path.clone());assert!(!request.to_ascii_lowercase().contains("referer:"));
  let forbidden=path.starts_with("/overlay/")&&sd.load(Ordering::Relaxed);let body=if forbidden{&[][..]}else{bytes.as_slice()};let header=format!("HTTP/1.1 {}\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",if forbidden{"403 Forbidden"}else{"200 OK"},body.len());stream.write_all(header.as_bytes()).unwrap();stream.write_all(body).unwrap();
 }});
 let layers=vec![source("Base",format!("http://{address}/base/{{z}}/{{x}}/{{y}}")),source("Annotation",format!("http://{address}/overlay/{{z}}/{{x}}/{{y}}"))];let tokens=Arc::new(TiandituTokens::new(vec![],Arc::new(|_|{})));tokens.configure_diagnostic_sources(&layers);let tile=TileCoord{x:1,y:1,z:3};
 let error=preflight_layer_access(&layers,tile.clone(),dir.path(),None,&tokens,None,None).await.unwrap_err();assert!(error.starts_with("TILE_ACCESS_DENIED:"));assert!(error.contains("注记"));tokens.record_failure(&error);assert_eq!(tokens.diagnostics().acquisition.failed_source,Some(1));assert_eq!(tokens.diagnostics().acquisition.error_http_status,Some(403));{let seen=calls.lock().unwrap();assert_eq!(seen.len(),2,"prefetch requests: {seen:?}");}
 denied.store(false,Ordering::Relaxed);preflight_layer_access(&layers,tile.clone(),dir.path(),None,&tokens,None,None).await.unwrap();
 let tiles=vec![tile.clone(),TileCoord{x:2,..tile}];
 for(index,s)in layers.into_iter().enumerate(){let path=if index==0{dir.path().to_path_buf()}else{dir.path().join("__overlay_0")};let files=TileDownloader::new(s,None).unwrap().with_tianditu_tokens(tokens.clone()).download_tiles(tiles.clone(),1,&path,None,None,|_|{}).await.unwrap();assert_eq!(files.len(),2);}
 stop.store(true,Ordering::Relaxed);server.join().unwrap();let calls=calls.lock().unwrap();assert_eq!(calls.iter().filter(|s|s.starts_with("/base/")).count(),2);assert_eq!(calls.iter().filter(|s|s.as_str()=="/overlay/3/1/1").count(),2);assert_eq!(calls.len(),5);
}
