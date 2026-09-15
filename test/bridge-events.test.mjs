import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_DISCOVERY_PREFIX,
  BRIDGE_PROTOCOL_VERSION,
  approvalsFromSnapshot,
  diagOf,
  handleBridgeEvent,
  handleBridgeSnapshot,
  latestApproval,
  parseBridgeDiscovery,
  recentSessions,
  redactBridgeLine,
  runningJobCount,
  sessionIndexFrom,
  sessionLabel,
  withApproval,
  withoutApproval,
  RUNNING_STATUSES,
} from '../src/main/bridgeEvents.ts'
import { BRIDGE_PROTOCOL_VERSION as PLUGIN_PROTOCOL_VERSION } from '../packages/bridge/lib/index.js'

test('发现行前缀与协议版本：壳/插件跨进程契约必须一致', () => {
  assert.equal(BRIDGE_DISCOVERY_PREFIX, 'dsh desktop: ')
  assert.equal(BRIDGE_PROTOCOL_VERSION, PLUGIN_PROTOCOL_VERSION, '握手协议版本两端必须同值')
  assert.equal(Number.isInteger(BRIDGE_PROTOCOL_VERSION), true)
})

test('runningJobCount 只统计非终态任务', () => {
  const jobs = [
    { id: 'bash-1', status: 'running' },
    { id: 'bash-2', status: 'starting' },
    { id: 'bash-3', status: 'stopping' },
    { id: 'bash-4', status: 'done' },
    { id: 'bash-5', status: 'failed' },
    null,
    'junk',
    { id: 'bash-6' },
  ]
  assert.equal(runningJobCount(jobs), 3)
})

test('RUNNING_STATUSES 集合语义', () => {
  assert.ok(RUNNING_STATUSES.has('running'))
  assert.ok(!RUNNING_STATUSES.has('done'))
})

test('job.done 在开启通知时弹通知，关闭时静默', () => {
  const calls = []
  const effects = {
    notify: (title, body) => calls.push(`${title}|${body}`),
    setBadge: () => {},
  }
  handleBridgeEvent('job.done', { job: { id: 'bash-9', label: 'run tests' } }, { notifications: true }, effects)
  assert.deepEqual(calls, ['后台任务完成|任务 bash-9「run tests」已结束'])

  calls.length = 0
  handleBridgeEvent('job.done', { job: { id: 'bash-9' } }, { notifications: false }, effects)
  assert.deepEqual(calls, [])
})

test('jobs.changed 更新徽标', () => {
  let badge = -1
  const effects = { notify: () => {}, setBadge: (n) => (badge = n) }
  handleBridgeEvent(
    'jobs.changed',
    { jobs: [{ id: 'a', status: 'running' }, { id: 'b', status: 'done' }] },
    { notifications: true },
    effects,
  )
  assert.equal(badge, 1)
  handleBridgeEvent('jobs.changed', { jobs: [] }, { notifications: true }, effects)
  assert.equal(badge, 0)
})

test('approval.asked 弹通知', () => {
  const calls = []
  const effects = { notify: (t, b) => calls.push(`${t}|${b}`), setBadge: () => {} }
  handleBridgeEvent('approval.asked', { sessionId: 's-1' }, { notifications: true }, effects)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /需要审批/)
})

test('approval.asked 带 toolName 时通知里点名工具', () => {
  const calls = []
  const effects = { notify: (t, b) => calls.push(`${t}|${b}`), setBadge: () => {} }
  handleBridgeEvent('approval.asked', { sessionId: 's-1', requestId: 'a1', toolName: 'bash' }, { notifications: true }, effects)
  assert.deepEqual(calls, ['需要审批|会话 s-1（bash） 请求审批一个操作'])
})

test('parseBridgeDiscovery：合法发现行解析出 port/token', () => {
  assert.deepEqual(parseBridgeDiscovery('dsh desktop: {"port":51234,"token":"' + 'a'.repeat(32) + '"}'), {
    port: 51234,
    token: 'a'.repeat(32),
  })
})

test('parseBridgeDiscovery：非法发现行一律拒绝（含空/短 token）', () => {
  const token = 'a'.repeat(32)
  const bad = [
    '',
    'not a discovery line',
    // 历史 overlay 模型没有 config 注入点时会宣告空 token —— 等于不鉴权，必须拒绝
    'dsh desktop: {"port":51234,"token":""}',
    `dsh desktop: {"port":51234,"token":"short"}`,
    `dsh desktop: {"port":0,"token":"${token}"}`,
    `dsh desktop: {"port":-1,"token":"${token}"}`,
    `dsh desktop: {"port":70000,"token":"${token}"}`,
    `dsh desktop: {"port":"abc","token":"${token}"}`,
    'dsh desktop: {broken json',
    'dsh desktop: {"token":"' + token + '"}',
  ]
  for (const line of bad) assert.equal(parseBridgeDiscovery(line), null, `应拒绝: ${line}`)
})

test('redactBridgeLine：发现行只留端口，其余行原样透传', () => {
  const token = 'f'.repeat(32)
  const redacted = redactBridgeLine(`dsh desktop: {"port":51234,"token":"${token}"}`)
  assert.equal(redacted.includes(token), false)
  assert.match(redacted, /<redacted>/)
  assert.match(redacted, /51234/)
  // 非发现行（host 的诊断输出）不动
  assert.equal(redactBridgeLine('[host] 普通日志'), '[host] 普通日志')
})

test('未知事件不产生副作用', () => {
  let touched = false
  const effects = {
    notify: () => (touched = true),
    setBadge: () => (touched = true),
  }
  handleBridgeEvent('something.else', {}, { notifications: true }, effects)
  assert.equal(touched, false)
})

test('畸形 payload 不抛错', () => {
  const effects = { notify: () => {}, setBadge: () => {} }
  assert.doesNotThrow(() => handleBridgeEvent('job.done', null, { notifications: true }, effects))
  assert.doesNotThrow(() => handleBridgeEvent('jobs.changed', 'junk', { notifications: true }, effects))
  assert.doesNotThrow(() => handleBridgeEvent('approval.asked', undefined, { notifications: true }, effects))
})

/* ── 会话目录 / 待审批环 / 诊断（批次 2、3） ─────────────────────────── */

test('sessionIndexFrom：快照与增量同形状（全量替换，忽略非法条目）', () => {
  const index = sessionIndexFrom({
    sessions: [
      { id: 's1', title: '一', live: true, createdAt: 200 },
      { id: 'p1', title: null, live: false, createdAt: 100 },
      { id: '', title: 'x' },
      null,
      'junk',
      { id: 's2', title: '二' },
    ],
  })
  assert.equal(index.size, 3)
  assert.deepEqual(index.get('s2'), { id: 's2', title: '二', live: false, createdAt: null })
  assert.deepEqual(sessionIndexFrom(undefined).size, 0)
})

test('recentSessions：按 createdAt 新→旧，无时间排最后，可截断', () => {
  const index = sessionIndexFrom({
    sessions: [
      { id: 'old', createdAt: 100 },
      { id: 'new', createdAt: 300 },
      { id: 'notime' },
      { id: 'mid', createdAt: 200 },
    ],
  })
  assert.deepEqual(recentSessions(index, 3).map((s) => s.id), ['new', 'mid', 'old'])
  assert.deepEqual(recentSessions(index, 10).map((s) => s.id), ['new', 'mid', 'old', 'notime'])
  assert.deepEqual(recentSessions(index, 0), [])
})

test('sessionLabel：有标题用标题，无标题退回 id 前缀', () => {
  assert.equal(sessionLabel({ id: 'abcdefgh-1234', title: '标题', live: true, createdAt: 1 }, 'abcdefgh-1234'), '标题')
  assert.equal(sessionLabel(undefined, 'abcdefgh-1234'), 'abcdefgh…')
  assert.equal(sessionLabel(undefined, 'short'), 'short')
})

test('待审批环：asked 入、decided 出，requestId 优先做键', () => {
  let index = withApproval(new Map(), { sessionId: 's1', requestId: 'a1', toolName: 'bash' })
  index = withApproval(index, { sessionId: 's1', requestId: 'a2', toolName: 'pwsh' })
  assert.equal(index.size, 2, '同一会话可以有多条审批排队')
  assert.equal(latestApproval(index)?.requestId, 'a2')
  index = withoutApproval(index, { sessionId: 's1', requestId: 'a1' })
  assert.deepEqual([...index.keys()], ['a2'])
  // 无 requestId 时退化到 sessionId 做键
  let legacy = withApproval(new Map(), { sessionId: 's9', requestId: null, toolName: null })
  assert.deepEqual([...legacy.keys()], ['s9'])
  legacy = withoutApproval(legacy, { sessionId: 's9', requestId: null })
  assert.equal(legacy.size, 0)
  // 非法 payload 不改动环（同一引用）
  assert.equal(withApproval(index, null).size, index.size)
  assert.equal(withoutApproval(index, 'junk').size, index.size)
})

test('approvalsFromSnapshot：快照里的待审批环整份重建', () => {
  const index = approvalsFromSnapshot({ approvals: [{ sessionId: 's1', requestId: 'a1', toolName: 'bash' }, null, { foo: 1 }] })
  assert.deepEqual([...index.keys()], ['a1'])
  assert.equal(approvalsFromSnapshot(undefined).size, 0)
})

test('approval.asked 通知点击直达会话（onClick → openSession）', () => {
  const opened = []
  const notified = []
  handleBridgeEvent(
    'approval.asked',
    { sessionId: 's-7', requestId: 'a1', toolName: 'bash' },
    { notifications: true },
    {
      notify: (title, body, onClick) => notified.push({ title, body, onClick }),
      setBadge: () => {},
      openSession: (id) => opened.push(id),
    },
  )
  assert.equal(notified.length, 1)
  assert.equal(typeof notified[0].onClick, 'function')
  notified[0].onClick()
  assert.deepEqual(opened, ['s-7'])

  // 没有 openSession 副作用时不崩（且仍发通知）
  handleBridgeEvent(
    'approval.asked',
    { sessionId: 's-7' },
    { notifications: true },
    { notify: () => {}, setBadge: () => {} },
  )
})

test('bridge.diag：解析并透传给 effects.diag（非法 payload 忽略）', () => {
  const seen = []
  const effects = { notify: () => {}, setBadge: () => {}, diag: (d) => seen.push(d) }
  handleBridgeEvent('bridge.diag', { level: 'warn', code: 'jobs.absent', detail: { hint: 'x' } }, { notifications: true }, effects)
  handleBridgeEvent('bridge.diag', { level: 'bogus', code: 'ws.server.error' }, { notifications: true }, effects)
  handleBridgeEvent('bridge.diag', { level: 'info' }, { notifications: true }, effects)
  handleBridgeEvent('bridge.diag', 'junk', { notifications: true }, effects)
  assert.deepEqual(seen, [
    { level: 'warn', code: 'jobs.absent', detail: { hint: 'x' } },
    { level: 'info', code: 'ws.server.error', detail: {} },
  ])
  assert.equal(diagOf(null), null)
  assert.equal(diagOf({ code: '' }), null)
})

test('handleBridgeSnapshot：一次对齐徽标 + 会话目录 + 待审批环', () => {
  let badge = -1
  const state = handleBridgeSnapshot(
    {
      jobs: [
        { id: 'a', status: 'running' },
        { id: 'b', status: 'done' },
      ],
      sessions: [{ id: 's1', title: '一', live: true, createdAt: 5 }],
      approvals: [{ sessionId: 's1', requestId: 'a1', toolName: 'bash' }],
    },
    { setBadge: (n) => (badge = n) },
  )
  assert.deepEqual({ running: state.running, badge, sessions: state.sessions.size, approvals: state.approvals.size }, {
    running: 1,
    badge: 1,
    sessions: 1,
    approvals: 1,
  })
  // 快照缺失 → 全部清空（宁可清零也不留旧 harness 的状态）
  const empty = handleBridgeSnapshot(undefined, { setBadge: (n) => (badge = n) })
  assert.deepEqual({ running: empty.running, badge, sessions: empty.sessions.size, approvals: empty.approvals.size }, {
    running: 0,
    badge: 0,
    sessions: 0,
    approvals: 0,
  })
})

test('approval.decided / sessions.changed 不产生通知（只是状态同步）', () => {
  let notified = 0
  let touched = 0
  const effects = { notify: () => (notified += 1), setBadge: () => (touched += 1) }
  handleBridgeEvent('approval.decided', { sessionId: 's1', requestId: 'a1' }, { notifications: true }, effects)
  handleBridgeEvent('sessions.changed', { sessions: [] }, { notifications: true }, effects)
  assert.equal(notified, 0)
  assert.equal(touched, 0)
})
