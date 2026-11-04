import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {initializeDatabase} from '../database.mjs';
import {validateExecutionDiagnostic} from '../execution-diagnostic.mjs';
import {validateEnvelope,createTelemetryServer} from '../server.mjs';
const scheduler=()=>({version:1,overpass:null,scheduler:{provider:'tianditu',requests:3,responses:2,http_404:0,http_429:1,http_503:0,timeouts:1,network_errors:0,gate_wait_ms:1200,retry_wait_ms:300,last_backoff_ms:1000,max_backoff_ms:1000,observed_ms:1500,peak_qps:2,max_in_flight:2,waiting_requests:0,target_qps:8,target_concurrency:2,user_rate:4,user_batch_size:10,user_batch_pause_ms:1000}});
const overpass=()=>({version:1,scheduler:null,overpass:{queue_wait_ms:500,fallback_count:1,wait_ms:1000,attempts:[{endpoint:'de',outcome:'http_error',http_status:429,elapsed_ms:20,backoff_ms:1000},{endpoint:'mailru',outcome:'success',http_status:200,elapsed_ms:50,backoff_ms:0}]}});
function envelope(execution){return {schema_version:1,events:[{event_id:crypto.randomUUID(),event:'download_task_state',occurred_at:new Date().toISOString(),install_id:crypto.randomUUID(),session_id:crypto.randomUUID(),app_version:'3.6.27',platform:'windows',properties:{attempt_id:crypto.randomUUID(),state:'failed',duration:'10-60s',reason:'network',...(execution?{execution}:{})}}]};}
test('collector preserves optional execution details and keeps accepting old events',()=>{
 for(const value of [scheduler(),overpass()]) {
  assert.deepEqual(validateExecutionDiagnostic(value),value);
  assert.deepEqual(validateEnvelope(envelope(value))[0].properties.execution,value);
 }
 assert.equal(validateEnvelope(envelope())[0].properties.execution,undefined);
});
test('closed schema rejects identifiers, URLs, query text and impossible counters',()=>{
 for(const change of [d=>d.token='secret',d=>d.scheduler.url='https://private',d=>d.scheduler.requests=-1,d=>d.scheduler.responses=4,d=>d.scheduler.peak_qps=4,d=>d.scheduler.user_rate=10001,d=>d.scheduler.max_backoff_ms=999999999,d=>d.scheduler.max_in_flight=NaN]) {
  const d=scheduler();change(d);assert.throws(()=>validateExecutionDiagnostic(d));assert.throws(()=>validateEnvelope(envelope(d)));
 }
 for(const change of [d=>d.overpass.attempts[0].endpoint='https://private?token=x',d=>d.overpass.query='coordinates',d=>d.overpass.fallback_count=2,d=>d.overpass.attempts[1].http_status=null]){
  const d=overpass();change(d);assert.throws(()=>validateExecutionDiagnostic(d));
 }
});
test('native serialized fixtures pass both client and collector schema without losing fields',async(t)=>{
 const dir=process.env.GEOD_EXECUTION_DIAGNOSTIC_FIXTURES;if(!dir)return t.skip('Set GEOD_EXECUTION_DIAGNOSTIC_FIXTURES after native tests');
 const client=await import('../../../frontend/src/features/telemetry/execution-diagnostic.mjs');
 for(const name of ['scheduler','overpass']){
  const d=JSON.parse(await readFile(`${dir}/${name}.json`,'utf8'));
  assert.deepEqual(client.validateExecutionDiagnostic(d),d);
  assert.deepEqual(validateEnvelope(envelope(d))[0].properties.execution,d);
 }
});
test('client and collector execution contracts stay identical',async()=>{
 const [client,collector]=await Promise.all([readFile(new URL('../../../frontend/src/features/telemetry/execution-diagnostic.mjs',import.meta.url)),readFile(new URL('../execution-diagnostic.mjs',import.meta.url))]);
 assert.deepEqual(client,collector);
});
test('HTTP ingestion persists execution details and remains idempotent',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'geod-execution-'));
 const config={databasePath:path.join(directory,'events.sqlite'),databaseId:'geod-execution-test',environment:'test',adminTokenFile:path.join(directory,'admin.txt'),host:'127.0.0.1',port:0,maxBodyBytes:131072,rateLimitPerMinute:1000};
 await writeFile(config.adminTokenFile,'test-only-token');initializeDatabase({...config,createNew:true,offlineConfirmed:true});
 const server=await createTelemetryServer({config});server.listen(0,'127.0.0.1');await once(server,'listening');
 try {
  const body=envelope(overpass());
  for(let i=0;i<2;i++){
   const result=await fetch(`http://127.0.0.1:${server.address().port}/geod-telemetry/v1/events`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
   assert.equal(result.status,202);await result.text();
  }
  const db=new DatabaseSync(config.databasePath,{readOnly:true});
  try {const rows=db.prepare('SELECT properties_json FROM events').all();assert.equal(rows.length,1);assert.deepEqual(JSON.parse(rows[0].properties_json).execution,overpass());}finally{db.close();}
 }finally{
  server.close();await once(server,'close');
  assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('geod-execution-'));
  await rm(directory,{recursive:true,force:true});
 }
});
