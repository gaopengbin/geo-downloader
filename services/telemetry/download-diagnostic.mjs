// GeoD acquisition diagnostic v1. Shared as a versioned source artifact; MIT.
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const integer=(n,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
const nullable=(v,p)=>v===null||p(v);
const phases=new Set(['queued','prepare','storage_preflight','base_download','overlay_download','composite','cache','reproject','export','verify','completed','unknown']);
const providers=new Set(['amap','tianditu','esri','google','osm','custom','unknown']);
const endpoints=new Set(['amap-appmaptile','arcgis-image','arcgis-tile','wmts','xyz-or-other','external-protocol','unknown']);
const fail=()=>{throw Error('INVALID_DOWNLOAD_DIAGNOSTIC')};
export function validateDownloadDiagnostic(d){
 if(d===null)return null;
 if(!exact(d,['version','phase','sources','storage','storage_checked_at','failed_source','error_code','error_http_status','additional_sources'])||d.version!==1||!phases.has(d.phase)||!integer(d.additional_sources,65535)||!Array.isArray(d.sources)||d.sources.length>8||!Array.isArray(d.storage)||d.storage.length>8)fail();
 if(!nullable(d.storage_checked_at,v=>typeof v==='string'&&v.length<=40&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v))))fail();
 if(!nullable(d.error_code,v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(v))||!nullable(d.failed_source,v=>integer(v,7)&&v<d.sources.length))fail();
 if(!nullable(d.error_http_status,v=>integer(v,599)&&v>=100))fail();
 for(const s of d.sources){
  if(!exact(s,['role','provider','endpoint','fingerprint','host','options','authentication_configured','http_status','last_rejection_status','observed_responses'])||!['base','overlay'].includes(s.role)||!providers.has(s.provider)||!endpoints.has(s.endpoint)||!(/^[a-f0-9]{64}$/.test(s.fingerprint))||typeof s.authentication_configured!=='boolean'||!integer(s.observed_responses))fail();
  if(!nullable(s.host,v=>typeof v==='string'&&v.length<=253&&(/^[a-z0-9.-]+$/.test(v)||/^[a-f0-9:]+$/.test(v)))||!nullable(s.http_status,v=>integer(v,599)&&v>=100)||!nullable(s.last_rejection_status,v=>integer(v,599)&&v>=400)||(s.observed_responses===0&&s.http_status!==null))fail();
  if(!s.options||typeof s.options!=='object'||Array.isArray(s.options)||Object.keys(s.options).length>7)fail();
  for(const[k,v]of Object.entries(s.options)){
   if(['style','size','scale'].includes(k)){if(typeof v!=='string'||!/^\d{1,8}$/.test(v))fail();}
   else if(k==='lang'){if(!['zh_cn','en','zh_en'].includes(v))fail();}
   else if(['x_binding','y_binding','z_binding'].includes(k)){if(!['x','y','z','literal-or-other'].includes(v))fail();}
   else fail();
  }
 }
 for(const s of d.storage){
  if(!exact(s,['roles','volume','budget_kind','required_bytes','available_bytes','met_budget'])||!Array.isArray(s.roles)||!s.roles.length||s.roles.length>3||new Set(s.roles).size!==s.roles.length||s.roles.some(v=>!['output','cache','temporary'].includes(v))||!(typeof s.volume==='string'&&(/^[A-Z]:$/.test(s.volume)||['network','filesystem','unknown'].includes(s.volume)))||!['preflight','estimate','minimum','unknown'].includes(s.budget_kind)||!nullable(s.required_bytes,integer)||!nullable(s.available_bytes,integer)||!nullable(s.met_budget,v=>typeof v==='boolean'))fail();
  if(s.required_bytes===null||s.available_bytes===null){if(s.met_budget!==null)fail();}
  else if(s.met_budget!==(s.available_bytes>=s.required_bytes))fail();
 }
 // Return a new plain object so prototypes and caller mutations cannot be stored.
 return JSON.parse(JSON.stringify(d));
}
