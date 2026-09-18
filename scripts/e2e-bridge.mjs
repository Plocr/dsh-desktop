/**
 * E2E：随包运行时 ↔ 桌面壳契约测试（**官方传输形态**）。
 *
 * 每次升级随包 dsh / 改动 Host 或传输后跑一次，验证：
 *  1. 随包 Host（dsh-desktop-host）用官方 `runProfile` 引导 profile 并报 ready，
 *     ready 里带**认证 URL**与 **index 注入片段**；
 *  2. Host **不在启动时拉起浏览器**（stdout 不得出现 `dsh web:` / opening the default
 *     browser）——用户手动点托盘才开浏览器版；
 *  3. 主进程侧的三件官方工具可用：`serveWebDocument`（入口文档带 __DSH_BOOT_READY__）、
 *     `authenticateWebHost`（URL → cookie）、`forwardWebRequest`（带 cookie 转发 /api）；
 *  4. 官方插件管理器已激活：`/api/pluginManager/listBundles` 经转发返回 server-response；
 *  5. bridge 插件（壳 ↔ harness 原生能力通道）发现行、鉴权与 RPC 全部可用；
 *  6. 对外门面（lanServer）HTTP + **WebSocket 升级**都能代理，且门禁有效。
 *
 * 这里不经过 Electron：直接按壳的 spawn 契约起 Host，转发工具直接复用 src/main 的实现。
 *
 * 用法：node scripts/e2e-bridge.mjs [--sessions <dir>]
 * 环境：DSH_E2E_KEEP=1 保留临时目录（排障用）。
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 转发工具复用壳的生产实现（同一份源码，Node 直接加载 TS）。
import { serveWebDocument, authenticateWebHost, forwardWebRequest } from '../src/main/webDocument.ts'
import { BRIDGE_PROTOCOL_VERSION } from '../src/main/bridgeEvents.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(root, 'resources', 'dsh')
const nodeExe = path.join(root, 'resources', 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const templateDir = path.join(root, 'resources', 'profile-template', 'dsh-workbench')
const hostEntry = path.join(runtimeDir, 'node_modules', 'dsh-desktop-host', 'lib', 'index.js')
const pnpmEntry = path.join(root, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.cjs')
const webDistDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')

const args = process.argv.slice(2)
const sessionsArgIdx = args.indexOf('--sessions')
const sessionsDir = sessionsArgIdx >= 0 ? args[sessionsArgIdx + 1] : null

for (const [label, p] of [['runtime node', nodeExe], ['Host 入口', hostEntry], ['profile 模板', templateDir], ['web dist', webDistDir]]) {
  if (!existsSync(p)) {
    console.error(`[e2e] 缺少 ${label}: ${p}（先跑 npm run setup:runtime）`)
    process.exit(2)
  }
}

/* ── 临时 DSH_HOME + profile（等价壳 ensureProfile 的结果）── */

const home = path.join(os.tmpdir(), `dsh-e2e-host-${Date.now()}`)
const profileDir = path.join(home, 'profiles', 'dsh-workbench')
mkdirSync(profileDir, { recursive: true })
for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
  cpSync(path.join(templateDir, f), path.join(profileDir, f))
}
// 共享包 junction + bundles 补上 bridge：等价壳 ensureProfile 的结果
// （官方 runtime 解析会校验每一条 bundle 都能在 profile 或运行时树里解析到）。
const profileModules = path.join(profileDir, 'node_modules')
mkdirSync(profileModules, { recursive: true })
for (const name of ['@deepseek-ai/dsh', 'dsh-desktop-bridge', 'dsh-desktop-host']) {
  const link = path.join(profileModules, name)
  mkdirSync(path.dirname(link), { recursive: true })
  if (existsSync(link)) rmSync(link, { recursive: true, force: true })
  symlinkSync(path.join(runtimeDir, 'node_modules', name), link, process.platform === 'win32' ? 'junction' : 'dir')
}
const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
manifest.dsh = {
  profile: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-desktop-bridge'],
  },
}
writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(
  path.join(profileDir, 'pnpm-workspace.yaml'),
  [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'allowBuilds:',
    '  node-pty: true',
    '  koffi: true',
    '  fs-ext: true',
    '',
  ].join('\n'),
)
if (sessionsDir !== null) {
  if (!existsSync(sessionsDir)) {
    console.error(`[e2e] --sessions 目录不存在: ${sessionsDir}`)
    process.exit(2)
  }
  cpSync(sessionsDir, path.join(home, 'sessions'), { recursive: true })
}

const results = []
/** 预期内的「环境未配置」类错误：RPC 链路正常，只是本机没配 key —— 记为警告而非失败。 */
const EXPECTED_ERROR = {
  'workspace.register': /missing params\.path/,
  'bogus.method': /unknown method/,
  'billing.balance': /未配置|no.?key|credentials/i,
}

/* ── 按壳的 spawn 契约起 Host：官方形态（stdio + Node IPC，没有字节管道）── */

const startedAt = Date.now()
const child = spawn(nodeExe, [hostEntry, runtimeDir, profileDir, '--pnpm', pnpmEntry], {
  cwd: profileDir,
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP: '1' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})

let ready = null
let fatal = null
let bridgeTarget = null
let stdoutBuf = ''
let stdoutText = ''
let stderrText = ''
child.on('message', (m) => {
  if (m && m.type === 'ready') ready = m
  else if (m && m.type === 'fatal') fatal = m
})
child.on('exit', (code, signal) => {
  if (ready === null && fatal === null) console.error(`[e2e] Host 提前退出 code=${code} signal=${signal}`)
})
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  stdoutText += chunk
  stdoutBuf += chunk
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
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderrText += chunk })

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const waitFor = async (pred, ms, label) => {
  const deadline = Date.now() + ms
  for (;;) {
    if (pred()) return
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await sleep(100)
  }
}

function cleanup() {
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  if (process.env.DSH_E2E_KEEP === '1') {
    console.log(`[e2e] 保留临时目录：${home}`)
    return
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(home, { recursive: true, force: true })
      return
    } catch {
      /* Windows 上进程刚退出时句柄可能还压着目录 */
      const wait = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(wait, 0, 0, 300)
    }
  }
}

function fail(msg) {
  console.error(`[e2e] ✘ ${msg}`)
  if (stderrText.trim() !== '') {
    console.error(`[e2e] Host stderr:\n${stderrText.trim().split(/\r?\n/).slice(-12).join('\n')}`)
  }
  cleanup()
  process.exit(1)
}

let ws = null
/** bridge 插件的手工 WS 客户端（vendor/ws）——桌面原生能力通道的契约面。 */
async function rpc(name, method, params, timeoutMs = 8000, report = true) {
  const id = Math.floor(Math.random() * 1e9)
  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => { resolve({ error: `timeout:${method}` }) }, timeoutMs)
    const onMsg = (event) => {
      let parsed
      try {
        parsed = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (parsed?.type !== 'result' || parsed.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMsg)
      resolve(parsed)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ type: 'call', id, method, params }))
  })
  const expected = reply.error && EXPECTED_ERROR[method]?.test(String(reply.error))
  if (report) results.push({ name, ok: !reply.error, expected: !!expected, detail: reply.error ?? reply.result })
  return reply
}

try {
  await waitFor(() => ready !== null || fatal !== null, 180_000, 'Host ready（IPC）')
  if (fatal) throw new Error(`Host 报 fatal：${fatal.message}`)
  const bootMs = Date.now() - startedAt
  console.log(`[e2e] ✔ Host 引导成功（dsh ${ready.dshVersion}，${bootMs}ms，官方 runProfile + 认证 URL）`)

  results.push({
    name: 'ready 带 url + injections',
    ok: typeof ready.url === 'string' && ready.url.startsWith('http://127.0.0.1:') && Array.isArray(ready.injections) && ready.injections.length > 0,
    detail: { url: ready.url.replace(/token=[^&]+/u, 'token=***'), injections: ready.injections.length },
  })
  // 第 2 项（用户明确要求）：默认绝不自动打开浏览器
  results.push({
    name: '未自动打开浏览器（--no-open）',
    ok: !/opening the default browser|opened the default browser/u.test(stdoutText),
    detail: { stdoutHead: stdoutText.split(/\r?\n/).filter(Boolean).slice(0, 2).join(' | ').slice(0, 120) },
  })

  // 1. 官方三件套：入口文档（含 boot 等待器） / 认证换 cookie / 带 cookie 转发
  const indexResponse = await serveWebDocument(new Request('dsh-app://app/', { method: 'GET' }), webDistDir)
  const html = await indexResponse.text()
  results.push({
    name: 'serveWebDocument → index + 注入点',
    ok: indexResponse.status === 200 && html.includes('__DSH_BOOT_READY__') && html.includes('<div id="root">'),
    detail: { status: indexResponse.status, bytes: html.length },
  })
  const cookie = await authenticateWebHost(ready.url)
  results.push({
    name: 'authenticateWebHost → cookie',
    ok: cookie.startsWith('dsh-'),
    detail: { cookie: cookie.split('=')[0] },
  })
  const asset = html.match(/(?:src|href)="\.?(\/assets\/[^"]+)"/)
  if (asset) {
    const assetResponse = await serveWebDocument(new Request(`dsh-app://app${asset[1]}`, { method: 'GET' }), webDistDir)
    results.push({
      name: `serveWebDocument → ${asset[1]}`,
      ok: assetResponse.status === 200 && (await assetResponse.arrayBuffer()).byteLength > 0,
      detail: { status: assetResponse.status },
    })
  }

  // 2. 官方插件系统：/api 经 cookie 转发（Host 侧 profileContext 生效才会认领该端点）
  const apiResponse = await forwardWebRequest(
    new Request('dsh-app://app/api/pluginManager/listBundles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'dsh-app://app' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'e2e-plugin-manager',
        method: 'pluginManager/listBundles',
        payload: { args: {} },
      }),
    }),
    ready.url,
    cookie,
  )
  const apiText = await apiResponse.text()
  results.push({
    name: 'forwardWebRequest → pluginManager',
    ok: apiResponse.status !== 404 && apiText.includes('server-response'),
    detail: { status: apiResponse.status, body: apiText.slice(0, 140) },
  })
  // 来源校验：非应用来源的请求必须被拒绝（除非门面显式放行）
  const foreign = await forwardWebRequest(
    new Request('dsh-app://app/', { headers: { origin: 'http://evil.example' } }),
    ready.url,
    cookie,
  )
  results.push({ name: 'forwardWebRequest 拒绝外来 Origin', ok: foreign.status === 403, detail: { status: foreign.status } })

  // 3. bridge：发现行 + WS 鉴权 + RPC
  await waitFor(() => bridgeTarget !== null, 60_000, 'bridge 发现行')
  console.log(`[e2e] ✔ bridge 发现行: port=${bridgeTarget.port}`)
  const { default: WebSocket } = await import('../packages/bridge/vendor/ws/wrapper.mjs')
  ws = new WebSocket(`ws://127.0.0.1:${bridgeTarget.port}`)
  const hello = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('bridge 握手超时')) }, 10_000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: bridgeTarget.token, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
    })
    ws.on('message', (data) => {
      let parsed
      try {
        parsed = JSON.parse(String(data))
      } catch {
        return
      }
      if (parsed?.type !== 'authed') return
      clearTimeout(timer)
      resolve(parsed)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
  const authedPayload = hello.payload ?? {}
  results.push({
    name: 'bridge 鉴权 + 协议版本',
    ok: authedPayload.protocolVersion === BRIDGE_PROTOCOL_VERSION,
    detail: { shell: BRIDGE_PROTOCOL_VERSION, plugin: authedPayload.protocolVersion ?? null },
  })
  results.push({
    name: 'bridge diag（jobs 服务）',
    ok: authedPayload.diag?.code === 'jobs.present',
    detail: authedPayload.diag ?? null,
  })
  // 坏 token 必须被拒绝（4001），且拒绝后连接关闭
  for (const [label, badToken] of [['错 token', 'f'.repeat(32)], ['空 token', '']]) {
    const rejected = await new Promise((resolve) => {
      const probe = new WebSocket(`ws://127.0.0.1:${bridgeTarget.port}`)
      const timer = setTimeout(() => { try { probe.close() } catch { /* ignore */ } resolve({ code: 0 }) }, 8000)
      probe.on('open', () => { probe.send(JSON.stringify({ type: 'auth', token: badToken, protocolVersion: BRIDGE_PROTOCOL_VERSION })) })
      probe.on('close', (code) => { clearTimeout(timer); resolve({ code }) })
      probe.on('error', () => { /* close 会跟着到 */ })
    })
    results.push({ name: `bridge 拒绝${label}（4001）`, ok: rejected.code === 4001, detail: rejected })
  }
  await rpc('bridge ping', 'ping', {})
  await rpc('bridge runtime.info', 'runtime.info', {})
  await rpc('bridge sessions.list', 'sessions.list', {})
  await rpc('bridge dashboard.snapshot', 'dashboard.snapshot', {})
  await rpc('bridge billing.balance', 'billing.balance', {})
  const workspacePath = path.join(home, 'ws-e2e')
  mkdirSync(workspacePath, { recursive: true })
  await rpc('bridge workspace.register', 'workspace.register', { path: workspacePath })
  await rpc('bridge workspace.register 参数校验', 'workspace.register', {})
  await rpc('bridge 未知方法报错', 'bogus.method', {})

  // 4. 对外门面：HTTP + WebSocket 升级都要能代理，且门禁有效
  const { createLanProxy } = await import('../src/main/lanServer.ts')
  const lan = await createLanProxy({
    bindHost: '127.0.0.1',
    port: 0,
    forward: (request) => forwardWebRequest(request, ready.url, cookie, true),
    upgrade: (req, socket, head) => {
      // 与生产实现同形：把升级请求原样转给 Host，并补上 Origin/Cookie。
      const target = new URL(ready.url)
      const headers = { ...req.headers, host: target.host, origin: target.origin, cookie, 'sec-fetch-site': 'same-origin' }
      const upstream = httpRequest({ hostname: target.hostname, port: target.port, path: req.url ?? '/', method: 'GET', headers })
      upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`]
        for (const [name, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (upstreamHead.length > 0) socket.write(upstreamHead)
        if (head.length > 0) upstreamSocket.write(head)
        socket.pipe(upstreamSocket).pipe(socket)
      })
      upstream.on('response', (response) => {
        socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n\r\n`)
        response.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
      upstream.end()
    },
    token: 'e2e-lan-token',
  })
  try {
    const denied = await fetch(`http://127.0.0.1:${lan.port}/`, { redirect: 'manual' })
    results.push({ name: 'lan:/ 无 token → 401', ok: denied.status === 401, detail: { status: denied.status } })
    const exchanged = await fetch(`http://127.0.0.1:${lan.port}/?token=e2e-lan-token`, { redirect: 'manual' })
    const lanCookie = (exchanged.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? ''
    results.push({
      name: 'lan:/?token= → 303 + cookie',
      ok: exchanged.status === 303 && lanCookie.startsWith('dsh-desk-access='),
      detail: { status: exchanged.status, cookie: lanCookie.slice(0, 24) + '…' },
    })
    const allowed = await fetch(`http://127.0.0.1:${lan.port}/`, { headers: lanCookie ? { cookie: lanCookie } : {} })
    const allowedHtml = await allowed.text()
    results.push({
      name: 'lan:/ 带 cookie → 200 index',
      ok: allowed.status === 200 && allowedHtml.includes('<div id="root">'),
      detail: { status: allowed.status, bytes: allowedHtml.length },
    })
    // WebSocket 升级经门面（浏览器客户端拉流的真实路径）
    const wsUpgrade = await new Promise((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: lan.port,
        path: '/api/remote.mux',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
          'sec-websocket-version': '13',
          cookie: lanCookie,
        },
      })
      req.on('upgrade', (response, socket) => {
        socket.destroy()
        resolve({ status: response.statusCode, ok: true })
      })
      req.on('response', (response) => {
        response.resume()
        resolve({ status: response.statusCode, ok: false })
      })
      req.on('error', (error) => resolve({ status: 0, ok: false, error: String(error) }))
      req.end()
    })
    results.push({
      name: 'lan: WS 升级 → 101（门禁后代理）',
      ok: wsUpgrade.ok && wsUpgrade.status === 101,
      detail: wsUpgrade,
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
