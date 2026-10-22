const {test}=require('node:test');
const assert=require('node:assert/strict');
const {plan,rule}=require('./artifact-retention.cjs');
const DAY=86400000,now=Date.parse('2026-10-22T12:00:00Z');
const repository='gaopengbin/geostyle';
function fixture(id,days=2,extra={}) {return {id,name:'geostyle-release',size_in_bytes:100,created_at:new Date(now-days*DAY).toISOString(),workflow_run:{id,head_sha:`sha${id}`,head_branch:'main'},...extra};}
function run(a,extra={}) {return {id:a.workflow_run.id,status:'completed',conclusion:'success',repository:{full_name:repository},head_repository:{full_name:repository},head_sha:a.workflow_run.head_sha,head_branch:a.workflow_run.head_branch,workflow_id:12,event:'push',...extra};}
function decide(artifacts,overrides={},opts={}) {return plan({repository,now,artifacts,runs:new Map(artifacts.map(a=>[a.workflow_run.id,run(a,overrides[a.id])])),...opts});}
test('protect latest two successful distinct source builds',()=>assert.deepEqual(decide([fixture(3,2),fixture(2,3),fixture(1,4)]).map(x=>x.delete),[false,false,true]));
test('active runs never deleted even old',()=>assert.equal(decide([fixture(1,20)],{1:{status:'in_progress'}})[0].reason,'active-run'));
test('active reruns do not displace completed rollback builds',()=>assert.deepEqual(decide([fixture(4,1),fixture(3,2),fixture(2,3),fixture(1,4)],{4:{status:'in_progress'}}).map(x=>x.delete),[false,false,false,true]));
test('unknown names fail closed',()=>assert.equal(decide([fixture(1,20,{name:'database-backup'})])[0].delete,false));
test('pinned runs survive supersession',()=>assert.equal(decide([fixture(3),fixture(2,3),fixture(1,20)],{}, {pinned:['1']})[2].reason,'pinned-run'));
test('foreign source repository is retained',()=>assert.equal(decide([fixture(1,20)],{1:{head_repository:{full_name:'other/fork'}}})[0].reason,'foreign-run'));
test('source SHA mismatch is retained',()=>assert.equal(decide([fixture(1,20)],{1:{head_sha:'unexpected'}})[0].reason,'run-mismatch'));
test('new successful builds have a full-day grace period',()=>assert.equal(decide([fixture(1,0.5)])[0].reason,'grace-period'));
test('failed builds retain diagnostic window but are not rollback pins',()=>{assert.equal(decide([fixture(1,2)],{1:{conclusion:'failure'}})[0].delete,false);assert.equal(decide([fixture(1,4)],{1:{conclusion:'failure'}})[0].delete,true)});
test('different branches cannot displace main rollback inputs',()=>{const a=fixture(4,2);a.workflow_run.head_branch='feature';assert.deepEqual(decide([a,fixture(3,3),fixture(2,4),fixture(1,5)]).map(x=>x.delete),[false,false,false,true])});
test('missing run retained',()=>assert.equal(decide([fixture(1,20)],{}, {runs:new Map()})[0].reason,'missing-run'));
test('malformed timestamp retained',()=>assert.equal(decide([fixture(1,20,{created_at:'invalid'})])[0].delete,false));
test('smoke artifacts expire after one day without keep-forever pins',()=>{const a=fixture(1,2,{name:'transport-smoke-Windows-1'});const r=run(a);r.repository.full_name=r.head_repository.full_name='gaopengbin/geod-global';assert.equal(plan({repository:'gaopengbin/geod-global',now,artifacts:[a],runs:new Map([[1,r]])})[0].delete,true)});
test('target-specific Linux candidates do not collapse services',()=>{assert.notEqual(rule('gaopengbin/gaopengbin-dashboard','tencent-platform-api-123').family,rule('gaopengbin/gaopengbin-dashboard','tencent-new-api-124').family)});
test('unrecognized targets and unrelated repositories cannot be deleted',()=>{assert.equal(rule('gaopengbin/gaopengbin-dashboard','tencent-database-123'),null);assert.equal(rule('gaopengbin/other','geostyle-release'),null)});
