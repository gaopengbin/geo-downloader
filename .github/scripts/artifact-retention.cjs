'use strict';
const DAY = 86400000;
// Deliberately allowlisted. New artifact types are retained until reviewed.
function rule(repository, name) {
  const repo = repository.split('/')[1];
  if (repo === 'geostyle' && name === 'geostyle-release') return {family:name, keep:2, days:3};
  if (repo === 'gaopengbin-dashboard') {
    if (['github-stats-site','laogao-home'].includes(name)) return {family:name, keep:0, days:1};
    if (name === 'trusted-backup-control') return {family:name, keep:1, days:3};
    if (name === 'portfolio-release') return {family:name, keep:2, days:7};
    const match = /^tencent-(home|github-stats|platform-api|geod-telemetry|laogaoai|new-api)-\d+$/.exec(name);
    if (match) return {family:`tencent-${match[1]}`, keep:2, days:3};
  }
  if (repo === 'geo-downloader') {
    if (/^release-(Windows|Linux|macOS-arm64|macOS-x64)$/.test(name)) return {family:name, keep:2, days:3};
    if (/^geod-mcp-linux-[a-f0-9]{40}$/.test(name)) return {family:'geod-mcp-linux', keep:2, days:7};
  }
  if (repo === 'geod-global') {
    if (/^transport-smoke-(Linux|Windows)-\d+$/.test(name)) return {family:'transport-smoke', keep:0, days:1};
    if (name === 'geod-global-windows-x64-unsigned') return {family:name, keep:2, days:7};
  }
  if (repo === 'codex-launch-deck') {
    if (name === 'LaunchDeck-portable-win-x64') return {family:name, keep:2, days:3};
    if (name === 'Codex-Proxy-Launch-Deck-win-x64') return {family:name, keep:2, days:7};
  }
  return null;
}

function plan({repository, artifacts, runs, now=Date.now(), pinned=[]}) {
  const pinnedIds = new Set(pinned.map(String));
  const entries = artifacts.map(a => {
    const r = runs.get(a.workflow_run?.id);
    const policy = rule(repository, a.name);
    const age = now - Date.parse(a.created_at);
    const trusted = r && r.repository?.full_name === repository && r.head_repository?.full_name === repository;
    const sameRun = r && a.workflow_run?.head_sha === r.head_sha && a.workflow_run?.head_branch === r.head_branch;
    let reason = !policy ? 'unknown-type' : !r ? 'missing-run' : !trusted ? 'foreign-run' : !sameRun ? 'run-mismatch' : r.status !== 'completed' ? 'active-run' : pinnedIds.has(String(r.id)) ? 'pinned-run' : !Number.isFinite(age) || age < DAY ? 'grace-period' : null;
    return {artifact:a, run:r, policy, age, reason};
  });
  // Protect distinct successful runs, not merely the latest individual files.
  // Ref/event/workflow isolation prevents PRs, tags, or other branches displacing rollback candidates.
  const groups = new Map();
  for (const e of entries) {
    if (!e.policy || !e.run || ['unknown-type','missing-run','foreign-run','run-mismatch','active-run'].includes(e.reason) || e.run.conclusion !== 'success') continue;
    const key = JSON.stringify([e.policy.family,e.run.workflow_id,e.run.head_branch,e.run.event]);
    const group = groups.get(key) || [];
    group.push(e); groups.set(key,group);
  }
  const protectedRuns = new Set();
  for (const group of groups.values()) {
    const ids = [...new Set(group.sort((a,b)=>Date.parse(b.artifact.created_at)-Date.parse(a.artifact.created_at)).map(e=>e.run.id))];
    for (const id of ids.slice(0,group[0].policy.keep)) protectedRuns.add(`${group[0].policy.family}:${id}`);
  }
  return entries.map(e => {
    if (!e.reason && protectedRuns.has(`${e.policy.family}:${e.run.id}`)) e.reason='recent-success';
    // An unsuccessful build is retained for the normal diagnostic window.
    if (!e.reason && e.run.conclusion !== 'success' && e.age < e.policy.days*DAY) e.reason='failure-diagnostics';
    return {id:e.artifact.id,name:e.artifact.name,runId:e.run?.id,bytes:e.artifact.size_in_bytes,
      reason:e.reason || 'superseded-or-expired',delete:!e.reason,
      fingerprint:JSON.stringify([e.artifact.name,e.artifact.created_at,e.artifact.workflow_run?.id,e.artifact.workflow_run?.head_sha])};
  });
}

async function main() {
  const fs=require('node:fs');
  const repository=process.env.GITHUB_REPOSITORY;
  const expected=JSON.parse(fs.readFileSync(`${__dirname}/artifact-retention.json`,'utf8')).repository;
  if (repository !== expected) throw new Error('Repository does not match the reviewed retention policy');
  if (!process.env.GITHUB_TOKEN) throw new Error('Missing Actions token');
  if (!['true','false'].includes(process.env.DRY_RUN)) throw new Error('DRY_RUN must be explicit');
  const dryRun=process.env.DRY_RUN==='true';
  const pinText=process.env.PINNED_RUN_IDS || '';
  if (pinText && !/^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(pinText)) throw new Error('Invalid pinned run list; refusing cleanup');
  const pinned=pinText.split(',').map(s=>s.trim()).filter(Boolean);
  async function api(path,method='GET') {
    const response=await fetch(`https://api.github.com/repos/${repository}/${path}`,{method,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,'X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(30000)});
    if (method==='DELETE' && response.status===404) return null;
    if (!response.ok) throw new Error(`GitHub API ${method} ${path}: ${response.status}`);
    return response.status===204 ? null : response.json();
  }
  const artifacts=[];
  for(let page=1;page<=100;page++) {
    const data=await api(`actions/artifacts?per_page=100&page=${page}`);
    artifacts.push(...data.artifacts);
    if(data.artifacts.length<100) break;
    if(page===100) throw new Error('Inventory limit reached; no artifacts deleted');
  }
  const runs=new Map();
  // Complete the entire inventory before the first mutation. Any lookup error fails closed.
  for(const id of new Set(artifacts.map(a=>a.workflow_run?.id).filter(Boolean))) runs.set(id,await api(`actions/runs/${id}`));
  const decisions=plan({repository,artifacts,runs,pinned});
  let deleted=0,bytes=0;
  for(const decision of decisions) {
    console.log(JSON.stringify({...decision,fingerprint:undefined,dryRun}));
    if(!decision.delete || dryRun) continue;
    const fresh=await api(`actions/artifacts/${decision.id}`);
    const fingerprint=JSON.stringify([fresh.name,fresh.created_at,fresh.workflow_run?.id,fresh.workflow_run?.head_sha]);
    if(fingerprint!==decision.fingerprint) throw new Error('Artifact identity changed; stopping cleanup');
    // A rerun may have started since planning. Never remove inputs from an active run.
    const run=await api(`actions/runs/${decision.runId}`);
    if(run.status!=='completed') {console.log(`Skipped active rerun ${decision.runId}`);continue;}
    await api(`actions/artifacts/${decision.id}`,'DELETE');
    deleted++;bytes+=decision.bytes;
  }
  const report={repository,dryRun,inspected:artifacts.length,candidates:decisions.filter(d=>d.delete).length,deleted,deletedBytes:bytes,retained:decisions.filter(d=>!d.delete).length};
  console.log(JSON.stringify(report));
  if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## Artifact retention\n\n\`\`\`json\n${JSON.stringify(report,null,2)}\n\`\`\`\n\nOnly allowlisted Actions artifacts were considered. Releases, caches, workflow logs, and server rollback files were not modified.\n`);
}
module.exports={rule,plan};
if(require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1});
