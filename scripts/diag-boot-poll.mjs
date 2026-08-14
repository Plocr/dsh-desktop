// 真实重启流程：轮询 boot 界面（HARNESS / Loading plugins）的背景色，确认非白
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find((t) => t.type === 'page')
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
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
}
await new Promise((r) => (ws.onopen = r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const probe = `(() => {
  const boot = [...document.querySelectorAll('div')].find((d) => (d.className + '').includes('boot'));
  if (!boot) return { boot: false };
  const bg = getComputedStyle(boot).backgroundColor;
  const wm = [...boot.querySelectorAll('div')].find((d) => (d.textContent || '').includes('HARNESS'));
  return { boot: true, bg, wordmark: wm ? getComputedStyle(wm).color : null };
})()`

// 等 harness ready 后 kill，捕捉重启过渡
await sleep(1500)
const before = await call('Runtime.evaluate', { expression: probe, returnByValue: true })
console.log('before kill:', JSON.stringify(before.result.value))

// kill harness（由壳自动重启并显示 boot）
import { execFileSync } from 'node:child_process'
try {
  execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--profile desktop*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' })
} catch { /* ignore */ }

// 轮询 5 秒
let sawBoot = null
const t0 = Date.now()
while (Date.now() - t0 < 5000) {
  await sleep(90)
  const r = await call('Runtime.evaluate', { expression: probe, returnByValue: true }).catch(() => null)
  if (r && r.result && r.result.value && r.result.value.boot) {
    sawBoot = r.result.value
    console.log('boot seen at', Date.now() - t0, 'ms:', JSON.stringify(sawBoot))
    break
  }
}
if (!sawBoot) console.log('boot not captured (restart too fast?)')
// 最终状态
await sleep(2000)
const after = await call('Runtime.evaluate', { expression: probe, returnByValue: true })
console.log('after ready:', JSON.stringify(after.result.value))
ws.close()
process.exit(0)
