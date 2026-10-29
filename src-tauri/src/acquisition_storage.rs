//! Diagnostic estimates only. Existing download guards remain authoritative;
//! this module never rejects a task or allocates its estimated bytes.
use crate::{acquisition_diagnostic::{StorageDiagnostic,safe_integer,volume_label},fs_util};
use std::path::{Path,PathBuf};

#[cfg(windows)]fn volume_key(path:&Path)->Option<String>{
 use std::os::windows::ffi::OsStrExt;
 #[link(name="kernel32")]extern "system"{fn GetVolumePathNameW(path:*const u16,mount:*mut u16,size:u32)->i32;fn GetVolumeNameForVolumeMountPointW(mount:*const u16,name:*mut u16,size:u32)->i32;}
 let input=path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();let mut mount=vec![0u16;32768];let mut name=vec![0u16;32768];
 if unsafe{GetVolumePathNameW(input.as_ptr(),mount.as_mut_ptr(),mount.len()as u32)}==0{return None;}
 let value=if unsafe{GetVolumeNameForVolumeMountPointW(mount.as_ptr(),name.as_mut_ptr(),name.len()as u32)}!=0{name}else{mount};
 Some(String::from_utf16_lossy(&value[..value.iter().position(|v|*v==0).unwrap_or(value.len())]).to_lowercase())
}
#[cfg(unix)]fn volume_key(path:&Path)->Option<String>{use std::os::unix::fs::MetadataExt;std::fs::metadata(path).ok().map(|m|m.dev().to_string())}
fn existing_usage(path:&Path)->Option<u64>{
 match std::fs::read_dir(path){
  Ok(entries)=>{let mut bytes=0u64;for item in entries{let item=item.ok()?;let m=item.metadata().ok()?;if m.is_file(){bytes=bytes.checked_add(m.len())?;}}Some(bytes)},
  Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Some(0),Err(_)=>None,
 }
}
pub fn snapshot(output:&Path,temporary:&Path,tiles:u64,overlays:usize)->Vec<StorageDiagnostic>{
 let cache=crate::tile_cache::get_config();let raw=tiles.checked_mul(256*256*4);
 let reserve=fs_util::MIN_FREE_SPACE_BYTES;
 let output_need=raw.and_then(|n|n.checked_mul(2)).and_then(|n|n.checked_add(reserve));
 let temporary_need=raw.and_then(|n|n.checked_mul(1+overlays as u64+u64::from(overlays>0))).and_then(|n|n.checked_add(reserve));
 let cache_need=if !cache.enabled{Some(0)}else{raw.and_then(|n|n.checked_mul(1+overlays as u64)).zip(existing_usage(&cache.root_dir)).and_then(|(n,used)|n.min(cache.max_total_bytes.saturating_sub(used)).checked_add(reserve))};
 let locations:[(&str,PathBuf,Option<u64>);3]=[("output",output.to_path_buf(),output_need),("temporary",temporary.to_path_buf(),temporary_need),("cache",cache.root_dir,cache_need)];
 let mut checks:Vec<(String,StorageDiagnostic)>=vec![];
 for(role,path,required)in locations{
  let ancestor=fs_util::nearest_existing_parent(&path).and_then(|p|p.canonicalize().ok());
  let key=ancestor.as_deref().and_then(volume_key).unwrap_or_else(||format!("unavailable-{role}"));
  let available=fs_util::available_space_for_path(&path).ok().and_then(safe_integer);
  let required=required.and_then(safe_integer);
  if let Some((_,check))=checks.iter_mut().find(|(k,_)|k==&key){
   check.roles.push(role.into());check.required_bytes=check.required_bytes.zip(required).and_then(|(a,b)|a.checked_add(b)).and_then(safe_integer);
   check.available_bytes=check.available_bytes.zip(available).map(|(a,b)|a.min(b));
   check.met_budget=check.required_bytes.zip(check.available_bytes).map(|(r,a)|a>=r);
  }else{
   checks.push((key,StorageDiagnostic{roles:vec![role.into()],volume:ancestor.as_ref().map(|p|volume_label(&p.display().to_string())).unwrap_or_else(||"unknown".into()),budget_kind:"estimate".into(),required_bytes:required,available_bytes:available,met_budget:required.zip(available).map(|(r,a)|a>=r)}));
  }
 }
 checks.into_iter().map(|(_,d)|d).collect()
}
