import test from'node:test';import assert from'node:assert/strict';
import{validateDownloadDiagnostic}from'../download-diagnostic.mjs';
const source={role:'overlay',provider:'amap',endpoint:'amap-appmaptile',fingerprint:'a'.repeat(64),host:'webst01.is.autonavi.com',options:{style:'8',x_binding:'x',y_binding:'y',z_binding:'z'},authentication_configured:false,http_status:403,last_rejection_status:403,observed_responses:1};
const value=()=>({version:1,phase:'overlay_download',sources:[source],storage:[{roles:['output'],volume:'E:',budget_kind:'preflight',required_bytes:400,available_bytes:600,met_budget:true}],storage_checked_at:null,failed_source:0,error_code:'SOURCE_UNAUTHORIZED',error_http_status:403,additional_sources:0});
test('source roles, real HTTP status and nullable disk measurements survive strict validation',()=>{
 const v=value();assert.deepEqual(validateDownloadDiagnostic(v),v);v.sources=[];v.failed_source=null;v.storage[0].available_bytes=null;v.storage[0].met_budget=null;assert.equal(validateDownloadDiagnostic(v).storage[0].available_bytes,null);
});
test('raw URLs, tokens, paths, coordinates and invented observations are rejected',()=>{
 for(const modify of [v=>v.url='https://private/?token=secret',v=>v.sources[0]={...source,token:'secret'},v=>v.sources[0]={...source,host:'https://host/?key=secret'},v=>v.sources[0]={...source,options:{token:'secret'}},v=>v.storage[0].volume='C:/Users/private',v=>v.storage[0].met_budget=false,v=>v.sources[0]={...source,observed_responses:0}]){const v=value();modify(v);assert.throws(()=>validateDownloadDiagnostic(v));}
});
