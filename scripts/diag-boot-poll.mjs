// 浅色模式下轮询 boot 界面颜色（重启 harness 时）
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
const evalJ = async (e) => (await call('Runtime.evaluate', { expression: e, returnByValue: true })).result.value

const probe = `(() => {
  const boot = [...document.querySelectorAll('div')].find((d) => (d.className + '').includes('boot'));
  if (!boot) return { boot: false };
  return {
    boot: true,
    bg: getComputedStyle(boot).backgroundColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    themeAttr: document.documentElement.dataset.theme || null,
    bootVar: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim(),
  };
})()`

await sleep(1500)
console.log('current:', JSON.stringify(await evalJ('location.href.slice(0, 60)')))

import { execFileSync } from 'node:child_process'
try {
  execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--profile desktop*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' })
} catch { /* ignore */ }

let saw = null
const t0 = Date.now()
while (Date.now() - t0 < 5000) {
  await sleep(90)
  try {
    const v = await evalJ(probe)
    if (v && v.boot) {
      saw = v
      console.log('boot at', Date.now() - t0, 'ms:', JSON.stringify(saw))
      break
    }
  } catch { /* navigating */ }
}
if (!saw) console.log('boot not captured')
await sleep(2500)
console.log('final:', JSON.stringify(await evalJ(probe)))
ws.close()
process.exit(0)
