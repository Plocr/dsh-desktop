import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RingBuffer,
  isFeedLine,
  classifyLine,
  createDashboardState,
  clampSize,
} from '../src/main/dashboard.ts'

test('RingBuffer 丢弃最旧、保序', () => {
  const rb = new RingBuffer(3)
  rb.push('a')
  rb.push('b')
  rb.push('c')
  rb.push('d')
  assert.deepEqual(rb.all, ['b', 'c', 'd'])
  rb.clear()
  assert.deepEqual(rb.all, [])
})

test('isFeedLine 过滤发现行与空行，保留普通日志', () => {
  assert.equal(isFeedLine('stdout', ''), false)
  assert.equal(isFeedLine('stdout', 'dsh web: http://127.0.0.1:3080'), false)
  assert.equal(isFeedLine('stdout', 'dsh desktop: {"port":1,"token":"x"}'), false)
  assert.equal(isFeedLine('stdout', 'hello'), true)
  assert.equal(isFeedLine('stderr', 'dsh web: http://127.0.0.1:3080'), true) // stderr 不滤
  assert.equal(isFeedLine('stderr', 'boom'), true)
})

test('classifyLine 分级启发式', () => {
  assert.equal(classifyLine('stderr', 'anything'), 'error')
  assert.equal(classifyLine('stdout', 'Error: something failed'), 'error')
  assert.equal(classifyLine('stdout', 'warning: disk full'), 'warn')
  assert.equal(classifyLine('stdout', 'plugin loaded'), 'info')
})

test('createDashboardState：事件增量与快照形状', () => {
  const d = createDashboardState()
  d.applyHarnessState('ready')
  d.setBridge(true)
  d.applyBridgeEvent('jobs.changed', {
    jobs: [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'done' },
      { id: 'c', status: 'failed' },
    ],
  })
  d.applyBridgeEvent('job.done', { job: { id: 'b', status: 'running' } })
  d.applyBridgeEvent('approval.asked', { sessionId: 's-1' })

  const snap = d.toSnapshot()
  assert.equal(snap.harness.state, 'ready')
  assert.equal(snap.bridge, true)
  assert.equal(snap.badge, 1) // 仅 running
  assert.equal(snap.jobs.length, 3)
  // job.done 把 b 标记为 done（不重复追加）
  const b = snap.jobs.find((j) => j.id === 'b')
  assert.equal(b?.status, 'done')
  assert.equal(snap.approvals.length, 1)
  assert.equal(snap.approvals[0].sessionId, 's-1')
  assert.equal(snap.source, 'bridge')
})

test('createDashboardState：approval 环上限 20', () => {
  const d = createDashboardState()
  for (let i = 0; i < 25; i++) d.applyBridgeEvent('approval.asked', { sessionId: `s-${i}` })
  assert.equal(d.toSnapshot().approvals.length, 20)
  assert.equal(d.toSnapshot().approvals[0].sessionId, 's-5')
})

test('createDashboardState：mergeSnapshot 全量填充（sessions/runtime）', () => {
  const d = createDashboardState()
  d.mergeSnapshot({
    runtime: { pid: 1, node: 'v22', cwd: 'C:\\ws', workspaces: [{ id: 'w1', title: 'ws' }] },
    sessions: [
      { id: 'live-1', title: '会话A', live: true },
      { id: 'persist-1', live: false },
    ],
    jobs: [{ id: 'j1', status: 'completed' }],
    approvals: [{ sessionId: 'x', askedAt: 1 }],
  })
  const snap = d.toSnapshot()
  assert.equal(snap.runtime?.pid, 1)
  assert.equal(snap.sessions.live, 1)
  assert.equal(snap.sessions.persisted, 1)
  assert.equal(snap.sessions.rows.length, 2)
  assert.equal(snap.jobs.length, 1)
  assert.equal(snap.badge, 0)
  // 合并非法快照不抛错
  d.mergeSnapshot(null)
  d.mergeSnapshot({ jobs: 'junk' })
  assert.equal(d.toSnapshot().jobs.length, 1)
})

test('createDashboardState：日志环 + 过滤 + 上限', () => {
  const d = createDashboardState()
  d.applyHarnessLog('stdout', 'dsh web: http://127.0.0.1:3080')
  assert.equal(d.logs.all.length, 0)
  for (let i = 0; i < 305; i++) d.applyHarnessLog('stdout', `line-${i}`)
  assert.equal(d.logs.all.length, 300)
  assert.equal(d.logs.all[0].text, 'line-5')
  assert.equal(d.logs.all[299].text, 'line-304')
  const err = d.applyHarnessLog('stderr', 'boom')
  assert.equal(err?.stream, 'stderr')
})

test('createDashboardState：桥接离线 → source=dom', () => {
  const d = createDashboardState()
  d.setBridge(false)
  d.applyHarnessState('ready')
  assert.equal(d.toSnapshot().source, 'dom')
  d.setBridge(true)
  assert.equal(d.toSnapshot().source, 'bridge')
})

test('clampSize 夹紧', () => {
  assert.equal(clampSize(100, 240, 420), 240)
  assert.equal(clampSize(500, 240, 420), 420)
  assert.equal(clampSize(300, 240, 420), 300)
})
