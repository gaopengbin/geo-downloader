import assert from 'node:assert/strict'
import test from 'node:test'
import { DownloadLifecycleTracker, reasonBucket } from './download-lifecycle.ts'

test('stable download codes classify access, quota, rate limits, source data and storage errors', () => {
  const cases = [
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
  assert.deepEqual(Object.keys(events[0]).sort(), ['attempt_id','duration','reason','state'])
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
