/**
 * E2E：随包运行时 ↔ 桌面壳契约测试（官方 Host 架构）。
 *
 * 每次升级随包 dsh 版本后跑一次，验证：
 *  1. 随包 Host（dsh-desktop-host）能在随包 Node 里引导 profile 并报 ready（协议 v3）；
 *  2. **字节管道**（fd3/fd4 + 13 字节帧头）能把 fetch 送到 Host 并把 Response 流回来，
 *     入口文档里带着 Host 注入的 `__DSH_TRANSPORT__`（远端流改走 NDJSON 的依据）；
 *  3. stdout 出现 bridge 的 `dsh desktop: {"port","token"}` 发现行，WS 鉴权 + 全部 RPC 可用；
 *  4. 对外门面（lanServer）把 HTTP 请求喂给同一条管道 fetch（局域网/浏览器版路径）。
 *
 * 这里不经过 Electron：直接按壳的 spawn 契约起 Host，帧编解码复用 src/main/hostProtocol.ts
 * （与壳生产代码同一份实现，等于同时验证了 shell 侧的协议移植）。
 *
 * 用法：node scripts/e2e-bridge.mjs [--sessions <dir>]
 *   --sessions <dir>  可选：把某目录下的真实会话复制进临时 DSH_HOME（测持久化读取路径）。
 * 环境：DSH_E2E_KEEP=1 保留临时目录（排障用）。
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 帧编解码复用壳的生产实现（同一份源码，Node 直接加载 TS）。
// 必须是**静态导入**：动态 import 会 await，期间若 Host 已发出 ready 的 IPC 消息，
// 监听器还没挂上 → 消息被丢弃（child_process 不做 IPC 缓冲），表现为「永远等不到 ready」。
import { BRIDGE_PROTOCOL_VERSION } from '../src/main/bridgeEvents.ts'
import {
  DesktopHostResponseDecoder,
  encodeDesktopRequestStart,
  encodeDesktopRequestData,
  encodeDesktopRequestEnd,
  encodeDesktopRequestCancel,
} from '../src/main/hostProtocol.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(root, 'resources', 'dsh')
const nodeExe = path.join(root, 'resources', 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const templateDir = path.join(root, 'resources', 'profile-template', 'dsh-workbench')
const hostEntry = path.join(runtimeDir, 'node_modules', 'dsh-desktop-host', 'lib', 'index.js')

const args = process.argv.slice(2)
const sessionsArgIdx = args.indexOf('--sessions')
const sessionsDir = sessionsArgIdx >= 0 ? args[sessionsArgIdx + 1] : null

for (const [label, p] of [['runtime node', nodeExe], ['Host 入口', hostEntry], ['profile 模板', templateDir]]) {
  if (!existsSync(p)) {
    console.error(`[e2e] 缺少 ${label}: ${p}（先跑 npm run setup:runtime）`)
    process.exit(2)
  }
}

/* ── 临时 DSH_HOME + profile（bundles + 共享包链接，等价 ensureProfile 的结果）── */

const home = path.join(os.tmpdir(), `dsh-e2e-host-${Date.now()}`)
const profileDir = path.join(home, 'profiles', 'dsh-workbench')
mkdirSync(profileDir, { recursive: true })
for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
  cpSync(path.join(templateDir, f), path.join(profileDir, f))
}
writeFileSync(
  path.join(profileDir, 'pnpm-workspace.yaml'),
  [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'strictDepBuilds: true',
    'allowBuilds:',
    '  node-pty: true',
    '  koffi: true',
    '  fs-ext: true',
    "  '@deepseek-ai/dsh-subprocess-local': true",
    '',
  ].join('\n'),
)
const profileModules = path.join(profileDir, 'node_modules')
mkdirSync(profileModules, { recursive: true })
// 三个共享包都要链接（含 @deepseek-ai/dsh 本身）：与运行时描述符的 sharedPackages 一致
for (const name of ['@deepseek-ai/dsh', 'dsh-desktop-bridge', 'dsh-desktop-host']) {
  const link = path.join(profileModules, name)
  mkdirSync(path.dirname(link), { recursive: true }) // scope 包需要先建 @scope 目录
  if (existsSync(link)) rmSync(link, { recursive: true, force: true })
  symlinkSync(path.join(runtimeDir, 'node_modules', name), link, process.platform === 'win32' ? 'junction' : 'dir')
}
const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
manifest.dsh = {
  profile: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-desktop-bridge'],
  },
}
writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
if (sessionsDir && existsSync(sessionsDir)) {
  cpSync(sessionsDir, path.join(home, 'sessions'), { recursive: true })
  console.log(`[e2e] 已复制会话目录: ${sessionsDir}`)
}

/* ── 按壳的 spawn 契约起 Host：fd3=请求管道、fd4=响应管道、fd5=Node IPC ── */

const child = spawn(nodeExe, [hostEntry, runtimeDir, profileDir], {
  cwd: profileDir,
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP: '1' },
  stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
})

const requestPipe = child.stdio[3]
const responsePipe = child.stdio[4]

let ready = null
let fatal = null
child.on('message', (m) => {
  if (m && m.type === 'ready') ready = m
  else if (m && m.type === 'fatal') fatal = m
})

let bridgeTarget = null
let stdoutBuf = ''
let stderrText = ''
child.on('exit', (code, signal) => {
  if (ready === null && fatal === null) console.error(`[e2e] Host 提前退出 code=${code} signal=${signal}`)
})
child.stdout.on('data', (chunk) => {
  stdoutBuf += String(chunk)
  const lines = stdoutBuf.split(/\r?\n/)
  stdoutBuf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.startsWith('dsh desktop: ')) continue
    try {
      bridgeTarget = JSON.parse(line.slice('dsh desktop: '.length))
    } catch {
      /* ignore */
    }
  }
})
child.stderr.on('data', (chunk) => {
  stderrText += String(chunk)
})

/**
 * 轮询等待条件成立（100ms 一次）。
 * 不用「事件里唤醒 waiter」的写法：那种写法一旦漏掉某个唤醒点就会永远挂住，
 * 而这里的事件来源（IPC ready / stdout 发现行）都是单向写入的简单状态。
 */
const waitFor = async (pred, ms, label) => {
  const deadline = Date.now() + ms
  for (;;) {
    if (pred()) return
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/* ── 管道 fetch：一次请求 = start/end(+data) 帧，响应按帧读回 ── */

const decoder = new DesktopHostResponseDecoder()
const pending = new Map()
let nextStreamId = 1
responsePipe.on('data', (chunk) => {
  for (const frame of decoder.push(chunk)) {
    const entry = pending.get(frame.streamId)
    if (!entry) continue
    if (frame.type === 'start') entry.start = frame
    else if (frame.type === 'data') {
      entry.chunks.push(Buffer.from(frame.data))
      // 远端流是**常驻流**（不会 end）：给需要早退的调用方一个回调
      entry.onData?.(entry)
    } else if (frame.type === 'end') {
      pending.delete(frame.streamId)
      entry.resolve({
        status: entry.start?.status ?? 0,
        headers: new Map(entry.start?.headers ?? []),
        body: Buffer.concat(entry.chunks),
      })
    } else if (frame.type === 'error') {
      pending.delete(frame.streamId)
      entry.reject(new Error(frame.message))
    }
  }
})
responsePipe.resume()

function pipeFetch(url, { method = 'GET', headers = [], body = null } = {}) {
  const streamId = nextStreamId++
  const result = new Promise((resolve, reject) => {
    pending.set(streamId, { chunks: [], resolve, reject, start: null })
  })
  requestPipe.write(
    encodeDesktopRequestStart(streamId, { url, method, headers, hasBody: body !== null }),
  )
  if (body !== null) {
    requestPipe.write(encodeDesktopRequestData(streamId, Buffer.from(body)))
    requestPipe.write(encodeDesktopRequestEnd(streamId))
  }
  return result
}

/**
 * 读一条**常驻流**（如 /.dsh/remote-stream 的 $events）：拿到首个完整 NDJSON 行就返回，
 * 随后向 Host 发 cancel 帧释放逻辑流（否则管道那头会一直挂着）。
 */
function pipeFirstLine(url, { method = 'POST', headers = [], body = null, timeoutMs = 15_000 } = {}) {
  const streamId = nextStreamId++
  return new Promise((resolve, reject) => {
    const finish = (result) => {
      pending.delete(streamId)
      try {
        requestPipe.write(encodeDesktopRequestCancel(streamId))
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ status: 0, headers: new Map(), body: Buffer.alloc(0), timedOut: true })
    }, timeoutMs)
    pending.set(streamId, {
      chunks: [],
      start: null,
      resolve: () => {},
      reject: (err) => {
        clearTimeout(timer)
        pending.delete(streamId)
        reject(err)
      },
      onData: (entry) => {
        const text = Buffer.concat(entry.chunks).toString('utf8')
        if (!text.includes('\n')) return
        clearTimeout(timer)
        finish({ status: entry.start?.status ?? 0, headers: new Map(entry.start?.headers ?? []), body: Buffer.concat(entry.chunks) })
      },
    })
    requestPipe.write(encodeDesktopRequestStart(streamId, { url, method, headers, hasBody: body !== null }))
    if (body !== null) {
      requestPipe.write(encodeDesktopRequestData(streamId, Buffer.from(body)))
      requestPipe.write(encodeDesktopRequestEnd(streamId))
    }
  })
}

const fail = (msg) => {
  console.error(`[e2e] ✘ ${msg}`)
  if (stderrText.trim() !== '') {
    console.error(`[e2e] Host stderr:\n${stderrText.trim().split(/\r?\n/).slice(-12).join('\n')}`)
  }
  cleanup()
  process.exit(1)
}

let ws = null
/**
 * 收尾：先杀 Host，再删临时 DSH_HOME。
 * Windows 上 SIGKILL 之后句柄可能还压着目录（会话文件/日志），立即 rmSync 会 EPERM——
 * 重试几次即可，不能让收尾的竞态把一次成功的 e2e 判成失败。
 */
function cleanup() {
  try { ws?.close() } catch { /* ignore */ }
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  if (process.env.DSH_E2E_KEEP === '1') {
    console.log(`[e2e] 保留临时目录: ${home}`)
    return
  }
  for (const delayMs of [0, 100, 300, 800]) {
    if (delayMs > 0) sleepSync(delayMs)
    try {
      rmSync(home, { recursive: true, force: true })
      return
    } catch (err) {
      if (delayMs === 800) console.error(`[e2e] 临时目录清理失败（不影响结果）: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** 同步等待（收尾用；此时不该再有异步逻辑要推进）。 */
function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buf, 0, 0, ms)
}

const results = []
/** 预期内的「环境未配置」类错误：RPC 链路正常，只是本机没配 key —— 记为警告而非失败。 */
const EXPECTED_ERROR = {
  'billing.balance': /未配置|no.?key|credentials/i,
}
async function rpc(name, method, params, timeoutMs = 8000, report = true) {
  const id = Math.floor(Math.random() * 1e9)
  const reply = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('RPC 超时')), timeoutMs)
    const onMsg = (ev) => {
      let m
      try { m = JSON.parse(String(ev.data)) } catch { return }
      if (m && m.type === 'result' && m.id === id) {
        clearTimeout(t)
        ws.removeEventListener('message', onMsg)
        resolve(m)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ type: 'call', id, method, params }))
  })
  const expected = reply.error && EXPECTED_ERROR[method]?.test(String(reply.error))
  // report=false：调用方自己会做更严格的结果断言（避免同一调用出现两条结果行）
  if (report) results.push({ name, ok: !reply.error, expected: !!expected, detail: reply.error ?? reply.result })
  return reply
}

try {
  await waitFor(() => ready !== null || fatal !== null, 180_000, 'Host ready（IPC）')
  if (fatal) throw new Error(`Host 报 fatal：${fatal.message}`)
  if (ready.protocolVersion !== 3) throw new Error(`协议版本不是 3：${String(ready.protocolVersion)}`)
  console.log(`[e2e] ✔ Host 引导成功（dsh ${ready.dshVersion}，协议 v${String(ready.protocolVersion)}，无监听端口）`)

  // 1. 管道 fetch：入口文档 + Host 注入的传输脚本 + 静态资源
  const index = await pipeFetch('http://dsh.internal/')
  const html = index.body.toString('utf8')
  results.push({
    name: 'pipe:GET / → index.html',
    ok: index.status === 200 && html.includes('<div id="root">'),
    detail: { status: index.status, bytes: index.body.length },
  })
  results.push({
    name: 'pipe:index 注入 __DSH_TRANSPORT__',
    ok: html.includes('__DSH_TRANSPORT__'),
    detail: { hasTransport: html.includes('__DSH_TRANSPORT__') },
  })
  const asset = html.match(/(?:src|href)="\.?(\/assets\/[^"]+)"/)
  if (asset) {
    const js = await pipeFetch(`http://dsh.internal${asset[1]}`)
    results.push({
      name: `pipe:GET ${asset[1]}`,
      ok: js.status === 200 && js.body.length > 0,
      detail: { status: js.status, bytes: js.body.length },
    })
  }
  // 2. 远端流（NDJSON）：$events 首帧必须是 ready
  const stream = await pipeFirstLine('http://dsh.internal/.dsh/remote-stream', {
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({ endpoint: '$events', payload: { args: {} } }),
  })
  const firstLine = stream.body.toString('utf8').split('\n').find((l) => l.trim() !== '') ?? ''
  let parsed = null
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    /* ignore */
  }
  results.push({
    name: 'pipe:/.dsh/remote-stream $events',
    // NDJSON 直接承载 item 的 value（官方 desktop host 的 wireStream 形状）：
    // $events 的首行就是 ready（含 clientId 与 host 事实）
    ok: stream.status === 200 && parsed?.type === 'ready' && typeof parsed.clientId === 'string' && parsed.host !== undefined,
    detail: { status: stream.status, first: firstLine.slice(0, 100) },
  })

  // 3. bridge：发现行 + WS 鉴权 + RPC
  await waitFor(() => bridgeTarget !== null, 60_000, 'bridge 发现行')
  console.log(`[e2e] ✔ bridge 发现行: port=${bridgeTarget.port}`)
  ws = new WebSocket(`ws://127.0.0.1:${bridgeTarget.port}`)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS 连接超时')), 10_000)
    ws.addEventListener('open', () => { clearTimeout(t); resolve() })
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WS 连接失败')) })
  })
  const authed = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('鉴权超时')), 10_000)
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(String(ev.data))
        if (m && m.type === 'authed') { clearTimeout(t); resolve(m) }
      } catch { /* ignore */ }
    })
    // 协议版本必须一起发：插件用它与自己那版比对并回报（壳据此判断同代）
    ws.send(JSON.stringify({ type: 'auth', token: bridgeTarget.token, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
  })
  console.log(`[e2e] ✔ bridge 鉴权: ${String(authed.type === 'authed')}`)
  const authedPayload = authed.payload ?? {}
  results.push({
    name: 'bridge 握手协议版本一致',
    ok: authedPayload.protocolVersion === BRIDGE_PROTOCOL_VERSION,
    detail: { shell: BRIDGE_PROTOCOL_VERSION, plugin: authedPayload.protocolVersion ?? null },
  })
  results.push({
    // 插件把自己的诊断随 authed 一起给壳：连接后立刻知道 jobs 服务在不在
    name: 'bridge diag（jobs 服务）',
    ok: authedPayload.diag?.code === 'jobs.present',
    detail: authedPayload.diag ?? null,
  })

  await rpc('ping', 'ping')
  await rpc('runtime.info', 'runtime.info')
  const list = await rpc('sessions.list', 'sessions.list')
  const sessions = Array.isArray(list.result?.sessions) ? list.result.sessions : []
  console.log(`[e2e]   sessions.list → ${sessions.length} 条`)
  const persisted = sessions.find((s) => s && s.live === false)
  if (persisted) await rpc('session.resolve(persisted)', 'session.resolve', { id: persisted.id })
  await rpc('dashboard.snapshot', 'dashboard.snapshot')
  await rpc('billing.balance', 'billing.balance')

  // 3b. 鉴权必须真的拒绝坏 token（空 token 一样不许进）
  for (const [name, badToken] of [['错 token', 'f'.repeat(32)], ['空 token', '']]) {
    const probe = new WebSocket(`ws://127.0.0.1:${bridgeTarget.port}`)
    const outcome = await new Promise((resolve) => {
      const t = setTimeout(() => { try { probe.close() } catch { /* ignore */ } resolve({ code: null }) }, 5000)
      probe.addEventListener('close', (ev) => { clearTimeout(t); resolve({ code: ev.code }) })
      probe.addEventListener('error', () => { /* close 会随后到达 */ })
      probe.addEventListener('open', () => probe.send(JSON.stringify({ type: 'auth', token: badToken })))
    })
    results.push({ name: `bridge 拒绝${name}（4001）`, ok: outcome.code === 4001, detail: outcome })
  }

  // 3c. 工作区注册（壳的「选择工作区」走这条 RPC；用临时目录，不碰用户环境）
  const wsDir = path.join(home, 'e2e-workspace')
  mkdirSync(wsDir, { recursive: true })
  const registered = await rpc('workspace.register', 'workspace.register', { path: wsDir }, 8000, false)
  results.push({
    name: 'bridge workspace.register',
    ok: registered.result?.ok === true && typeof registered.result?.id === 'string',
    detail: registered.result ?? registered.error,
  })
  const missingParam = await rpc('workspace.register(missing)', 'workspace.register', {}, 8000, false)
  results.push({
    name: 'bridge workspace.register 参数校验',
    ok: typeof missingParam.error === 'string' && missingParam.error.includes('missing params.path'),
    detail: missingParam.error,
  })
  const unknown = await rpc('unknown method', 'nope.method', undefined, 8000, false)
  results.push({
    name: 'bridge 未知方法报错',
    ok: typeof unknown.error === 'string' && unknown.error.includes('unknown method'),
    detail: unknown.error,
  })

  // 4. 对外门面（局域网/浏览器版）：请求喂给同一条管道 fetch + token 门禁
  const { createLanProxy } = await import('../src/main/lanServer.ts')
  const lan = await createLanProxy({
    bindHost: '127.0.0.1',
    port: 0,
    forward: async (request) => {
      const url = new URL(request.url)
      const res = await pipeFetch(`http://dsh.internal${url.pathname}${url.search}`, { method: request.method })
      return new Response(res.body, {
        status: res.status,
        headers: [['content-type', res.headers.get('content-type') ?? 'text/html']],
      })
    },
    token: 'e2e-lan-token',
  })
  try {
    const denied = await fetch(`http://127.0.0.1:${lan.port}/`, { redirect: 'manual' })
    results.push({ name: 'lan:/ 无 token → 401', ok: denied.status === 401, detail: { status: denied.status } })
    const exchanged = await fetch(`http://127.0.0.1:${lan.port}/?token=e2e-lan-token`, { redirect: 'manual' })
    const cookie = (exchanged.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? ''
    results.push({
      name: 'lan:/?token= → 303 + cookie',
      ok: exchanged.status === 303 && cookie.startsWith('dsh-desk-access='),
      detail: { status: exchanged.status, cookie: cookie.slice(0, 24) + '…' },
    })
    const allowed = await fetch(`http://127.0.0.1:${lan.port}/`, { headers: cookie ? { cookie } : {} })
    const allowedHtml = await allowed.text()
    results.push({
      name: 'lan:/ 带 cookie → 200 index',
      ok: allowed.status === 200 && allowedHtml.includes('<div id="root">'),
      detail: { status: allowed.status, bytes: allowedHtml.length },
    })
  } finally {
    await lan.stop()
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}

console.log('\n[e2e] 结果:')
let bad = 0
for (const r of results) {
  if (!r.ok && !r.expected) bad += 1
  const detail = r.ok || r.expected ? JSON.stringify(r.detail).slice(0, 140) : `ERROR: ${JSON.stringify(r.detail).slice(0, 300)}`
  console.log(`  ${r.ok || r.expected ? '✔' : '✘'} ${r.name.padEnd(34)} ${detail}`)
}
if (bad !== 0 && stderrText.trim() !== '') {
  console.log('\n[e2e] Host stderr 摘要:\n' + stderrText.trim().split(/\r?\n/).slice(-8).join('\n'))
}
cleanup()
console.log(bad === 0 ? '\n[e2e] 全部通过 ✔' : `\n[e2e] ${bad} 项失败 ✘`)
process.exit(bad === 0 ? 0 : 1)
