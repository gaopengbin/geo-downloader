import assert from 'node:assert/strict'
import test from 'node:test'
import { DownloadLifecycleTracker, reasonBucket } from './download-lifecycle.ts'
import { drainDownloadCheckpoint, restoreDownloadCheckpoint, type DownloadCheckpoint } from './download-monitor-checkpoint.ts'

test('task identity survives failure, resume, observer restart and removal from active list', () => {
  const taskId = crypto.randomUUID()
  const tracker = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 0)
  const start = tracker.observe([{ id: taskId, status: 'downloading' }])[0]
  const failure = tracker.observe([{ id: taskId, status: 'failed' }])[0]
  const restarted = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 1000, JSON.parse(JSON.stringify(tracker.snapshot())))
  const resume = restarted.observe([{ id: taskId, status: 'downloading' }])[0]
  const done = restarted.observe([{ id: taskId, status: 'completed' }])[0]
  assert.equal(start.attempt_id, failure.attempt_id)
  assert.notEqual(resume.attempt_id, failure.attempt_id)
  assert.equal(done.attempt_id, resume.attempt_id)
  assert.deepEqual([start, failure, resume, done].map(e => e.task_id), Array(4).fill(taskId))
  restarted.observe([])
  assert.equal(restarted.observe([{ id: taskId, status: 'downloading' }])[0].task_id, taskId)
})

test('a missing task keeps its attempt until restart reconciliation, and a later retry is distinct', () => {
  const id = crypto.randomUUID()
  const first = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 60_000, undefined, 0)
  const original = first.observe([{ id, status: 'downloading', created_at: new Date(1000).toISOString() }])[0]
  first.observe([])
  const restart = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 70_000, first.snapshot(), 0)
  const old = {id, status:'failed', created_at:new Date(1000).toISOString(), finishedAt: 1500}
  const live = {id, status:'completed', created_at:new Date(10_000).toISOString()}
  const done = {...live, finishedAt: 18_000}
  const result = restart.observe([old, done, live])
  assert.deepEqual(result.map(event => event.state), ['failed','started','completed'])
  assert.equal(result[0].attempt_id, original.attempt_id)
  assert.notEqual(result[1].attempt_id, original.attempt_id)
  assert.equal(result[2].duration, 'under_10s')
  assert.deepEqual(restart.observe([done, live]), [])
  restart.observe([])
  assert.deepEqual(restart.snapshot().map(([, attempt]) => attempt.attemptId), [original.attempt_id])
})

test('a recovered output receipt corrects the original attempt after restart and survives stale active snapshots', () => {
  const id = crypto.randomUUID()
  const created_at = new Date(1000).toISOString()
  let now = 30_000
  const tracker = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => now, [], 0)
  const failure = { id, created_at, status: 'failed', finishedAt: 2000 }
  const [start, failed] = tracker.observe([failure])
  assert.equal(start.attempt_id, failed.attempt_id)
  tracker.observe([])
  const restored = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => now, tracker.snapshot(), 0)
  const success = { ...failure, status: 'completed', finishedAt: 3000 }
  const stale = { id, created_at, status: 'failed', finished_at_ms: 2000 }
  assert.deepEqual(restored.observe([success, stale]).map(event => [event.state, event.attempt_id, event.occurredAt]),
    [['completed', failed.attempt_id, 3000]])
  assert.deepEqual(restored.observe([]), [])
  assert.deepEqual(restored.observe([success, stale]), [])
  now += 91 * 86400_000
  restored.observe([])
  assert.deepEqual(restored.snapshot(), [])
})

test('recovery that finishes between polls updates the task outcome', () => {
  const taskId = crypto.randomUUID()
  const tracker = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 0)
  tracker.observe([{ id: taskId, status: 'downloading' }])
  tracker.observe([{ id: taskId, status: 'failed' }])
  const result = tracker.observe([{ id: taskId, status: 'completed' }])
  assert.equal(result[0].task_id, taskId)
  assert.equal(result[0].state, 'completed')
  assert.equal(tracker.observe([{ id: taskId, status: 'completed' }]).length, 0)
})

test('OSM execution diagnostics survive start, failure and lifecycle tracking without credentials',()=>{
 const execution={version:1,scheduler:null,overpass:{queue_wait_ms:10,fallback_count:0,wait_ms:0,attempts:[{endpoint:'de',outcome:'connect_error',http_status:null,elapsed_ms:100,backoff_ms:0}]}};
 let id=0;const tracker=new DownloadLifecycleTracker(()=>`attempt-${++id}`,()=>1000);
 tracker.observe([]);
 const start=tracker.observe([{id:'osm',status:'downloading',download_diagnostics:{execution}}]);
 assert.deepEqual(start[0].execution,execution);
 const end=tracker.observe([{id:'osm',status:'failed',error:'OSM_SERVICE_UNAVAILABLE: network',download_diagnostics:{execution}}]);
 assert.deepEqual(end[0].execution,execution);
 assert.equal(end[0].reason,'network');
 assert.equal(tracker.observe([{id:'osm',status:'failed',download_diagnostics:{execution}}]).length,0);
});

test('stable download codes classify access, quota, rate limits, source data and storage errors', () => {
  const cases = [
    ['TILE_NETWORK_CONNECT: private configuration', 'network'],
    ['TILE_NETWORK_TIMEOUT: timeout', 'network'],
    ['TILE_NETWORK_BODY: interrupted', 'network'],
    ['TILE_NETWORK_REQUEST: send failed', 'network'],
    ['TILE_ACCESS_DENIED: HTTP 403; 请检查权限', 'auth'],
    ['任务失败: TILE_TOKENS_EXHAUSTED: 所有 Token 额度不足', 'auth'],
    ['TILE_RATE_LIMITED: HTTP 429', 'network'],
    ['INVALID_TILE: 服务返回无效瓦片', 'network'],
    ['TILE_TOO_LARGE: response exceeds limit', 'network'],
    ['OSM_OFFLINE_FORBIDDEN: 请切换图源', 'permission'],
    ['CARTO_OFFLINE_FORBIDDEN: API key required', 'permission'],
    ['TILE_REDIRECT_DENIED: redirect rejected', 'permission'],
    ['TILE_STORAGE_FAILED: 写入缓存瓦片失败: 指定的网络名不再可用 (os error 64)', 'disk'],
    ['TILE_STORAGE_FAILED: Permission denied', 'permission'],
    ['OSM_STORAGE_FAILED: 创建 OSM 临时文件失败: no space left on device', 'disk'],
    ['OSM_STORAGE_FAILED: 提交 OSM 文件失败: Access is denied', 'permission'],
    ['TILE_STORAGE_FAILED: 拒绝访问 (os error 5)', 'permission'],
    ['写入合成瓦片失败: 磁盘空间不足', 'disk'],
    ['创建叠加图层临时目录失败: I/O error', 'disk'],
    ['HTTP 401 Unauthorized', 'auth'],
    ['HTTP 403 Forbidden', 'auth'],
    ['天地图 Token 失效，请重新保存', 'auth'],
    ['令牌额度耗尽', 'auth'],
    ['该区域无可用数据（全部瓦片均返回 404）', 'missing_tiles'],
    ['下载超时，connection reset', 'network'],
    ['请求过于频繁，请稍后重试', 'network'],
    ['EACCES: open failed', 'permission'],
    ['ENOSPC: no space left on device', 'disk'],
    ['下载失败：403 张瓦片；文件 401.png', 'unknown'],
    ['未识别的处理异常', 'unknown'],
  ] as const
  for (const [message, expected] of cases) assert.equal(reasonBucket('failed', message), expected, message)
  assert.equal(reasonBucket('completed', 'TILE_STORAGE_FAILED:'), 'none')
  assert.equal(reasonBucket('cancelled', 'TILE_RATE_LIMITED:'), 'cancelled')
  assert.equal(reasonBucket('completed_with_gaps', 'TILE_TOKENS_EXHAUSTED:'), 'missing_tiles')
})

test('classification sends categories without leaking raw errors, paths or credentials', () => {
  const tracker = new DownloadLifecycleTracker(() => 'attempt-1', () => 0)
  tracker.observe([{id:'private-job', status:'downloading'}])
  const events = tracker.observe([{id:'private-job', status:'failed', error:'TILE_TOKENS_EXHAUSTED: token=private-secret', message:'C:/private/output.png'}])
  assert.equal(events[0].reason, 'auth')
  assert.deepEqual(Object.keys(events[0]).sort(), ['attempt_id','duration','occurredAt','reason','state'])
  assert.doesNotMatch(JSON.stringify(events), /private|secret|output|TILE_TOKENS/)
})

test('restarting the observer preserves attempt IDs and does not replay terminal outcomes', () => {
  let id = 0
  const tracker = new DownloadLifecycleTracker(() => `random-${++id}`, () => 0)
  const started = tracker.observe([{ id: 'a', status: 'downloading' }])[0]
  const restarted = new DownloadLifecycleTracker(() => `random-${++id}`, () => 50000, JSON.parse(JSON.stringify(tracker.snapshot())))
  assert.equal(restarted.observe([{ id: 'a', status: 'downloading' }]).length, 0)
  assert.equal(restarted.observe([{ id: 'a', status: 'completed' }])[0].attempt_id, started.attempt_id)
  const again = new DownloadLifecycleTracker(() => `random-${++id}`, () => 90000, restarted.snapshot())
  assert.equal(again.observe([{ id: 'a', status: 'completed' }]).length, 0)
})

test('baseline history is suppressed, live completion emitted once without private task fields', () => {
  let time = 0, sequence = 0
  const tracker = new DownloadLifecycleTracker(() => `uuid-${++sequence}`, () => time)
  assert.equal(tracker.observe([{id:'old',status:'completed'}]).length, 0)
  const task = {id:'private-job-path',status:'downloading',message:'https://secret.test/?key=private'}
  const started = tracker.observe([task])
  time = 25_000
  const done = tracker.observe([{...task,status:'completed'}])
  assert.equal(done[0].attempt_id, started[0].attempt_id)
  assert.equal(done[0].duration,'10-60s')
  assert.equal(done[0].state,'completed')
  assert.equal(tracker.observe([{...task,status:'completed'}]).length,0)
  assert.doesNotMatch(JSON.stringify([...started,...done]), /private|secret/)
})
test('resume creates a separate attempt, pause retains attempt, incomplete export is not success', () => {
  let sequence=0
  const tracker=new DownloadLifecycleTracker(()=>`uuid-${++sequence}`,()=>0)
  const started=tracker.observe([{id:'a',status:'downloading'}])[0]
  assert.equal(tracker.observe([{id:'a',status:'paused'}]).length,0)
  const failed=tracker.observe([{id:'a',status:'failed',error:'network timeout password=secret'}])[0]
  assert.equal(failed.reason,'network')
  assert.equal(failed.attempt_id,started.attempt_id)
  const resumed=tracker.observe([{id:'a',status:'downloading'}])[0]
  assert.notEqual(resumed.attempt_id,started.attempt_id)
  assert.equal(tracker.observe([{id:'a',status:'completed_with_gaps'}])[0].reason,'missing_tiles')
})
test('a task that finishes between polls still has an attempt, deletion is not cancellation', () => {
  const tracker=new DownloadLifecycleTracker(()=>crypto.randomUUID(),()=>0)
  tracker.observe([])
  const events=tracker.observe([{id:'fast',status:'cancelled'}])
  assert.deepEqual(events.map(e=>e.state),['started','cancelled'])
  assert.equal(tracker.observe([]).length,0)
})

test('late failed receipt is linked to its first attempt after a later retry has completed and the app restarted', () => {
  const id = crypto.randomUUID()
  const create = () => crypto.randomUUID()
  const now = () => 90_000
  const first = { id, created_at: new Date(1000).toISOString(), status: 'downloading' }
  const second = { ...first, created_at: new Date(3000).toISOString() }
  const tracker = new DownloadLifecycleTracker(create, now, undefined, 0)
  const [startA] = tracker.observe([first])
  const [startB] = tracker.observe([second])
  const [success] = tracker.observe([{ ...second, status: 'completed', finished_at_ms: 6000 }])
  const checkpoint = restoreDownloadCheckpoint(JSON.stringify({ attempts: tracker.snapshot(), cursor: 12 }))
  const restored = new DownloadLifecycleTracker(create, now, checkpoint.attempts, 0)
  const late = { ...first, status: 'failed', finishedAt: 2000 }
  const done = { ...second, status: 'completed', finishedAt: 6000 }
  const live = { ...second, status: 'completed', finished_at_ms: 6000 }
  const result = restored.observe([late, done, live])
  assert.equal(checkpoint.cursor, 12)
  assert.deepEqual(result.map(event => [event.attempt_id, event.state, event.occurredAt]), [[startA.attempt_id, 'failed', 2000]])
  assert.equal(startA.occurredAt, 1000)
  assert.equal(startB.occurredAt, 3000)
  assert.equal(success.occurredAt, 6000)
  assert.equal(success.attempt_id, startB.attempt_id)
  assert.deepEqual(restored.observe([live]), [])
})

test('an unversioned legacy snapshot is bound to the live retry before an older journal receipt', () => {
  const id = crypto.randomUUID()
  const legacyId = crypto.randomUUID()
  const oldSnapshot = [[id, { attemptId: legacyId, status: 'downloading', startedAt: 3100 }]]
  const { attempts } = restoreDownloadCheckpoint(JSON.stringify(oldSnapshot))
  const tracker = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 50_000, attempts, 0)
  const earlier = { id, created_at: new Date(1000).toISOString(), status: 'failed', finishedAt: 2000 }
  const live = { id, created_at: new Date(3000).toISOString(), status: 'completed', finished_at_ms: 4500 }
  const events = tracker.observe([earlier, live])
  assert.deepEqual(events.map(item => [item.state, item.occurredAt]), [['failed', 2000], ['completed', 4500]])
  assert.notEqual(events[0].attempt_id, legacyId)
  assert.equal(events[1].attempt_id, legacyId)
})

test('replay after delivery and before checkpoint acknowledgement retains event IDs and respects queue backpressure', async () => {
  const tracker = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 90_000, [], 0)
  const id = crypto.randomUUID()
  const events = tracker.observe([{ id, created_at: new Date(1000).toISOString(), status: 'completed', finishedAt: 3500 }])
  let disk = JSON.stringify({ attempts: tracker.snapshot(), cursor: 1,
    pending: events.map(event => ({ event, eventId: crypto.randomUUID() })) })
  const accepted = new Set<string>()
  const stage = () => restoreDownloadCheckpoint(disk)
  const first = stage().pending[0].eventId
  await assert.rejects(drainDownloadCheckpoint(stage(), async item => {
    if (item.eventId !== first) return false
    accepted.add(item.eventId)
    return true
  }, () => { throw new Error('simulated process exit') }), /simulated process exit/)
  assert.equal(stage().pending[0].eventId, first)
  const persist = (next: DownloadCheckpoint) => { disk = JSON.stringify(next) }
  await drainDownloadCheckpoint(stage(), async item => {
    if (!accepted.has(item.eventId)) return false
    accepted.add(item.eventId)
    return true
  }, persist)
  assert.deepEqual(stage().pending.map(item => item.event.state), ['completed'])
  await drainDownloadCheckpoint(stage(), async item => { accepted.add(item.eventId); return true }, persist)
  assert.equal(accepted.size, 2)
  assert.equal(stage().pending.length, 0)
  assert.equal(stage().cursor, 1)
})

test('a retry created after a legacy snapshot cannot take the previous attempt ID', () => {
  const id = crypto.randomUUID()
  const old = crypto.randomUUID()
  const tracker = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 50_000,
    [[id, { attemptId: old, status: 'downloading', startedAt: 1500 }]], 0)
  const retry = { id, status: 'downloading', created_at: new Date(3000).toISOString() }
  const [start] = tracker.observe([retry])
  assert.notEqual(start.attempt_id, old)
  const receipt = { id, status: 'failed', created_at: new Date(1000).toISOString(), finishedAt: 1900 }
  const [failure] = tracker.observe([receipt, retry])
  assert.equal(failure.attempt_id, old)
  assert.equal(failure.state, 'failed')
})
