// Release acceptance with an explicitly provisioned internal account.
// Credentials stay in the ignored release evidence folder; no raw tokens in logs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const root=fileURLToPath(new URL('../../..',import.meta.url));
const out=path.join(root,'artifacts/tools-usage-release/online');await mkdir(out,{recursive:true});
const qa=JSON.parse(await readFile(path.join(root,'artifacts/tools-usage-release/qa-private.json'),'utf8'));
assert.equal(qa.isTestAccount,true);assert.equal(qa.analyticsAudience,'internal');
const base='https://laogao.xyz/geod-mcp',resource=base+'/mcp';
const cli=path.join(root,'output/geod-cli-public-0.3.3/npm/package/native/geod.exe');
const mcp=path.join(root,'output/geod-mcp-package-0.1.7/stage');
const env={...process.env,GEOD_USAGE_TEST:'1',GEOD_TELEMETRY:'1'};
delete env.GEOD_USAGE_ENDPOINT;delete env.GEOD_USAGE_PARENT;delete env.GEOD_SERVER_AUTHENTICATED;
const receipt={startedAt:new Date().toISOString(),accountId:qa.accountId,isTestAccount:true,checks:{}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function post(url,value,{form=false,cookie=false}={}){
 const res=await fetch(url,{method:'POST',headers:{'content-type':form?'application/x-www-form-urlencoded':'application/json',origin:'https://laogao.xyz',...(cookie?{cookie:qa.cookie}:{})},body:form?new URLSearchParams(value):JSON.stringify(value),signal:AbortSignal.timeout(20000)});
 const data=await res.json();assert.ok(res.ok,`HTTP ${res.status}: ${data.error||'request rejected'}`);return data;
}
function launch(command,args,home){
 const child=spawn(command,args,{cwd:out,env:{...env,GEOD_CLI_HOME:home},windowsHide:true,shell:false});let stdout='',stderr='';
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{let value;try{value=JSON.parse(stdout)}catch{};resolve({code,value});});});
 return {child,done,stderr:()=>stderr};
}
async function authorizeUrl(url){
 const page=await fetch(url,{signal:AbortSignal.timeout(20000)}).then(r=>r.text());
 const transaction=page.match(/const tx="([^"]+)"/)?.[1];assert.ok(transaction,'OAuth authorization page');
 return post(base+'/oauth/approve',{transaction},{cookie:true});
}
async function nativeLogin(command,args,home){
 await mkdir(home,{recursive:true});const p=launch(command,args,home);
 try{
  let url;for(let i=0;i<150;i++){url=p.stderr().match(/https:\/\/laogao\.xyz\/geod-mcp\/oauth\/authorize\?[^\s]+/)?.[0];if(url)break;await delay(100)}
  assert.ok(url,'Native login URL emitted');const approval=await authorizeUrl(url);
  const res=await fetch(approval.redirect,{signal:AbortSignal.timeout(10000)});assert.equal(res.status,200);
  const result=await p.done;assert.equal(result.code,0);assert.equal(result.value.authenticated,true);return JSON.parse(await readFile(path.join(home,'account.json'),'utf8'));
 }catch(e){p.child.kill();throw e}
}
async function hostedLogin(){
 const redirect='http://127.0.0.1:49152/callback';
 const reg=await post(base+'/oauth/register',{client_name:'GeoD online telemetry QA',geod_product:'mcp',redirect_uris:[redirect]});
 const verifier=randomBytes(32).toString('base64url');const url=new URL(base+'/oauth/authorize');
 for(const [k,v]of Object.entries({client_id:reg.client_id,redirect_uri:redirect,response_type:'code',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),resource,scope:'geod:tools',state:'internal-qa'}))url.searchParams.set(k,v);
 const approval=await authorizeUrl(url);const code=new URL(approval.redirect).searchParams.get('code');
 const grant=await post(base+'/oauth/token',{grant_type:'authorization_code',client_id:reg.client_id,redirect_uri:redirect,code,code_verifier:verifier,resource},{form:true});
 const refresh=await post(base+'/oauth/token',{grant_type:'refresh_token',client_id:reg.client_id,refresh_token:grant.refresh_token,resource},{form:true});assert.ok(refresh.access_token);return refresh.access_token;
}
async function call(client,name,args={}){const res=await client.callTool({name,arguments:args});assert.ok(!res.isError,`${name}: ${res.structuredContent?.error?.code}`);return res.structuredContent;}
async function download(client,request,mode){
 await call(client,'geod_capabilities');await call(client,'geod_sources',{action:'list'});await call(client,'geod_plan',{request});
 const start=await call(client,'geod_fetch',{request});assert.ok(start.jobId);
 const deadline=Date.now()+120000;let job;
 while(Date.now()<deadline){job=await call(client,'geod_job_status',{jobId:start.jobId});if(['completed','failed','cancelled'].includes(job.status))break;await delay(1000)}
 assert.equal(job.status,'completed',`Download state ${job.status}`);assert.equal(job.result.manifest.quality.status,'complete');
 const artifact=job.artifacts.find(a=>a.mimeType==='application/geo+json')||job.artifacts.find(a=>a.name.endsWith('.geojson'));assert.ok(artifact);
 if(mode==='http'){
  const link=await call(client,'geod_artifact_link',{jobId:job.jobId,artifactId:artifact.id});
  const res=await fetch(link.url,{signal:AbortSignal.timeout(20000)});assert.equal(res.status,200);const bytes=Buffer.from(await res.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'),link.artifact.sha256);assert.equal(JSON.parse(bytes).type,'FeatureCollection');
  await writeFile(path.join(out,'hosted-boundary.geojson'),bytes);
 }
 return {jobId:job.jobId,status:job.status,quality:job.result.manifest.quality.status,artifactCount:job.artifacts.length,artifactSha256:artifact.sha256};
}
let stdio,http;
try{
 const home=path.join(out,'cli-home');await nativeLogin(cli,['auth','login'],home);receipt.checks.cliAuthorization=true;
 const request=JSON.parse(await readFile(path.join(root,'examples/geod-cli/henan-boundary.json'),'utf8'));const requestPath=path.join(out,'request.json');await writeFile(requestPath,JSON.stringify(request));
 const run=await launch(cli,['fetch','--request',requestPath,'--out',path.join(out,'cli-boundary')],home).done;assert.equal(run.code,0);assert.equal(run.value.manifest.quality.status,'complete');
 const inspect=await launch(cli,['inspect','--bundle',path.join(out,'cli-boundary')],home).done;assert.equal(inspect.code,0);receipt.checks.cli={quality:'complete',inspect:true};console.log('Packaged CLI: production authorization, download and inspection passed.');
 const mcpHome=path.join(out,'mcp-home');await nativeLogin(process.execPath,[path.join(mcp,'bin/geod-mcp.mjs'),'auth','login'],mcpHome);receipt.checks.localMcpAuthorization=true;
 stdio=new Client({name:'geod-tools-usage-qa',version:'1.0.0'});await stdio.connect(new StdioClientTransport({command:process.execPath,args:[path.join(mcp,'bin/geod-mcp.mjs')],cwd:out,env:{...env,GEOD_CLI_HOME:mcpHome,GEOD_WORKSPACE:out,GEOD_OUTPUT_DIR:path.join(out,'mcp-jobs')},stderr:'pipe'}));
 await stdio.listTools();receipt.checks.stdio=await download(stdio,request,'stdio');await stdio.close();stdio=null;console.log('Packaged MCP: production authorization and download passed.');
 const token=await hostedLogin();receipt.checks.httpAuthorization=true;receipt.checks.refresh=true;
 http=new Client({name:'geod-tools-usage-qa-http',version:'1.0.0'});await http.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 await http.listTools();receipt.checks.http=await download(http,request,'http');console.log('Hosted MCP: authorization, download and delivered file checksum passed.');
 const failed=await http.callTool({name:'geod_job_status',arguments:{jobId:'qa-deliberately-missing-job'}});assert.ok(failed.isError);receipt.checks.missingJob={expectedFailure:true,code:failed.structuredContent.error.code};
 receipt.passed=true;receipt.finishedAt=new Date().toISOString();await writeFile(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}catch(error){receipt.passed=false;receipt.error=error.message;await writeFile(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.error(JSON.stringify({passed:false,error:error.message}));process.exitCode=1}
finally{await stdio?.close();await http?.close()}
