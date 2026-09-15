import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_PROTOCOL_VERSION,
  apply,
  approvalEventOf,
  uniqueJobs,
  tokenMatches,
} from '../packages/bridge/lib/index.js'
import { WebSocket } from '../packages/bridge/vendor/ws/wrapper.mjs'

/**
 * dsh-desktop-bridge 插件契约测试（进程内起真插件 + 真 vendored ws 客户端）。
 *
 * 这里不 mock 插件本身：`apply()` 会在随机端口起真实的 WS 服务、打印真实发现行，
 * 测试用插件自带的 ws 客户端走完整握手/RPC/推送链路。宿主（harness）侧只提供
 * 最小 stub——契约面是「壳 ↔ 插件」，不是「插件 ↔ dsh 内核」。
 *
 * 覆盖的回归点（均为曾经出过或极易出错的形状）：
 *  - 发现行必须在 WS **监听就绪后**打印（address() 在 listening 前是 null）；
 *  - `session/event` 的宿主签名是 `(session, event)`，不是 `(event)`；
 *  - `jobs.list(caller)` 会把无主任务投给每个 caller，逐会话聚合必须去重；
 *  - 鉴权失败/超时必须断开；dispose 必须先广播再关连接。
 */

/** 假 ctx：只实现插件用到的最小面（get / on / 事件触发 / dispose）。 */
function fakeCtx(services = {}) {
  const listeners = new Map()
  return {
    services,
    get: (name) => services[name],
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
    },
    dispose() {
      for (const fn of [...(listeners.get('dispose') ?? [])]) fn()
    },
    hasListener(event, fn) {
      return (listeners.get(event) ?? []).includes(fn)
    },
  }
}

/** 捕获 console.log（插件的发现行/诊断日志都走 stdout）。 */
function captureStdout() {
  const lines = []
  const orig = console.log
  console.log = (...args) => lines.push(args.map(String).join(' '))
  return { lines, restore: () => { console.log = orig } }
}

const DISCOVERY_PREFIX = 'dsh desktop: '

/** 轮询等待（发现行/推送都是异步到达的；不引入事件唤醒以免漏点）。 */
async function waitFor(pred, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = pred()
    if (hit) return hit
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** 起一个插件实例：返回发现行目标与停靠句柄。 */
async function startBridge({ services = {}, config = {} } = {}) {
  const ctx = fakeCtx(services)
  const stdout = captureStdout()
  try {
    apply(ctx, config)
    const line = await waitFor(() => stdout.lines.find((l) => l.startsWith(DISCOVERY_PREFIX)), '发现行')
    return { ctx, stdout, target: JSON.parse(line.slice(DISCOVERY_PREFIX.length)) }
  } catch (err) {
    stdout.restore()
    throw err
  }
}

/** 连接 WS（不上鉴权），返回消息收集器。 */
function openClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => {
    try {
      messages.push(JSON.parse(String(data)))
    } catch {
      messages.push({ type: '<invalid>' })
    }
  })
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason ?? '') })))
  const open = new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  return { ws, messages, open, closed }
}

/** 发一条 call 并等它的 result（按 id 匹配，忽略中途推送）。 */
async function rpc(ws, messages, id, method, params) {
  ws.send(JSON.stringify({ type: 'call', id, method, params }))
  return waitFor(() => messages.find((m) => m.type === 'result' && m.id === id), `RPC ${method}`)
}

/** 一组足够真实的宿主服务 stub（形状对齐 dsh 0.1.5-rc.2）。 */
function harnessStub({ sessionIds = ['s1'], jobs = undefined, loader = { await: () => Promise.resolve() } } = {}) {
  const liveSessions = () =>
    sessionIds.map((id) => ({
      id,
      header: { createdAt: 111 },
      snapshotEvents: () => [{ type: 'session/title', data: { title: `标题-${id}` } }],
    }))
  return {
    sessions: {
      list: liveSessions,
      get: (id) => liveSessions().find((s) => s.id === id),
    },
    agents: { get: (id) => ({ id }) },
    jobs,
    sessionPersistence: {
      list: async () => [{ header: { id: 'persisted-1', createdAt: 222 }, revision: 1, sizeBytes: 10 }],
      open: async (id) => ({
        header: { id, createdAt: 222 },
        read: async () => ({ eventState: 'ok', events: [{ type: 'session/title', data: { title: '旧会话' } }] }),
        close: async () => {},
      }),
    },
    workspaceRegistry: {
      list: () => [{ id: 'w1', title: '工作区' }],
      create: async (path) => ({ id: 'w-created', path }),
    },
    loader,
  }
}

/** jobs 服务 stub：复刻官方可见集语义（无主任务投给每个 caller）。 */
function jobsStub() {
  const changed = []
  const done = []
  const shared = { id: 'bg-shared', kind: 'bash', label: '共享任务', status: 'running' }
  return {
    service: {
      list: (caller) =>
        caller === undefined
          ? [shared]
          : [shared, { id: `job-${caller.id}`, kind: 'bash', label: `自有-${caller.id}`, status: 'running', ownerSession: caller.id }],
      onJobsChanged: (fn) => {
        changed.push(fn)
        return () => {}
      },
      onJobDone: (fn) => {
        done.push(fn)
        return () => {}
      },
    },
    fireChanged: () => changed.forEach((fn) => fn()),
    fireDone: (record) => done.forEach((fn) => fn(record)),
    registered: () => changed.length,
  }
}

/* ── 纯函数 ─────────────────────────────────────────────────────────── */

test('approvalEventOf：兼容 (session, event) 与单事件两种宿主投递形状', () => {
  const session = { id: 's1' }
  const asked = { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: 'r' } }
  assert.deepEqual(approvalEventOf(session, asked), { kind: 'asked', sessionId: 's1', requestId: 'a1', toolName: 'bash' })
  // 旧/异形宿主：只投一个事件对象
  assert.deepEqual(approvalEventOf(asked), { kind: 'asked', sessionId: null, requestId: 'a1', toolName: 'bash' })
  // decided 也归一化（审批已处理 → 壳清提醒）
  assert.deepEqual(approvalEventOf(session, { type: 'approval/decided', data: { id: 'a1', outcome: 'approved' } }), {
    kind: 'decided',
    sessionId: 's1',
    requestId: 'a1',
    toolName: null,
  })
  // 非审批事件 / 缺字段 / 垃圾输入都不该被当成审批
  assert.equal(approvalEventOf(session, { type: 'session/title', data: { title: 'x' } }), null)
  assert.equal(approvalEventOf(session, undefined), null)
  assert.equal(approvalEventOf(null, null), null)
  assert.equal(approvalEventOf('junk', 42), null)
  assert.deepEqual(approvalEventOf(session, { type: 'approval/asked' }), {
    kind: 'asked',
    sessionId: 's1',
    requestId: null,
    toolName: null,
  })
})

test('uniqueJobs：按 id 去重并丢弃无 id 的条目', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }
  assert.deepEqual(uniqueJobs([a, b, a, { noId: true }, null, 'junk']), [a, b])
  assert.deepEqual(uniqueJobs(null), [])
})

test('tokenMatches：常量时间比较，空/短/不等长一律不通过', () => {
  assert.equal(tokenMatches('a'.repeat(64), 'a'.repeat(64)), true)
  assert.equal(tokenMatches('a'.repeat(64), 'b'.repeat(64)), false)
  assert.equal(tokenMatches('a'.repeat(63), 'a'.repeat(64)), false)
  assert.equal(tokenMatches('', ''), false)
  assert.equal(tokenMatches(undefined, 'a'.repeat(64)), false)
  assert.equal(tokenMatches({}, 'a'.repeat(64)), false)
})

/* ── 发现行 ─────────────────────────────────────────────────────────── */

test('发现行：无 loader 服务时也要等监听就绪再打印，且只打印一次', async () => {
  // 旧实现没有 loader 就在 apply 里同步 print()：那时 address() 还是 null → 永不宣告
  const { ctx, target, stdout } = await startBridge({ services: harnessStub({ jobs: jobsStub().service, loader: undefined }) })
  try {
    assert.equal(Number.isInteger(target.port) && target.port > 0, true, `非法端口: ${String(target.port)}`)
    assert.match(target.token, /^[0-9a-f]{32}$/)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(stdout.lines.filter((l) => l.startsWith(DISCOVERY_PREFIX)).length, 1, '发现行必须恰好一行')
  } finally {
    ctx.dispose()
    stdout.restore()
  }
})

test('发现行：config.token 缺省时自生成随机 token（bundle 模型无 config 注入点）', async () => {
  const services = harnessStub()
  const { ctx, target, stdout } = await startBridge({ services })
  try {
    const { ctx: ctx2, target: target2, stdout: stdout2 } = await startBridge({ services })
    try {
      assert.notEqual(target.token, target2.token, '两次启动的 token 不得相同')
    } finally {
      ctx2.dispose()
      stdout2.restore()
    }
    assert.match(target.token, /^[0-9a-f]{32}$/)
  } finally {
    ctx.dispose()
    stdout.restore()
  }
})

test('发现行：loader 安定失败时也要宣告（桥接通道与加载树无关，降级也要能连）', async () => {
  const services = harnessStub({ loader: { await: () => Promise.reject(new Error('tree broken')) } })
  const { ctx, target, stdout } = await startBridge({ services })
  try {
    assert.equal(Number.isInteger(target.port) && target.port > 0, true)
    assert.ok(
      stdout.lines.some((l) => l.includes('loader.rejected') && l.includes('tree broken')),
      '安定失败必须留下可诊断的日志',
    )
  } finally {
    ctx.dispose()
    stdout.restore()
  }
})

/* ── 鉴权 ───────────────────────────────────────────────────────────── */

test('鉴权：错误 token 被 4001 关闭，正确 token 收到 authed', async () => {
  const { ctx, target, stdout } = await startBridge({ services: harnessStub() })
  const bad = openClient(target.port)
  try {
    await bad.open
    bad.ws.send(JSON.stringify({ type: 'auth', token: 'f'.repeat(64) }))
    const closed = await bad.closed
    assert.equal(closed.code, 4001)

    const good = openClient(target.port)
    await good.open
    good.ws.send(JSON.stringify({ type: 'auth', token: target.token }))
    const authed = await waitFor(() => good.messages.find((m) => m.type === 'authed'), 'authed')
    assert.equal(typeof authed.payload.pid, 'number')
    good.ws.close()
  } finally {
    ctx.dispose()
    stdout.restore()
  }
})

test('鉴权：未在 authTimeoutMs 内鉴权的连接被 4002 关闭', async () => {
  const { ctx, target, stdout } = await startBridge({ services: harnessStub(), config: { authTimeoutMs: 60 } })
  const idle = openClient(target.port)
  try {
    await idle.open
    const closed = await idle.closed
    assert.equal(closed.code, 4002)
  } finally {
    ctx.dispose()
    stdout.restore()
  }
})

/* ── RPC ────────────────────────────────────────────────────────────── */

test('RPC：runtime.info / sessions.list / session.resolve（live + 持久化）/ dashboard.snapshot / workspace.register', async () => {
  const jobs = jobsStub()
  const { ctx, target, stdout } = await startBridge({ services: harnessStub({ jobs: jobs.service }) })
  const client = openClient(target.port)
  try {
    await client.open
    client.ws.send(JSON.stringify({ type: 'auth', token: target.token }))
    await waitFor(() => client.messages.find((m) => m.type === 'authed'), 'authed')

    const ping = await rpc(client.ws, client.messages, 1, 'ping')
    assert.deepEqual(ping.result.pong, true)

    const info = await rpc(client.ws, client.messages, 2, 'runtime.info')
    assert.equal(info.result.pid, process.pid)
    assert.deepEqual(info.result.workspaces, [{ id: 'w1', title: '工作区' }])

    const list = await rpc(client.ws, client.messages, 3, 'sessions.list')
    assert.deepEqual(
      list.result.sessions.map((s) => [s.id, s.live, s.title]),
      [
        ['s1', true, '标题-s1'],
        ['persisted-1', false, null],
      ],
    )

    const live = await rpc(client.ws, client.messages, 4, 'session.resolve', { id: 's1' })
    assert.deepEqual(live.result, { id: 's1', live: true, title: '标题-s1', createdAt: 111 })

    const stored = await rpc(client.ws, client.messages, 5, 'session.resolve', { id: 'persisted-1' })
    assert.deepEqual(stored.result, { id: 'persisted-1', live: false, title: '旧会话', createdAt: 222 })

    const missing = await rpc(client.ws, client.messages, 6, 'session.resolve', {})
    assert.match(String(missing.error), /missing params\.id/)

    const snapshot = await rpc(client.ws, client.messages, 7, 'dashboard.snapshot')
    assert.equal(snapshot.result.sessions.length, 2)
    assert.deepEqual(snapshot.result.jobs.map((j) => j.id).sort(), ['bg-shared', 'job-s1'])
    assert.deepEqual(snapshot.result.approvals, [])

    const registered = await rpc(client.ws, client.messages, 8, 'workspace.register', { path: 'E:/ws/demo' })
    assert.deepEqual(registered.result, { id: 'w-created', ok: true })

    const unknown = await rpc(client.ws, client.messages, 9, 'nope.method')
    assert.match(String(unknown.error), /unknown method/)
  } finally {
    client.ws.close()
    ctx.dispose()
    stdout.restore()
  }
})

/* ── 事件推送 ───────────────────────────────────────────────────────── */

test('approval.asked / approval.decided：推送形状 + 待审批环出入环', async () => {
  const services = harnessStub({ jobs: undefined })
  const { ctx, target, stdout } = await startBridge({ services })
  const client = openClient(target.port)
  try {
    await client.open
    client.ws.send(JSON.stringify({ type: 'auth', token: target.token, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
    await waitFor(() => client.messages.find((m) => m.type === 'authed'), 'authed')

    // 宿主真实投递形状：callbackArgs = [session, event]
    ctx.emit('session/event', { id: 's1' }, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
    const pushed = await waitFor(() => client.messages.find((m) => m.type === 'approval.asked'), 'approval.asked')
    assert.deepEqual(pushed.payload, { kind: 'asked', sessionId: 's1', requestId: 'a1', toolName: 'bash' })

    // 非审批事件不得推送
    ctx.emit('session/event', { id: 's1' }, { type: 'session/title', data: { title: 'x' } })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(client.messages.filter((m) => m.type === 'approval.asked').length, 1)

    // 审批进入快照环（dashboard.snapshot 的 approvals）
    const before = await rpc(client.ws, client.messages, 11, 'dashboard.snapshot')
    assert.equal(before.result.approvals.length, 1)
    assert.equal(before.result.approvals[0].toolName, 'bash')

    // 已决定 → 出环 + 推送 approval.decided
    ctx.emit('session/event', { id: 's1' }, { type: 'approval/decided', data: { id: 'a1', outcome: 'approved' } })
    const decided = await waitFor(() => client.messages.find((m) => m.type === 'approval.decided'), 'approval.decided')
    assert.equal(decided.payload.kind, 'decided')
    assert.equal(decided.payload.requestId, 'a1')
    const after = await rpc(client.ws, client.messages, 12, 'dashboard.snapshot')
    assert.deepEqual(after.result.approvals, [])
  } finally {
    client.ws.close()
    ctx.dispose()
    stdout.restore()
  }
})

test('jobs：逐会话聚合无主任务时去重，jobs.changed / job.done 正常推送', async () => {
  const jobs = jobsStub()
  const { ctx, target, stdout } = await startBridge({
    services: harnessStub({ sessionIds: ['s1', 's2'], jobs: jobs.service }),
  })
  const client = openClient(target.port)
  try {
    await client.open
    client.ws.send(JSON.stringify({ type: 'auth', token: target.token }))
    await waitFor(() => client.messages.find((m) => m.type === 'authed'), 'authed')

    // jobs 接线发生在 Loader 安定后（apply 阶段服务可能尚未就绪）
    await waitFor(() => jobs.registered() === 1, 'onJobsChanged 注册')

    jobs.fireChanged()
    const changed = await waitFor(() => client.messages.find((m) => m.type === 'jobs.changed'), 'jobs.changed')
    const ids = changed.payload.jobs.map((j) => j.id)
    // 未去重时：bg-shared 出现在 s1、s2 与无 caller 三次
    assert.deepEqual(ids, ['bg-shared', 'job-s1', 'job-s2'])
    assert.deepEqual(changed.payload.jobs[1], {
      id: 'job-s1',
      kind: 'bash',
      label: '自有-s1',
      status: 'running',
      owner: 's1',
    })

    jobs.fireDone({ id: 'bg-shared', kind: 'bash', label: '共享任务', status: 'done', ownerSession: undefined })
    const donePush = await waitFor(() => client.messages.find((m) => m.type === 'job.done'), 'job.done')
    assert.equal(donePush.payload.job.id, 'bg-shared')
    assert.equal(donePush.payload.job.status, 'done')
  } finally {
    client.ws.close()
    ctx.dispose()
    stdout.restore()
  }
})

test('dispose：先广播空任务集再关闭连接（壳据此复位徽标）', async () => {
  const jobs = jobsStub()
  const { ctx, target, stdout } = await startBridge({ services: harnessStub({ jobs: jobs.service }) })
  const client = openClient(target.port)
  try {
    await client.open
    client.ws.send(JSON.stringify({ type: 'auth', token: target.token }))
    await waitFor(() => client.messages.find((m) => m.type === 'authed'), 'authed')

    ctx.dispose()
    const emptied = await waitFor(
      () => client.messages.find((m) => m.type === 'jobs.changed' && m.payload.jobs.length === 0),
      '空的 jobs.changed',
    )
    assert.deepEqual(emptied.payload.jobs, [])
    const closed = await client.closed
    assert.equal(closed.code, 1001)
  } finally {
    client.ws.close()
    stdout.restore()
  }
})

test('dispose 之后才安定：不得再宣告发现行（否则壳会照它连一个已关闭的端口）', async () => {
  let settle = null
  const loader = {
    await: () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  }
  const ctx = fakeCtx(harnessStub({ loader }))
  const stdout = captureStdout()
  try {
    apply(ctx, {})
    ctx.dispose()
    settle() // 卸载后才「安定」（dev 的 HMR 重载即此形状）
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(stdout.lines.filter((l) => l.startsWith(DISCOVERY_PREFIX)).length, 0)
  } finally {
    stdout.restore()
  }
})

/* ── 握手协议版本 + 诊断通道 ─────────────────────────────────────────── */

test('authed：回带协议版本与最新诊断（壳据此判断同代 + 显示桥接状态）', async () => {
  const jobs = jobsStub()
  const { ctx, target, stdout } = await startBridge({ services: harnessStub({ jobs: jobs.service }) })
  const client = openClient(target.port)
  try {
    await client.open
    client.ws.send(JSON.stringify({ type: 'auth', token: target.token, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
    const authed = await waitFor(() => client.messages.find((m) => m.type === 'authed'), 'authed')
    assert.equal(authed.payload.protocolVersion, BRIDGE_PROTOCOL_VERSION)
    assert.equal(typeof authed.payload.pid, 'number')
    // jobs 已接线（wireJobs 在宣告前跑）→ 最新诊断是 jobs.present
    assert.equal(authed.payload.diag.code, 'jobs.present')
  } finally {
    client.ws.close()
    ctx.dispose()
    stdout.restore()
  }
})

test('protocol.mismatch：壳带别的协议版本时插件广播告警（但仍工作）', async () => {
  const { ctx, target, stdout } = await startBridge({ services: harnessStub() })
  const client = openClient(target.port)
  try {
    await client.open
    client.ws.send(JSON.stringify({ type: 'auth', token: target.token, protocolVersion: 999 }))
    await waitFor(() => client.messages.find((m) => m.type === 'authed'), 'authed')
    const warn = await waitFor(
      () => client.messages.find((m) => m.type === 'bridge.diag' && m.payload.code === 'protocol.mismatch'),
      'protocol.mismatch',
    )
    assert.equal(warn.payload.level, 'warn')
    assert.deepEqual(warn.payload.detail, { shell: 999, bridge: BRIDGE_PROTOCOL_VERSION })
    // 降级不是拒绝：RPC 仍然可用
    const pong = await rpc(client.ws, client.messages, 31, 'ping')
    assert.equal(pong.result.pong, true)
  } finally {
    client.ws.close()
    ctx.dispose()
    stdout.restore()
  }
})

test('bridge.diag：jobs 服务缺失时广播 jobs.absent，并被壳读到', async () => {
  const { ctx, target, stdout } = await startBridge({ services: harnessStub({ jobs: undefined }) })
  const client = openClient(target.port)
  try {
    await client.open
    client.ws.send(JSON.stringify({ type: 'auth', token: target.token, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
    const authed = await waitFor(() => client.messages.find((m) => m.type === 'authed'), 'authed')
    assert.equal(authed.payload.diag.code, 'jobs.absent')
    assert.equal(authed.payload.diag.level, 'warn')
  } finally {
    client.ws.close()
    ctx.dispose()
    stdout.restore()
  }
})

test('bridge.diag：坏 token 被拒时广播 auth.rejected（本机有进程在探测端口）', async () => {
  const { ctx, target, stdout } = await startBridge({ services: harnessStub() })
  const good = openClient(target.port)
  const bad = openClient(target.port)
  try {
    await good.open
    good.ws.send(JSON.stringify({ type: 'auth', token: target.token, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
    await waitFor(() => good.messages.find((m) => m.type === 'authed'), 'authed')

    await bad.open
    bad.ws.send(JSON.stringify({ type: 'auth', token: 'e'.repeat(32) }))
    await bad.closed

    const warn = await waitFor(
      () => good.messages.find((m) => m.type === 'bridge.diag' && m.payload.code === 'auth.rejected'),
      'auth.rejected',
    )
    assert.equal(warn.payload.detail.count, 1)
  } finally {
    good.ws.close()
    ctx.dispose()
    stdout.restore()
  }
})

/* ── 会话目录增量推送 ───────────────────────────────────────────────── */

test('sessions.changed：会话新建/结束/改名后去抖推送合并目录', async () => {
  const { ctx, target, stdout } = await startBridge({ services: harnessStub({ sessionIds: ['s1'] }) })
  const client = openClient(target.port)
  try {
    await client.open
    client.ws.send(JSON.stringify({ type: 'auth', token: target.token, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
    await waitFor(() => client.messages.find((m) => m.type === 'authed'), 'authed')

    // 宿主会为每个新会话投递 (session) 单参
    ctx.emit('session/created', { id: 's1' })
    ctx.emit('session/event', { id: 's1' }, { type: 'session/title', data: { title: '标题-s1' } })
    ctx.emit('session/disposed', { id: 's1' })
    await new Promise((r) => setTimeout(r, 50))
    // 去抖：三条事件只应触发一次推送
    assert.equal(client.messages.filter((m) => m.type === 'sessions.changed').length, 0, '去抖窗口内不推送')

    const pushed = await waitFor(() => client.messages.find((m) => m.type === 'sessions.changed'), 'sessions.changed')
    assert.deepEqual(
      pushed.payload.sessions.map((s) => [s.id, s.live, s.title]),
      [
        ['s1', true, '标题-s1'],
        ['persisted-1', false, null],
      ],
    )
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(client.messages.filter((m) => m.type === 'sessions.changed').length, 1, '合并成一次推送')
  } finally {
    client.ws.close()
    ctx.dispose()
    stdout.restore()
  }
})

test('宿主服务缺失：RPC 报错而不是把插件打挂', async () => {
  // 全空宿主：任何 ctx.get 都返回 undefined
  const { ctx, target, stdout } = await startBridge({ services: {} })
  const client = openClient(target.port)
  try {
    await client.open
    client.ws.send(JSON.stringify({ type: 'auth', token: target.token }))
    await waitFor(() => client.messages.find((m) => m.type === 'authed'), 'authed')

    const info = await rpc(client.ws, client.messages, 21, 'runtime.info')
    assert.deepEqual(info.result.workspaces, [])
    const list = await rpc(client.ws, client.messages, 22, 'sessions.list')
    assert.deepEqual(list.result.sessions, [])
    // jobs/sessions/agents 全缺时快照必须降级为空，而不是抛错（曾经 out.push(...undefined) 打挂 RPC）
    const snapshot = await rpc(client.ws, client.messages, 23, 'dashboard.snapshot')
    assert.deepEqual(snapshot.result.jobs, [])
    assert.deepEqual(snapshot.result.sessions, [])
    const reg = await rpc(client.ws, client.messages, 24, 'workspace.register', { path: 'E:/x' })
    assert.match(String(reg.error), /workspaceRegistry service unavailable/)
    const balance = await rpc(client.ws, client.messages, 25, 'billing.balance')
    assert.match(String(balance.error), /credentials service unavailable/)
  } finally {
    client.ws.close()
    ctx.dispose()
    stdout.restore()
  }
})

test('sessions.changed：目录超过上限时截断（live 全留 + 最近持久化，带 truncated 标记）', async () => {
  const persisted = async () => {
    const rows = []
    for (let i = 0; i < 260; i += 1) rows.push({ header: { id: `p-${i}`, createdAt: 1000 + i }, revision: 1, sizeBytes: 1 })
    return rows
  }
  const services = harnessStub({ sessionIds: ['live-1'] })
  services.sessionPersistence.list = persisted
  const { ctx, target, stdout } = await startBridge({ services })
  const client = openClient(target.port)
  try {
    await client.open
    client.ws.send(JSON.stringify({ type: 'auth', token: target.token, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
    await waitFor(() => client.messages.find((m) => m.type === 'authed'), 'authed')

    const snapshot = await rpc(client.ws, client.messages, 41, 'dashboard.snapshot')
    assert.equal(snapshot.result.truncated, true)
    assert.equal(snapshot.result.sessions.length, 200)
    // live 会话必须在（不管多老），其余按 createdAt 新→旧
    assert.equal(snapshot.result.sessions[0].id, 'live-1')
    assert.equal(snapshot.result.sessions[1].id, 'p-259')

    ctx.emit('session/event', { id: 'live-1' }, { type: 'session/title', data: { title: '改了标题' } })
    const pushed = await waitFor(() => client.messages.find((m) => m.type === 'sessions.changed'), 'sessions.changed')
    assert.equal(pushed.payload.truncated, true)
    assert.equal(pushed.payload.sessions.length, 200)
  } finally {
    client.ws.close()
    ctx.dispose()
    stdout.restore()
  }
})
