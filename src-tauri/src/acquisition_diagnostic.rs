//! GeoD acquisition diagnostic contract v1 (MIT). No URL, credentials,
//! coordinates, file names or full local paths are serialized by these types.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SourceDiagnostic {
    pub role: String,
    pub provider: String,
    pub endpoint: String,
    pub fingerprint: String,
    pub host: Option<String>,
    pub options: BTreeMap<String, String>,
    pub authentication_configured: bool,
    pub http_status: Option<u16>,
    pub last_rejection_status: Option<u16>,
    /// Count of responses actually observed by the native HTTP transport.
    pub observed_responses: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StorageDiagnostic {
    pub roles: Vec<String>,
    pub volume: String,
    pub budget_kind: String,
    pub required_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub met_budget: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionDiagnostic {
    pub version: u8,
    pub phase: String,
    pub sources: Vec<SourceDiagnostic>,
    pub storage: Vec<StorageDiagnostic>,
    pub storage_checked_at: Option<String>,
    pub failed_source: Option<usize>,
    pub error_code: Option<String>,
    pub error_http_status: Option<u16>,
    pub additional_sources: u32,
}
impl Default for AcquisitionDiagnostic {
    fn default() -> Self { Self { version:1,phase:"prepare".into(),sources:vec![],storage:vec![],storage_checked_at:None,failed_source:None,error_code:None,error_http_status:None,additional_sources:0 } }
}
pub fn safe_integer(value:u64)->Option<u64>{(value<=MAX_SAFE_INTEGER).then_some(value)}
pub fn http_status(message:&str)->Option<u16>{
    let text=message.to_ascii_uppercase();
    for marker in ["HTTP ","HTTP/1.1 ","HTTP/2 ","STATUS "]{
        if let Some(i)=text.find(marker){let bytes=text[i+marker.len()..].as_bytes();if bytes.len()>=3&&bytes[..3].iter().all(u8::is_ascii_digit){let n=std::str::from_utf8(&bytes[..3]).ok()?.parse::<u16>().ok()?;if(100..=599).contains(&n){return Some(n);}}}
    }None
}
pub fn volume_label(path:&str)->String {
    let p=path.strip_prefix(r"\\?\").unwrap_or(path);
    let bytes=p.as_bytes();
    if bytes.len()>=2&&bytes[0].is_ascii_alphabetic()&&bytes[1]==b':' {return p[..2].to_uppercase();}
    if p.starts_with(r"\\")||p.starts_with("UNC\\"){"network".into()}else{"filesystem".into()}
}
fn host_label(host:&str)->String {
    if let Ok(ip)=host.parse::<std::net::IpAddr>() {
        if ip.is_loopback(){return "loopback".into();}
        if matches!(ip,std::net::IpAddr::V4(v)if v.is_private()||v.is_link_local()){return "private".into();}
    }
    host.trim_end_matches('.').to_ascii_lowercase()
}
pub fn describe_source(role:&str,template:&str,authentication_configured:bool)->SourceDiagnostic {
    let mut options=BTreeMap::new();
    let parsed=reqwest::Url::parse(&template.replace("{s}","1"));
    let(mut provider,mut endpoint,mut host)=("unknown".to_string(),"unknown".to_string(),None);
    let mut identity="invalid-source".to_owned();
    if let Ok(mut url)=parsed {
        let hostname=url.host_str().unwrap_or_default().trim_end_matches('.').to_ascii_lowercase();
        provider=if hostname.ends_with(".autonavi.com")||hostname.ends_with(".amap.com"){"amap"}
          else if hostname=="tianditu.gov.cn"||hostname.ends_with(".tianditu.gov.cn"){"tianditu"}
          else if hostname.ends_with(".arcgisonline.com")||hostname.ends_with(".arcgis.com"){"esri"}
          else if hostname.ends_with(".google.com")||hostname.ends_with(".google.cn"){"google"}
          else if hostname.ends_with(".openstreetmap.org"){"osm"}else{"custom"}.into();
        let path=url.path().to_ascii_lowercase();
        endpoint=if provider=="amap"&&path.ends_with("/appmaptile"){"amap-appmaptile"}
          else if path.ends_with("/exportimage"){"arcgis-image"}
          else if path.contains("mapserver/tile"){"arcgis-tile"}
          else if path.contains("wmts"){"wmts"}else{"xyz-or-other"}.into();
        if !template.contains("{s}"){host=Some(host_label(&hostname));}
        let pairs=url.query_pairs().map(|(k,v)|(k.into_owned(),v.into_owned())).collect::<Vec<_>>();
        for(key,value)in &pairs {
            let key=key.to_ascii_lowercase();
            if ["style","size","scale"].contains(&key.as_str())&&value.len()<=8&&value.bytes().all(|b|b.is_ascii_digit()) {options.insert(key,value.clone());}
            else if key=="lang"&&["zh_cn","en","zh_en"].contains(&value.as_str()){options.insert(key,value.clone());}
            else if ["x","y","z"].contains(&key.as_str()) {
                let binding=match value.as_str(){"{x}"=>"x","{y}"=>"y","{z}"=>"z",_=>"literal-or-other"};options.insert(format!("{key}_binding"),binding.into());
            }
        }
        let _=url.set_username("");let _=url.set_password(None);url.set_fragment(None);url.set_query(None);
        // Only a hash of the path survives; query secrets and coordinate values
        // do not participate in identity. Safe option categories remain useful.
        identity=format!("{}|{}|{:?}",url.as_str(),role,options);
    }
    SourceDiagnostic {role:if role=="overlay"{"overlay"}else{"base"}.into(),provider,endpoint,
        fingerprint:format!("{:x}",Sha256::digest(identity.as_bytes())),host,options,
        authentication_configured,http_status:None,last_rejection_status:None,observed_responses:0}
}
impl AcquisitionDiagnostic {
    pub fn source(&mut self,role:&str,url:&str,auth:bool)->Option<usize> {
        let source=describe_source(role,url,auth);
        if let Some(i)=self.sources.iter().position(|s|s.fingerprint==source.fingerprint){return Some(i);}
        if self.sources.len()>=8{self.additional_sources=self.additional_sources.saturating_add(1);return None;}
        self.sources.push(source);Some(self.sources.len()-1)
    }
    pub fn response(&mut self,index:usize,host:&str,status:u16) {
        if let Some(source)=self.sources.get_mut(index){
            source.host=Some(host_label(host));source.http_status=Some(status);
            source.observed_responses=source.observed_responses.saturating_add(1).min(MAX_SAFE_INTEGER);
            if status>=400{source.last_rejection_status=Some(status);}
        }
    }
    pub fn fail(&mut self,code:&str,index:Option<usize>,status:Option<u16>){
        self.error_code=Some(if !code.is_empty()&&code.len()<=96&&code.bytes().all(|b|b.is_ascii_uppercase()||b.is_ascii_digit()||b==b'_'){code}else{"UNKNOWN"}.into());
        self.failed_source=index.filter(|i|*i<self.sources.len());
        self.error_http_status=status;
    }
}
#[cfg(test)]mod tests {
    use super::*;
    #[test]fn fields_never_serialize_credentials_coordinates_or_local_paths(){
        let s=describe_source("overlay","https://user:password@webst01.is.autonavi.com/appmaptile?style=8&lang=zh_cn&x={x}&y={y}&z={z}&key=private-token&bbox=1,2,3,4",true);
        let v=serde_json::to_string(&s).unwrap();for secret in ["password","private-token","bbox","1,2,3,4","https://"]{assert!(!v.contains(secret));}
        assert_eq!(s.provider,"amap");assert_eq!(s.options["style"],"8");assert_eq!(s.role,"overlay");
        assert_eq!(volume_label(r"\\?\E:\private\folder"),"E:");
    }
    #[test]fn unobserved_http_is_null_and_only_actual_responses_increment(){
        let mut d=AcquisitionDiagnostic::default();let i=d.source("base","https://tiles.example/{z}/{x}/{y}",false).unwrap();
        assert_eq!(d.sources[i].http_status,None);d.response(i,"tiles.example",403);d.fail("SOURCE_UNAUTHORIZED",Some(i),Some(403));
        assert_eq!(d.sources[i].http_status,Some(403));assert_eq!(d.sources[i].observed_responses,1);assert_eq!(d.failed_source,Some(i));
    }
}
