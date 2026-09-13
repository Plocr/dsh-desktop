/**
 * E2E：桌面壳 ↔ harness bridge 契约测试（针对当前内置运行时）。
 *
 * 每次升级内置 harness 版本后跑一次，验证：
 *  1. `dsh --profile dsh-workbench --patch <overlay>` 能启动（CLI 参数/守卫兼容）；
 *  2. stdout 出现 `dsh web:` 与 `dsh desktop: {"port","token"}` 发现行；
 *  3. bridge WS 鉴权 + 全部 RPC 方法可用（含 session.resolve 的持久化读取路径）。
 *
 * 用法：node scripts/e2e-bridge.mjs [--sessions <dir>]
 *   --sessions <dir>  可选：把某目录下的真实会话复制进临时 DSH_HOME（测持久化读取路径）。
 * 环境：DSH_E2E_KEEP=1 保留临时目录（排障用）。
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(root, 'resources', 'dsh-runtime')
const nodeExe = path.join(runtimeDir, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const dshBin = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const bridgeSrc = path.join(root, 'resources', 'plugins', 'bridge')
const templateDir = path.join(root, 'resources', 'profile-template', 'dsh-workbench')

const args = process.argv.slice(2)
const sessionsArgIdx = args.indexOf('--sessions')
const sessionsDir = sessionsArgIdx >= 0 ? args[sessionsArgIdx + 1] : null

for (const [label, p] of [['runtime node', nodeExe], ['dsh bin', dshBin], ['bridge plugin', bridgeSrc], ['profile template', templateDir]]) {
  if (!existsSync(p)) {
    console.error(`[e2e] 缺少 ${label}: ${p}（先跑 npm run setup:runtime）`)
    process.exit(2)
  }
}

const home = path.join(os.tmpdir(), `dsh-e2e-bridge-${Date.now()}`)
const PROFILE = 'dsh-workbench'
const profileDir = path.join(home, 'profiles', PROFILE)
mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
cpSync(path.join(templateDir, 'package.json'), path.join(profileDir, 'package.json'))
cpSync(bridgeSrc, path.join(profileDir, 'node_modules', 'dsh-desktop-bridge'), { recursive: true })
if (sessionsDir && existsSync(sessionsDir)) {
  cpSync(sessionsDir, path.join(home, 'sessions'), { recursive: true })
  console.log(`[e2e] 已复制会话目录: ${sessionsDir}`)
}
const TOKEN = 'e2e-token-' + Date.now()
const overlay = path.join(home, 'overlay-desktop.yml')
writeFileSync(
  overlay,
  `# e2e overlay\n- insert:\n    - id: dsh-desktop-bridge\n      name: dsh-desktop-bridge\n      config:\n        token: ${TOKEN}\n`,
)

const child = spawn(nodeExe, [dshBin, '--profile', PROFILE, '--patch', overlay, '--port', '0', '--no-open'], {
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let out = ''
let bridgeTarget = null
let webUrl = null
const waiters = []
const scan = (chunk) => {
  out += chunk
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('dsh web: ')) webUrl = line.slice('dsh web: '.length).trim()
    if (line.startsWith('dsh desktop: ')) {
      try {
        bridgeTarget = JSON.parse(line.slice('dsh desktop: '.length))
      } catch {
        /* ignore */
      }
    }
  }
  const last = out.split(/\r?\n/).pop() ?? ''
  out = last
  for (const w of [...waiters]) {
    if (w.pred()) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve()
    }
  }
}
child.stdout.on('data', (c) => scan(String(c)))
child.stderr.on('data', (c) => scan(String(c)))

const waitFor = (pred, ms, label) =>
  new Promise((resolve, reject) => {
    if (pred()) return resolve()
    const t = setTimeout(() => reject(new Error(`等待超时：${label}`)), ms)
    waiters.push({ pred, resolve: () => { clearTimeout(t); resolve() } })
  })

const fail = (msg) => {
  console.error(`[e2e] ✘ ${msg}`)
  cleanup()
  process.exit(1)
}

let ws = null
function cleanup() {
  try { ws?.close() } catch { /* ignore */ }
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  if (process.env.DSH_E2E_KEEP !== '1') rmSync(home, { recursive: true, force: true })
  else console.log(`[e2e] 保留临时目录: ${home}`)
}

const results = []
/** 预期内的「环境未配置」类错误：RPC 链路正常，只是本机没配 key —— 记为警告而非失败。 */
const EXPECTED_ERROR = {
  'billing.balance': /未配置|no.?key|credentials/i,
}
async function rpc(name, method, params, timeoutMs = 8000) {
  const id = Math.floor(Math.random() * 1e9)
  const line = JSON.stringify({ type: 'call', id, method, params })
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
    ws.send(line)
  })
  const expected = reply.error && EXPECTED_ERROR[method]?.test(String(reply.error))
  results.push({ name, ok: !reply.error, expected: !!expected, detail: reply.error ?? reply.result })
  return reply
}

try {
  await waitFor(() => bridgeTarget && webUrl, 90_000, 'harness ready（dsh web:/dsh desktop: 行）')
  console.log(`[e2e] ✔ harness 启动: web=${webUrl}`)
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
        if (m && m.type === 'authed') { clearTimeout(t); resolve(true) }
      } catch { /* ignore */ }
    })
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
  })
  console.log(`[e2e] ✔ bridge 鉴权: ${String(authed)}`)

  await rpc('ping', 'ping')
  await rpc('runtime.info', 'runtime.info')
  const list = await rpc('sessions.list', 'sessions.list')
  const sessions = Array.isArray(list.result?.sessions) ? list.result.sessions : []
  console.log(`[e2e]   sessions.list → ${sessions.length} 条`)
  if (process.env.DSH_E2E_DEBUG === '1') console.log('[e2e][debug] ' + JSON.stringify(sessions.slice(0, 2), null, 2))
  const persisted = sessions.find((s) => s && s.live === false)
  if (persisted) {
    await rpc('session.resolve(persisted)', 'session.resolve', { id: persisted.id })
  }
  await rpc('dashboard.snapshot', 'dashboard.snapshot')
  await rpc('billing.balance', 'billing.balance')

  // ── 局域网代理 + URL token 鉴权（harness ≥ 0.1.2-rc.1：token 换 HttpOnly cookie）──
  const webPort = Number(new URL(webUrl).port)
  const webToken = new URL(webUrl).searchParams.get('token') ?? ''
  const { createLanProxy } = await import('../src/main/lanServer.ts')
  const lan = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: webPort,
    port: 0,
    requestApproval: async () => true,
    webToken,
  })
  try {
    const first = await fetch(`http://127.0.0.1:${lan.port}/`, { redirect: 'manual' })
    const setCookie = (first.headers.getSetCookie?.() ?? [])[0] ?? ''
    const cookie = setCookie.split(';')[0]
    results.push({
      name: 'lan:/ (无 cookie→换 cookie)',
      ok: first.status === 303 && cookie.startsWith('dsh-auth-'),
      detail: { status: first.status, cookie: cookie.slice(0, 24) + '…' },
    })
    const second = await fetch(`http://127.0.0.1:${lan.port}/`, {
      redirect: 'manual',
      headers: cookie ? { cookie } : {},
    })
    results.push({ name: 'lan:/ (带 cookie→200)', ok: second.status === 200, detail: { status: second.status } })
  } finally {
    await lan.stop()
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}

console.log('\n[e2e] RPC 结果:')
let bad = 0
for (const r of results) {
  if (!r.ok && !r.expected) bad += 1
  const detail = r.ok ? JSON.stringify(r.detail).slice(0, 120) : `${r.expected ? '（预期：未配置）' : 'ERROR: '}${String(r.detail).slice(0, 160)}`
  console.log(`  ${r.ok || r.expected ? '✔' : '✘'} ${r.name.padEnd(26)} ${detail}`)
}
cleanup()
console.log(bad === 0 ? '\n[e2e] 全部通过 ✔' : `\n[e2e] ${bad} 项失败 ✘`)
process.exit(bad === 0 ? 0 : 1)
