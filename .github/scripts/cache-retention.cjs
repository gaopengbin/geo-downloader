'use strict';
const fs = require('node:fs');
const DAY = 86400000;

// Only dependency / compiled-build caches reviewed in the storage inventory.
function family(key) {
  if (/^actions-transport-(Linux|Windows)-\d+$/.test(key)) return 'transport-smoke';
  if (/^node-cache-(Linux|Windows|macOS|Darwin)-(x64|arm64)-(npm|yarn|pnpm)-[a-f0-9]+$/.test(key)) return key.replace(/-[a-f0-9]+$/, '');
  if (/^setup-python-(Linux|Windows|macOS|Darwin)-[^\s]+-pip-[a-f0-9]+$/.test(key)) return key.replace(/-[a-f0-9]+$/, '');
  if (/^v\d+-rust-[A-Za-z0-9_.-]+(?:-[a-f0-9]{8,}){2}$/.test(key)) return key.replace(/(?:-[a-f0-9]{8,}){2}$/, '');
  return null;
}
function fingerprint(c) {
  return JSON.stringify([c.id,c.key,c.ref,c.version,c.created_at,c.size_in_bytes]);
}
function plan({caches, defaultBranch, pullStates, active=false, now=Date.now(), budgetBytes}) {
  const rows=caches.map(cache=>{
    const type=family(cache.key), created=now-Date.parse(cache.created_at), idle=now-Date.parse(cache.last_accessed_at);
    const pr=/^refs\/pull\/(\d+)\/merge$/.exec(cache.ref);
    const main=cache.ref===`refs/heads/${defaultBranch}`;
    // Tag and branch caches are regenerable, but never evict an unknown ref scheme.
    const knownRef=main || pr || /^refs\/(heads|tags)\/.+/.test(cache.ref);
    let reason=!type?'unknown-key':!knownRef?'unknown-ref':active?'active-workflow':
      !Number.isFinite(created)||!Number.isFinite(idle)||created<0||idle<0?'invalid-time':
      created<DAY||idle<DAY?'recent-use':pr&&pullStates.get(Number(pr[1]))!=='closed'?'open-or-unknown-pr':null;
    return {cache,type,main,pr,created,idle,reason,delete:false};
  });
  const latest=new Map();
  for(const r of rows) if(r.type&&r.main&&Number.isFinite(r.created)&&r.created>=0) {
    const prev=latest.get(r.type);
    if(!prev||Date.parse(r.cache.created_at)>Date.parse(prev.cache.created_at)) latest.set(r.type,r);
  }
  for(const r of rows) {
    if(r.reason) continue;
    if(r.pr) {r.reason='closed-pr';r.delete=true;}
    else if(r.type==='transport-smoke') {r.reason='expired-transport-fixture';r.delete=true;}
    else if(r.main && latest.get(r.type)!==r) {r.reason='superseded-main-key';r.delete=true;}
    else if(r.idle>=7*DAY) {r.reason='unused-seven-days';r.delete=true;}
    else if(r.main) r.reason='latest-main-key';
  }
  // Soft budget: use LRU among non-default branch/tag caches only. Active PRs,
  // current main keys and anything touched in 24 h always take precedence.
  let remaining=caches.reduce((n,c)=>n+c.size_in_bytes,0)-rows.filter(r=>r.delete).reduce((n,r)=>n+r.cache.size_in_bytes,0);
  for(const r of rows.filter(r=>!r.reason&&!r.main&&!r.pr).sort((a,b)=>b.idle-a.idle)) {
    if(remaining>budgetBytes) {r.reason='lru-over-budget';r.delete=true;remaining-=r.cache.size_in_bytes;}
    else r.reason='within-budget';
  }
  return rows.map(r=>({id:r.cache.id,key:r.cache.key,ref:r.cache.ref,bytes:r.cache.size_in_bytes,
    delete:r.delete,reason:r.reason,fingerprint:fingerprint(r.cache)}));
}

// Central safety boundary: even a future caller cannot mutate releases, refs,
// source files, logs, settings, or packages through this HTTP client.
function createApi(repository, token, request=fetch) {
  if(!/^gaopengbin\/[a-z0-9.-]+$/.test(repository)) throw new Error('Unreviewed owner/repository');
  return async function api(path,method='GET') {
    if(!['GET','DELETE'].includes(method)) throw new Error('Unsupported mutation');
    if(method==='DELETE'&&!/^actions\/(caches|artifacts)\/\d+$/.test(path)) throw new Error('Only Actions artifact/cache deletion is allowed');
    if(!/^(actions\/(caches|artifacts|runs)([/?]|$)|pulls\/\d+$)/.test(path)||path.includes('..')) throw new Error('Unreviewed API path');
    const response=await request(`https://api.github.com/repos/${repository}/${path}`,{method,
      headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(30000)});
    if(response.status===404) return null;
    if(!response.ok) throw new Error(`GitHub API ${method} ${path}: ${response.status}`);
    if(method==='DELETE'&&response.status!==204) throw new Error(`Unexpected delete status: ${response.status}`);
    return response.status===204?{deleted:true}:response.json();
  };
}
async function list(api,path,field) {
  const result=[];
  for(let page=1;page<=100;page++) {
    const data=await api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
    if(!data||!Array.isArray(data[field])) throw new Error('Incomplete inventory; refusing deletion');
    result.push(...data[field]);
    if(data[field].length<100) return result;
  }
  throw new Error('Inventory pagination limit reached; refusing deletion');
}
async function activeRuns(api,currentRun) {
  for(const status of ['in_progress','queued','waiting','pending','requested']) {
    const runs=await list(api,`actions/runs?status=${status}`,'workflow_runs');
    if(runs.some(r=>String(r.id)!==String(currentRun))) return true;
  }
  return false;
}
async function main() {
  const config=JSON.parse(fs.readFileSync(`${__dirname}/artifact-retention.json`,'utf8'));
  const repository=process.env.GITHUB_REPOSITORY;
  if(repository!==config.repository||!process.env.GITHUB_TOKEN||!['true','false'].includes(process.env.DRY_RUN)) throw new Error('Explicit repository, token and dry-run mode are required');
  if(!Number.isSafeInteger(config.cacheBudgetBytes)||config.cacheBudgetBytes<1) throw new Error('Invalid cache budget');
  const api=createApi(repository,process.env.GITHUB_TOKEN),dryRun=process.env.DRY_RUN==='true';
  const caches=await list(api,'actions/caches','actions_caches');
  const pullStates=new Map();
  for(const c of caches) {const m=/^refs\/pull\/(\d+)\/merge$/.exec(c.ref);if(m&&!pullStates.has(Number(m[1]))) {const pr=await api(`pulls/${m[1]}`);pullStates.set(Number(m[1]),pr?.state);}}
  const active=await activeRuns(api,process.env.GITHUB_RUN_ID);
  const args={caches,defaultBranch:config.defaultBranch,pullStates,active,budgetBytes:config.cacheBudgetBytes};
  const decisions=plan(args);let deleted=0,bytes=0,missing=0;
  for(const d of decisions) {
    console.log(JSON.stringify({...d,fingerprint:undefined,dryRun}));
    if(!d.delete||dryRun) continue;
    // No GET-by-cache-ID API: re-list and re-evaluate last-access time and PR state.
    const freshCaches=await list(api,'actions/caches','actions_caches');
    const fresh=freshCaches.find(c=>c.id===d.id);
    if(!fresh) {missing++;continue;}
    if(fingerprint(fresh)!==d.fingerprint) throw new Error('Cache identity changed');
    const pr=/^refs\/pull\/(\d+)\/merge$/.exec(fresh.ref);
    if(pr) pullStates.set(Number(pr[1]),(await api(`pulls/${pr[1]}`))?.state);
    const freshDecision=plan({...args,caches:freshCaches,pullStates,active:await activeRuns(api,process.env.GITHUB_RUN_ID)}).find(c=>c.id===d.id);
    if(!freshDecision?.delete) {console.log(`Skipped changed or active cache ${d.id}`);continue;}
    const result=await api(`actions/caches/${d.id}`,'DELETE');
    if(result?.deleted) {deleted++;bytes+=d.bytes;} else missing++;
  }
  const after=dryRun?caches:await list(api,'actions/caches','actions_caches');
  const total=after.reduce((n,c)=>n+c.size_in_bytes,0);
  const report={repository,dryRun,inspected:caches.length,candidates:decisions.filter(d=>d.delete).length,deleted,deletedBytes:bytes,alreadyMissing:missing,remainingBytes:total,budgetBytes:config.cacheBudgetBytes,activeWorkflow:active};
  console.log(JSON.stringify(report));
  if(total>config.cacheBudgetBytes) console.log('::warning::Cache soft budget exceeded; protected or recent caches were retained. Review this run summary.');
  if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## Cache retention\n\n\`\`\`json\n${JSON.stringify(report,null,2)}\n\`\`\`\n\n| Cache | Decision | Reason |\n|---|---|---|\n${decisions.map(d=>`| ${d.id} | ${d.delete?'eligible':'keep'} | ${d.reason} |`).join('\n')}\n\nReleases, packages, source files and workflow logs are outside the deletion API allowlist. Budget is advisory when protected caches exceed it.\n`);
}
module.exports={family,fingerprint,plan,createApi,list,activeRuns};
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1});
