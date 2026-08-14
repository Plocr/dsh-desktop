/**
 * 仪表盘/终端 E2E 验证（CDP）。
 * 前置：以调试端口启动 dev 或打包版
 *   $env:DSH_DESKTOP_ELECTRON_ARGS = '--remote-debugging-port=9222'
 *   npm run dev
 * 用法: node scripts/verify-dashboard.mjs
 * 断言：面板注入、布局让位、数据渲染、主题跟随、终端回环、折叠/拖宽状态。
 */
const CDP = 'http://127.0.0.1:9222'

const targets = await (await fetch(`${CDP}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))
if (!page) {
  console.error('✗ 未找到 harness 页面 target（确认已带 --remote-debugging-port=9222 启动）')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data))
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) p.reject(new Error(JSON.stringify(m.error)))
    else p.resolve(m.result)
  }
}
await new Promise((resolve) => (ws.onopen = resolve))

const evalJs = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)}`)
  }
  return r.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/* 1. 面板注入与结构 */
await sleep(3000)
const shell = await evalJs(`(() => {
  const root = document.getElementById('dshd-root')
  const tab = document.getElementById('dshd-tab')
  const term = document.getElementById('dshd-term')
  const d = window.__dshd
  return { root: !!root, tab: !!tab, term: !!term, api: !!d, version: d?.version, dash: !!window.dshDesktop }
})()`)
check('面板节点注入（root/tab/term）', shell.root && shell.tab && shell.term)
check('CDP 验证钩子 window.__dshd', shell.api, `version=${shell.version ?? '?'}`)
check('preload API 可见 window.dshDesktop', shell.dash)

/* 2. 布局让位：#root padding-right 已生效 */
const layout = await evalJs(`(() => {
  const root = document.getElementById('root')
  const html = document.documentElement
  const pr = root ? getComputedStyle(root).paddingRight : '?'
  const pb = root ? getComputedStyle(root).paddingBottom : '?'
  return { sidebar: html.dataset.dshdSidebar, term: html.dataset.dshdTerm, pr, pb }
})()`)
check('侧栏展开 → #root 右让位', layout.sidebar === '1' && parseFloat(layout.pr) > 200, `paddingRight=${layout.pr}`)

/* 3. 状态渲染（等主进程推送） */
let snap = null
for (let i = 0; i < 20; i++) {
  snap = await evalJs(`window.__dshd?.getState ? JSON.parse(JSON.stringify(window.__dshd.getState())) : null`)
  if (snap && snap.harness?.state === 'ready') break
  await sleep(500)
}
check('仪表盘收到状态快照', !!snap, `harness=${snap?.harness?.state ?? '?'} bridge=${snap?.bridge ?? '?'}`)
if (snap) {
  const runtimeHtml = await evalJs(`document.getElementById('dshd-runtime')?.innerText || ''`)
  check('运行时卡渲染（PID/Node）', runtimeHtml.includes('PID'), runtimeHtml.split('\n').slice(0, 4).join(' | '))
  const jobsHtml = await evalJs(`document.getElementById('dshd-jobs')?.innerText || ''`)
  check('任务卡渲染', jobsHtml.length > 0, jobsHtml.slice(0, 60))
  const logsHtml = await evalJs(`document.getElementById('dshd-logs')?.childElementCount || 0`)
  check('活动流有行', logsHtml > 0, `${logsHtml} 行`)
}

/* 4. 主题跟随：深色主题下面板背景非白 */
const themed = await evalJs(`(() => {
  const root = document.getElementById('dshd-root')
  if (!root) return null
  const bg = getComputedStyle(root).backgroundColor
  const isDark = document.body.hasAttribute('data-ds-dark-theme')
  return { bg, isDark }
})()`)
check('主题探测执行', themed !== null, `dark=${themed?.isDark} bg=${themed?.bg}`)

/* 5. 折叠/展开 */
await evalJs(`window.__dshd.toggleSidebar()`)
await sleep(800)
const collapsed = await evalJs(`document.documentElement.dataset.dshdSidebar`)
check('折叠生效', collapsed === '0', `data-dshd-sidebar=${collapsed}`)
await evalJs(`window.__dshd.toggleSidebar()`)
await sleep(800)
const expanded = await evalJs(`document.documentElement.dataset.dshdSidebar`)
check('展开恢复', expanded === '1')

/* 6. 终端：打开 → 输入 echo → 读到输出 */
await evalJs(`window.__dshd.toggleTerm()`)
await sleep(2500)
const termBooted = await evalJs(`!!window.__dshdTerm?.booted`)
check('终端（xterm）已引导', termBooted)
const termOpen = await evalJs(`document.documentElement.dataset.dshdTerm`)
check('终端面板展开', termOpen === '1')

// 输入一行 PowerShell 命令并回车（真实链路：xterm 输入 → IPC → shell stdin → 输出回流）
await evalJs(`window.dshDesktop.termWrite('Write-Output DSH_DASHBOARD_OK\\r')`)
await sleep(3000)
const termText = await evalJs(`document.querySelector('#dshd-term-xterm .xterm-screen')?.innerText || ''`)
check('终端回环输出', termText.includes('DSH_DASHBOARD_OK'), termText.replace(/\n/g, '⏎').slice(-120))

/* 7. 收尾：关终端 */
await evalJs(`window.__dshd.toggleTerm()`)
await sleep(800)

ws.close()
console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
